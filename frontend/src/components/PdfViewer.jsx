import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'

// pdf.js worker 配置（vite 下用本地资源）
import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

const COLORS = { yellow: '#facc15', green: '#4ade80', blue: '#60a5fa', red: '#f87171' }
const RENDER_MARGIN = 600 // 视口上下各预渲染 600px

// 文本层视觉顺序修正：检测 DOM 顺序与视觉顺序的错位（水印/边栏文字排在内容流末尾的 PDF），
// 错位明显时按（top, left）重排，使拖选经过行隙时选区吸附到视觉相邻的行而非水印。
function fixVisualOrder(textDiv) {
  const children = [...textDiv.children]
  if (children.length < 10) return
  const items = children.map(c => {
    const r = c.getBoundingClientRect()
    return { c, top: r.top, left: r.left, w: r.width, h: r.height }
  })
  // 乱序检测：视觉 top 相对已扫过的最大值回退超过 30px 记一次（忽略零尺寸的 br 哨兵）
  let prevTop = -1e9
  let disorder = 0
  for (const it of items) {
    if (it.w < 1 && it.h < 1) continue
    if (it.top < prevTop - 30) disorder++
    if (it.top > prevTop) prevTop = it.top
  }
  if (disorder < 5) return
  const sorted = [...items].sort((p, q) => {
    const d = Math.round(p.top) - Math.round(q.top)
    if (Math.abs(d) > 3) return d
    return p.left - q.left
  })
  for (const it of sorted) textDiv.appendChild(it.c)
}

export default function PdfViewer({ paperId, annotations, onAdd, onDelete }) {
  const scrollRef = useRef(null)
  const [doc, setDoc] = useState(null)
  const [numPages, setNumPages] = useState(0)
  const [scale, setScale] = useState(1.2)
  const [currentPage, setCurrentPage] = useState(1)
  const [selected, setSelected] = useState(null) // {page, rects, text}
  const [translating, setTranslating] = useState(false)
  const [translation, setTranslation] = useState(null) // {source, zh}
  const renderTasks = useRef(new Map()) // pageNum -> task
  const renderedPages = useRef(new Map()) // pageNum -> rendered scale key
  const pageRefs = useRef([])
  const abortRef = useRef(null) // 翻译请求取消器
  const [pageDims, setPageDims] = useState(null) // {w, h} 第一页 PDF 单位尺寸

  useEffect(() => {
    let live = true
    setDoc(null); setCurrentPage(1); setSelected(null); setTranslation(null)
    renderedPages.current.clear()
    ;(async () => {
      try {
        const d = await pdfjsLib.getDocument({ url: `/api/papers/${paperId}/pdf` }).promise
        if (!live) return
        const p1 = await d.getPage(1)
        const vp = p1.getViewport({ scale: 1 })
        if (live) { setDoc(d); setNumPages(d.numPages); setPageDims({ w: vp.width, h: vp.height }) }
      } catch (e) {
        console.error('PDF load failed', e)
      }
    })()
    return () => { live = false }
  }, [paperId])

  // 渲染单页：主 canvas + 文本层 + 高亮层
  const renderPage = useCallback(async (pageNum) => {
    const docRef = doc
    if (!docRef || pageNum < 1 || pageNum > docRef.numPages) return
    const wrap = pageRefs.current[pageNum - 1]
    if (!wrap || renderedPages.current.get(pageNum) === scale) return
    renderedPages.current.set(pageNum, scale)

    const pdfPage = await docRef.getPage(pageNum)
    const canvas = wrap.querySelector('canvas.page-canvas')
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const viewport = pdfPage.getViewport({ scale: scale * dpr })
    canvas.width = viewport.width
    canvas.height = viewport.height
    canvas.style.width = `${viewport.width / dpr}px`
    canvas.style.height = `${viewport.height / dpr}px`

    renderTasks.current.get(pageNum)?.cancel()
    const task = pdfPage.render({ canvasContext: canvas.getContext('2d'), viewport })
    renderTasks.current.set(pageNum, task)
    await task.promise.catch(() => {})

    // 文本层（可选中）
    const textDiv = wrap.querySelector('.textLayer')
    if (textDiv) {
      while (textDiv.firstChild) textDiv.removeChild(textDiv.firstChild)
      textDiv.style.setProperty('--scale-factor', String(scale))
      try {
        await new pdfjsLib.TextLayer({
          textContentSource: pdfPage.streamTextContent(),
          container: textDiv,
          viewport: pdfPage.getViewport({ scale }),
        }).render()
        // 视觉顺序修正：NIH/PMC 手稿等 PDF 的边栏水印文字排在内容流末尾，
        // 与视觉顺序不符，拖选经过行隙时选区会吸附到水印上（表现为乱跳）。
        // 检测到明显乱序时，按视觉位置（先上后下、先左后右）重排子节点。
        fixVisualOrder(textDiv)
      } catch (e) {
        console.warn('text layer render failed:', e)
      }
    }

    // 高亮层
    drawPageHighlights(pageNum)
  }, [doc, scale, annotations, selected])

  function drawPageHighlights(pageNum) {
    const wrap = pageRefs.current[pageNum - 1]
    if (!wrap) return
    const hl = wrap.querySelector('.hl-layer')
    if (!hl) return
    const dpr = window.devicePixelRatio || 1
    const s = scale * dpr
    // 高亮层尺寸跟随占位框
    hl.width = wrap.clientWidth * dpr
    hl.height = wrap.clientHeight * dpr
    hl.style.width = `${wrap.clientWidth}px`
    hl.style.height = `${wrap.clientHeight}px`
    const ctx = hl.getContext('2d')
    ctx.clearRect(0, 0, hl.width, hl.height)
    const paint = (rects, color) => {
      ctx.fillStyle = color
      for (const r of rects) ctx.fillRect(r.x * s, r.y * s, r.w * s, r.h * s)
    }
    for (const ann of annotations.filter(a => a.page === pageNum && Array.isArray(a.rects) && a.rects.length)) {
      paint(ann.rects, COLORS[ann.color] + '55')
    }
    if (selected?.page === pageNum) paint(selected.rects, '#3b82f655')
  }

  // 批注 / 选中变化：重画所有已渲染页
  useEffect(() => {
    for (const [pageNum, key] of renderedPages.current) {
      if (key === scale) drawPageHighlights(pageNum)
    }
  }, [annotations, selected, scale])

  // 滚动 → 虚拟化渲染 + 当前页码
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !doc) return
    let raf = null
    function onScroll() {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = null
        const viewTop = el.scrollTop, viewBottom = el.scrollTop + el.clientHeight
        let cur = currentPage
        for (let i = 0; i < pageRefs.current.length; i++) {
          const w = pageRefs.current[i]
          if (!w) continue
          const top = w.offsetTop, bottom = top + w.offsetHeight
          if (bottom >= viewTop + 80 && top <= viewBottom - 80) {
            // 在视口内：确保已渲染
            renderPage(i + 1)
            if (top <= viewTop + el.clientHeight / 2 && bottom >= viewTop + el.clientHeight / 2) cur = i + 1
          } else if (bottom < viewTop - RENDER_MARGIN || top > viewBottom + RENDER_MARGIN) {
            // 远离视口：卸载渲染，保留占位尺寸
            if (renderedPages.current.has(i + 1)) {
              const c = w.querySelector('canvas.page-canvas')
              if (c) { c.width = 0; c.height = 0 }
              const t = w.querySelector('.textLayer')
              if (t) while (t.firstChild) t.removeChild(t.firstChild)
              renderedPages.current.delete(i + 1)
            }
          }
        }
        if (cur !== currentPage) setCurrentPage(cur)
      })
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => { el.removeEventListener('scroll', onScroll); if (raf) cancelAnimationFrame(raf) }
  }, [doc, scale, currentPage, renderPage])

  // 初始渲染第一页
  useEffect(() => {
    if (doc) renderPage(1)
  }, [doc, renderPage])

  function jumpTo(p) {
    const w = pageRefs.current[p - 1]
    if (w && scrollRef.current) scrollRef.current.scrollTo({ top: w.offsetTop - 10 })
  }

  // 划选处理：区分「翻译」与「高亮」两个动作
  function onMouseUp(e) {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !doc) return
    const range = sel.getRangeAt(0)
    const text = sel.toString().trim()
    if (!text || text.length < 2) return
    // 只处理发生在页面内的选区
    const node = range.commonAncestorContainer
    const el = node.nodeType === 3 ? node.parentElement : node
    if (!el?.closest('.textLayer')) { setSelected(null); return }
    const wrap = el.closest('.page-slot')
    const pageNum = Number(wrap?.dataset.page)
    if (!pageNum) return
    const slotRect = wrap.getBoundingClientRect()
    const rects = []
    for (const r of range.getClientRects()) {
      rects.push({
        x: (r.left - slotRect.left) / scale,
        y: (r.top - slotRect.top) / scale,
        w: r.width / scale,
        h: r.height / scale,
      })
    }
    setSelected({ page: pageNum, rects, text })
    // 自动 AI 翻译（弹窗立即可见，翻译完成后填入结果）
    autoTranslate(text)
  }

  // 关闭弹窗：取消进行中的翻译请求并清空所有相关状态
  function dismissPopups() {
    abortRef.current?.abort()
    setTranslating(false)
    setSelected(null)
    setTranslation(null)
    window.getSelection()?.removeAllRanges()
  }

  // 点击翻译/高亮弹窗以外的任意区域（含文字、侧栏）：关闭弹窗、清选区。
  // 开始新拖选也会先关闭，mouseUp 选中新内容后弹窗会带着新选区重新出现。
  useEffect(() => {
    if (!(translating || translation || selected)) return
    const onDocDown = (e) => {
      if (e.target.closest?.('.trans-popup')) return
      dismissPopups()
    }
    document.addEventListener('mousedown', onDocDown)
    return () => document.removeEventListener('mousedown', onDocDown)
  }, [translating, translation, selected])

  async function autoTranslate(text) {
    setTranslating(true)
    setTranslation({ source: text, zh: null })  // 弹窗立即出现
    // 取消上一次未完成的请求
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    try {
      const res = await fetch('/api/ai/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: ctrl.signal,
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`)
      // 用户已划选了新内容：丢弃旧结果
      if (abortRef.current === ctrl) setTranslation({ source: text, zh: data.translation })
    } catch (e) {
      if (e.name === 'AbortError') return
      if (abortRef.current === ctrl) setTranslation({ source: text, zh: null, error: e.message })
    } finally {
      if (abortRef.current === ctrl) setTranslating(false)
    }
  }

  async function saveHighlight(color) {
    if (!selected) return
    await onAdd({ page: selected.page, kind: 'highlight', color, content: selected.text, comment: '', rects: selected.rects })
    dismissPopups()
  }

  if (!doc) return <div className="loading">PDF 加载中…（无 PDF 的文献可在左侧上传）</div>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* 工具条 */}
      <div className="row spread" style={{ padding: '8px 12px', position: 'sticky', top: 0, zIndex: 8, background: 'var(--panel)', borderBottom: '1px solid var(--border)' }}>
        <div className="row">
          <button className="btn sm" disabled={currentPage <= 1} onClick={() => jumpTo(currentPage - 1)}>‹ 上一页</button>
          <span className="muted">{currentPage} / {numPages}</span>
          <button className="btn sm" disabled={currentPage >= numPages} onClick={() => jumpTo(currentPage + 1)}>下一页 ›</button>
        </div>
        <div className="row">
          <button className="btn sm" onClick={() => setScale(s => Math.max(0.5, Math.round((s - 0.2) * 10) / 10))}>－</button>
          <span className="muted">{Math.round(scale * 100)}%</span>
          <button className="btn sm" onClick={() => setScale(s => Math.min(3, Math.round((s + 0.2) * 10) / 10))}>＋</button>
        </div>
      </div>

      {/* 连续滚动区 */}
      <div ref={scrollRef} style={{ flex: 1, overflow: 'auto', padding: '14px 12px', background: '#e9edf2' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, alignItems: 'center' }}>
          {Array.from({ length: numPages }, (_, i) => (
            <div
              key={i}
              data-page={i + 1}
              className="page-slot"
              ref={el => { pageRefs.current[i] = el }}
              onMouseUp={onMouseUp}
              style={{
                position: 'relative', background: '#fff', boxShadow: '0 1px 4px rgba(0,0,0,0.15)',
                width: pageDims ? pageDims.w * scale : undefined,
                height: pageDims ? pageDims.h * scale : undefined,
              }}
            >
              <canvas className="page-canvas" style={{ display: 'block' }} />
              <div className="textLayer" style={{
                position: 'absolute', left: 0, top: 0, zIndex: 2,
                overflow: 'hidden', lineHeight: 1, cursor: 'text',
              }} />
              <canvas className="hl-layer" style={{
                position: 'absolute', left: 0, top: 0, zIndex: 3, pointerEvents: 'none',
              }} />
            </div>
          ))}
        </div>
      </div>

      {/* 翻译浮窗 */}
      {(translating || translation) && (
        <div className="trans-popup" style={{
          position: 'absolute', right: 16, bottom: 16, zIndex: 20, width: 360, maxWidth: '80%',
          background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 10,
          boxShadow: '0 10px 30px rgba(0,0,0,0.2)', padding: 14, fontSize: 14,
        }}>
          <div className="row spread mb8">
            <strong>🤖 AI 翻译 {translating ? '…' : ''}</strong>
            <button className="btn sm" onClick={dismissPopups}>✕</button>
          </div>
        {(translation?.source || selected?.text) && (
          <div className="muted mb8" style={{ maxHeight: 70, overflow: 'auto', fontStyle: 'italic' }}>
            {translation?.source || selected?.text}
          </div>
        )}
        {translating && <div className="muted">翻译中…</div>}
        {translation?.zh && <div style={{ lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{translation.zh}</div>}
        {translation?.error && <div className="err-msg">{translation.error}</div>}
        {selected && (
          <div className="row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
            <span className="muted">高亮：</span>
            {Object.keys(COLORS).map(c => (
              <button key={c} className="btn sm" onClick={() => saveHighlight(c)}>
                <span style={{ color: COLORS[c] }}>■</span>
              </button>
            ))}
          </div>
        )}
        </div>
      )}
    </div>
  )
}
