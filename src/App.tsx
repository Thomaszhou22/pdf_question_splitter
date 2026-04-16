import { useState, useRef, useCallback } from 'react'
import { FileUp, Download, Scissors, RotateCcw, Loader2 } from 'lucide-react'
import * as pdfjsLib from 'pdfjs-dist'
import { jsPDF } from 'jspdf'

// PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`

type Lang = 'en' | 'zh'

const t = (lang: Lang) => ({
  title: lang === 'zh' ? 'PDF 试题拆分器' : 'PDF Question Splitter',
  subtitle: lang === 'zh' ? '按分隔线自动拆分试题，每题一页' : 'Auto-split questions by separator lines, one per page',
  uploadHint: lang === 'zh' ? '拖拽 PDF 到此处，或点击选择文件' : 'Drag & drop a PDF here, or click to browse',
  processing: lang === 'zh' ? '正在处理...' : 'Processing...',
  pageProgress: lang === 'zh' ? '正在分析第 {n}/{total} 页...' : 'Analyzing page {n}/{total}...',
  foundQuestions: lang === 'zh' ? '共识别到 {n} 道题目' : 'Found {n} questions',
  download: lang === 'zh' ? '下载拆分后的 PDF' : 'Download Split PDF',
  reset: lang === 'zh' ? '重新上传' : 'Upload Another',
  pageLabel: lang === 'zh' ? '页' : 'page',
  noLinesFound: lang === 'zh' ? '未检测到分隔线，尝试调整灵敏度' : 'No separator lines detected, try adjusting sensitivity',
  sensitivity: lang === 'zh' ? '检测灵敏度' : 'Sensitivity',
  previewHint: lang === 'zh' ? '预览拆分结果' : 'Preview split result',
  processingDone: lang === 'zh' ? '处理完成' : 'Done',
})

// Detect horizontal separator lines in an image
function detectSeparatorLines(
  imageData: ImageData,
  sensitivity: number = 70
): number[] {
  const { width, height, data } = imageData
  const lines: number[] = []

  for (let y = 0; y < height; y++) {
    let darkCount = 0
    const rowOffset = y * width * 4

    for (let x = 0; x < width; x++) {
      const idx = rowOffset + x * 4
      const r = data[idx]
      const g = data[idx + 1]
      const b = data[idx + 2]
      const brightness = (r + g + b) / 3
      if (brightness < sensitivity) {
        darkCount++
      }
    }

    // If dark pixels span at least 60% of the row width
    if (darkCount > width * 0.6) {
      lines.push(y)
    }
  }

  // Group consecutive lines and return midpoints
  const groups: number[][] = []
  let currentGroup: number[] = []

  for (let i = 0; i < lines.length; i++) {
    if (i === 0 || lines[i] - lines[i - 1] <= 3) {
      currentGroup.push(lines[i])
    } else {
      groups.push(currentGroup)
      currentGroup = [lines[i]]
    }
  }
  if (currentGroup.length > 0) groups.push(currentGroup)

  // Filter out very short groups (< 5px, likely noise) and very long groups (likely borders)
  return groups
    .filter(g => g.length >= 2 && g.length <= 30)
    .map(g => Math.round(g[Math.floor(g.length / 2)]))
}

export default function App() {
  const [lang, setLang] = useState<Lang>('en')
  const [file, setFile] = useState<File | null>(null)
  const [processing, setProcessing] = useState(false)
  const [progress, setProgress] = useState('')
  const [questionImages, setQuestionImages] = useState<string[]>([])
  const [previewIndex, setPreviewIndex] = useState(0)
  const [sensitivity, setSensitivity] = useState(70)
  const [noLinesWarning, setNoLinesWarning] = useState(false)
  const [done, setDone] = useState(false)
  const resultPdfRef = useRef<Blob | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const strings = t(lang)

  const processPDF = useCallback(async (pdfFile: File, sens: number) => {
    setProcessing(true)
    setProgress('')
    setQuestionImages([])
    setNoLinesWarning(false)
    setDone(false)

    try {
      const arrayBuffer = await pdfFile.arrayBuffer()
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise
      const totalPages = pdf.numPages

      const segmentDataUrls: string[] = []
      const baseScale = 2

      for (let i = 1; i <= totalPages; i++) {
        setProgress(strings.pageProgress.replace('{n}', String(i)).replace('{total}', String(totalPages)))

        const page = await pdf.getPage(i)
        const testViewport = page.getViewport({ scale: baseScale })
        // Limit canvas to ~16MP to prevent OOM on large pages
        const maxDim = 4000
        const scale = Math.min(baseScale, maxDim / testViewport.width, maxDim / testViewport.height)
        const viewport = page.getViewport({ scale })
        const canvas = document.createElement('canvas')
        canvas.width = viewport.width
        canvas.height = viewport.height
        const ctx = canvas.getContext('2d')!

        await page.render({ canvasContext: ctx, viewport, canvas }).promise

        // Verify canvas is not blank (all white/transparent)
        const renderedData = ctx.getImageData(0, 0, canvas.width, canvas.height).data
        let hasContent = false
        for (let k = 3; k < renderedData.length; k += 4) {
          if (renderedData[k] > 0) { hasContent = true; break }
        }
        if (!hasContent) {
          console.warn(`Page ${i} rendered blank, retrying with scale 1.5`)
          // Retry with lower scale to save memory
          const retryViewport = page.getViewport({ scale: 1.5 })
          canvas.width = retryViewport.width
          canvas.height = retryViewport.height
          await page.render({ canvasContext: ctx, viewport: retryViewport, canvas }).promise
        }

        // Detect separator lines
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
        const linePositions = detectSeparatorLines(imageData, sens)

        // Extract text to find question numbers for validation
        const textContent = await page.getTextContent()
        const questionNumberYs: number[] = []
        const qNumPattern = /^\s*(\d+)\s*$/
        for (const item of textContent.items) {
          const text = (item as any).str?.trim()
          if (!text) continue
          if (qNumPattern.test(text)) {
            const y = (item as any).transform[5]
            questionNumberYs.push(y * scale)
          }
        }

        // Determine split points
        const splitYs: number[] = [0]
        if (linePositions.length === 0) {
          splitYs.push(canvas.height)
        } else {
          const validatedLines = linePositions.filter(lineY =>
            questionNumberYs.some(numY => lineY - numY > -10 && lineY - numY < 100)
          )
          const finalLines = validatedLines.length > 0 ? validatedLines : linePositions
          splitYs.push(...finalLines, canvas.height)
        }

        // Create segment images and immediately release
        for (let j = 0; j < splitYs.length - 1; j++) {
          const startY = splitYs[j]
          const segHeight = splitYs[j + 1] - startY
          if (segHeight < 50) continue

          const segCanvas = document.createElement('canvas')
          segCanvas.width = canvas.width
          segCanvas.height = segHeight
          const segCtx = segCanvas.getContext('2d')!
          segCtx.drawImage(canvas, 0, startY, canvas.width, segHeight, 0, 0, canvas.width, segHeight)
          segmentDataUrls.push(segCanvas.toDataURL('image/jpeg', 0.92))
          segCanvas.width = 0; segCanvas.height = 0 // release memory
        }

        // Release full page canvas
        canvas.width = 0; canvas.height = 0
        page.cleanup()

        // Yield to UI every 5 pages
        if (i % 5 === 0) await new Promise(r => setTimeout(r, 0))
      }

      pdf.destroy()

      if (segmentDataUrls.length === 0) {
        setNoLinesWarning(true)
        setProcessing(false)
        return
      }

      setQuestionImages(segmentDataUrls)
      setPreviewIndex(0)

      // Generate output PDF
      setProgress(lang === 'zh' ? '正在生成 PDF...' : 'Generating PDF...')
      const firstImg = new Image()
      firstImg.src = segmentDataUrls[0]
      await new Promise(r => { firstImg.onload = r })

      const outputPdf = new jsPDF({
        orientation: firstImg.width > firstImg.height ? 'landscape' : 'portrait',
        unit: 'px',
        format: [firstImg.width, firstImg.height],
      })

      for (let idx = 0; idx < segmentDataUrls.length; idx++) {
        if (idx > 0) {
          const img = new Image()
          img.src = segmentDataUrls[idx]
          await new Promise(r => { img.onload = r })
          outputPdf.addPage([img.width, img.height], img.width > img.height ? 'landscape' : 'portrait')
          outputPdf.addImage(segmentDataUrls[idx], 'JPEG', 0, 0, img.width, img.height)
        } else {
          outputPdf.addImage(segmentDataUrls[idx], 'JPEG', 0, 0, firstImg.width, firstImg.height)
        }
        // Yield every 20 segments
        if (idx % 20 === 0) await new Promise(r => setTimeout(r, 0))
      }

      resultPdfRef.current = outputPdf.output('blob')
      setDone(true)
    } catch (err) {
      console.error('PDF processing failed:', err)
      alert(lang === 'zh' ? 'PDF 处理失败，请重试' : 'PDF processing failed, please retry')
    } finally {
      setProcessing(false)
      setProgress('')
    }
  }, [lang, strings])

  const handleFile = useCallback((f: File) => {
    if (f.type !== 'application/pdf') {
      alert(lang === 'zh' ? '请上传 PDF 文件' : 'Please upload a PDF file')
      return
    }
    setFile(f)
    processPDF(f, sensitivity)
  }, [processPDF, lang, sensitivity])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const f = e.dataTransfer.files[0]
    if (f) handleFile(f)
  }, [handleFile])

  const handleDownload = useCallback(() => {
    if (!resultPdfRef.current) return
    const url = URL.createObjectURL(resultPdfRef.current)
    const a = document.createElement('a')
    a.href = url
    const baseName = file?.name.replace(/\.pdf$/i, '') || 'split'
    a.download = `${baseName}_split.pdf`
    a.click()
    URL.revokeObjectURL(url)
  }, [file])

  const handleReset = useCallback(() => {
    setFile(null)
    setQuestionImages([])
    setDone(false)
    setNoLinesWarning(false)
    resultPdfRef.current = null
    fileInputRef.current!.value = ''
  }, [])

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white">
      {/* Header */}
      <header className="sticky top-0 z-50 border-b border-slate-200/80 bg-white/80 backdrop-blur-md shadow-sm">
        <div className="max-w-3xl mx-auto flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="rounded-xl bg-gradient-to-br from-blue-600 to-indigo-600 text-white shadow-md w-9 h-9 flex items-center justify-center">
              <Scissors className="h-5 w-5" strokeWidth={2} />
            </div>
            <h1 className="text-lg font-bold tracking-tight text-slate-900">{strings.title}</h1>
          </div>
          <div className="rounded-lg border border-slate-200/90 bg-slate-50/90 p-0.5 shadow-sm flex items-center">
            <button
              onClick={() => setLang('en')}
              className={`px-3 py-1.5 text-sm font-semibold rounded-md transition-all ${lang === 'en' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
            >EN</button>
            <button
              onClick={() => setLang('zh')}
              className={`px-3 py-1.5 text-sm font-semibold rounded-md transition-all ${lang === 'zh' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
            >中文</button>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-12">
        {/* Upload area */}
        {!file && (
          <>
            <div className="text-center mb-8">
              <h2 className="text-3xl font-bold tracking-tight text-slate-900">{strings.title}</h2>
              <p className="mt-3 text-slate-600">{strings.subtitle}</p>
            </div>

            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className="border-2 border-dashed border-slate-300 rounded-2xl bg-white/70 p-16 text-center cursor-pointer hover:border-blue-400 hover:bg-white/90 transition-all shadow-lg hover:shadow-xl group"
            >
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-blue-50 to-indigo-50 text-blue-600 mb-4 group-hover:scale-105 transition-transform">
                <FileUp className="h-8 w-8" strokeWidth={1.5} />
              </div>
              <p className="text-lg font-medium text-slate-700">{strings.uploadHint}</p>
              <p className="mt-2 text-sm text-slate-400">PDF</p>
            </div>

            <input ref={fileInputRef} type="file" accept=".pdf" className="hidden" onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) handleFile(f)
            }} />

            {/* Sensitivity control */}
            <div className="mt-6 flex items-center justify-center gap-4">
              <label className="text-sm font-medium text-slate-600">{strings.sensitivity}: {sensitivity}</label>
              <input
                type="range" min={30} max={150} value={sensitivity}
                onChange={(e) => setSensitivity(Number(e.target.value))}
                className="w-48 accent-blue-600"
              />
            </div>
          </>
        )}

        {/* Processing */}
        {processing && (
          <div className="flex flex-col items-center py-20">
            <Loader2 className="h-10 w-10 text-blue-600 animate-spin mb-4" />
            <p className="text-lg font-semibold text-slate-700">{strings.processing}</p>
            {progress && <p className="mt-2 text-sm text-slate-500">{progress}</p>}
          </div>
        )}

        {/* Results */}
        {done && questionImages.length > 0 && (
          <>
            <div className="flex items-center justify-between mb-6">
              <p className="text-lg font-semibold text-slate-900">
                {strings.foundQuestions.replace('{n}', String(questionImages.length))}
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => { processPDF(file!, sensitivity) }}
                  className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 transition shadow-sm"
                >
                  <RotateCcw className="h-4 w-4" /> {strings.reset}
                </button>
                <button
                  onClick={handleDownload}
                  className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 transition"
                >
                  <Download className="h-4 w-4" /> {strings.download}
                </button>
              </div>
            </div>

            {/* Preview navigation */}
            <div className="flex items-center justify-center gap-3 mb-4">
              <button
                disabled={previewIndex <= 0}
                onClick={() => setPreviewIndex(previewIndex - 1)}
                className="px-4 py-2 rounded-lg bg-white border border-slate-200 text-sm font-medium text-slate-700 disabled:opacity-40 hover:bg-slate-50 transition"
              >← {lang === 'zh' ? '上一题' : 'Prev'}</button>
              <span className="text-sm text-slate-600 font-medium">
                {previewIndex + 1} / {questionImages.length}
              </span>
              <button
                disabled={previewIndex >= questionImages.length - 1}
                onClick={() => setPreviewIndex(previewIndex + 1)}
                className="px-4 py-2 rounded-lg bg-white border border-slate-200 text-sm font-medium text-slate-700 disabled:opacity-40 hover:bg-slate-50 transition"
              >{lang === 'zh' ? '下一题' : 'Next'} →</button>
            </div>

            {/* Preview */}
            <div className="border border-slate-200 rounded-2xl bg-white p-4 shadow-sm">
              <p className="text-xs text-slate-400 mb-2">{strings.previewHint} — Q{previewIndex + 1}</p>
              <img
                src={questionImages[previewIndex]}
                alt={`Question ${previewIndex + 1}`}
                className="w-full rounded-lg"
              />
            </div>

            {/* Quick navigation dots */}
            <div className="mt-6 flex flex-wrap gap-2 justify-center">
              {questionImages.map((_, i) => (
                <button
                  key={i}
                  onClick={() => setPreviewIndex(i)}
                  className={`w-9 h-9 rounded-lg text-xs font-semibold transition-all ${i === previewIndex ? 'bg-blue-600 text-white shadow-md shadow-blue-600/25' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
                >{i + 1}</button>
              ))}
            </div>
          </>
        )}

        {/* No lines warning */}
        {noLinesWarning && (
          <div className="text-center py-20">
            <p className="text-slate-600">{strings.noLinesFound}</p>
            <button
              onClick={handleReset}
              className="mt-4 inline-flex items-center gap-2 rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 transition"
            >
              <RotateCcw className="h-4 w-4" /> {strings.reset}
            </button>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-200 bg-slate-50 mt-16">
        <div className="max-w-3xl mx-auto px-4 py-8 text-center text-xs text-slate-500">
          {lang === 'zh'
            ? '所有处理在浏览器本地完成，PDF 不会上传到任何服务器'
            : 'All processing happens locally in your browser. Your PDFs are never uploaded to any server.'}
        </div>
      </footer>
    </div>
  )
}
