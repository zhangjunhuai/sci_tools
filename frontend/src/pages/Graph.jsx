import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import Tip from '../components/Tip'
import Icon from '../components/Icon'

const STATUS_COLOR = { unread: '#94a3b8', reading: '#f59e0b', read: '#22c55e' }

// 力导向模拟参数
const REPULSION = 26000   // 节点间斥力
const SPRING = 0.015      // 连线弹簧系数
const REST_LEN = { link: 150, sim: 230 } // 理想边长：双链近、相似远
const CENTER_PULL = 0.012
const DAMPING = 0.86

export default function Graph() {
  const nav = useNavigate()
  const canvasRef = useRef(null)
  const wrapRef = useRef(null)
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [showSim, setShowSim] = useState(true)
  const [hoverId, setHoverId] = useState(null)
  // sim 数据放 ref，避免重渲染打断模拟
  const simRef = useRef({ nodes: [], edges: [], tx: 0, ty: 0, scale: 1, drag: null, panning: false, raf: null })
  const viewRef = useRef({ showSim: true, hoverId: null })

  useEffect(() => {
    setLoading(true)
    api.get('/graph')
      .then(d => { setData(d); initSim(d) })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { viewRef.current.showSim = showSim }, [showSim])
  useEffect(() => { viewRef.current.hoverId = hoverId }, [hoverId])

  function initSim(d) {
    const n = d.nodes.length
    const R = 60 * Math.sqrt(n) + 100
    const nodes = d.nodes.map((p, i) => {
      const a = (2 * Math.PI * i) / Math.max(n, 1)
      return { ...p, x: R * Math.cos(a), y: R * Math.sin(a), vx: 0, vy: 0, r: 7 }
    })
    const byId = Object.fromEntries(nodes.map(nd => [nd.id, nd]))
    const edges = d.edges
      .filter(e => byId[e.source] && byId[e.target])
      .map(e => ({ ...e, a: byId[e.source], b: byId[e.target] }))
    // 度数越高节点越大
    const deg = {}
    for (const e of edges) { deg[e.source] = (deg[e.source] || 0) + 1; deg[e.target] = (deg[e.target] || 0) + 1 }
    for (const nd of nodes) nd.r = 7 + Math.min((deg[nd.id] || 0) * 1.6, 10)
    simRef.current.nodes = nodes
    simRef.current.edges = edges
    startLoop()
  }

  function startLoop() {
    if (simRef.current.raf) return
    const tick = () => {
      const s = simRef.current
      step(s)
      draw(s, viewRef.current)
      s.raf = requestAnimationFrame(tick)
    }
    simRef.current.raf = requestAnimationFrame(tick)
  }

  useEffect(() => {
    return () => { if (simRef.current.raf) cancelAnimationFrame(simRef.current.raf) }
  }, [])

  // ---------- 模拟一步 ----------
  function step(s) {
    const { nodes, edges } = s
    // 斥力（O(n²)，个人库规模足够）
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j]
        let dx = b.x - a.x, dy = b.y - a.y
        let d2 = dx * dx + dy * dy
        if (d2 < 1) { dx = (Math.random() - 0.5); dy = (Math.random() - 0.5); d2 = 1 }
        const d = Math.sqrt(d2)
        const f = REPULSION / d2
        const fx = (dx / d) * f, fy = (dy / d) * f
        a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy
      }
    }
    // 弹簧
    for (const e of edges) {
      const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y
      const d = Math.sqrt(dx * dx + dy * dy) || 1
      const rest = REST_LEN[e.kind] || 200
      const f = SPRING * (d - rest)
      const fx = (dx / d) * f, fy = (dy / d) * f
      e.a.vx += fx; e.a.vy += fy; e.b.vx -= fx; e.b.vy -= fy
    }
    // 中心引力 + 阻尼 + 积分
    for (const nd of nodes) {
      nd.vx += -nd.x * CENTER_PULL; nd.vy += -nd.y * CENTER_PULL
      nd.vx *= DAMPING; nd.vy *= DAMPING
      nd.x += Math.max(-12, Math.min(12, nd.vx))
      nd.y += Math.max(-12, Math.min(12, nd.vy))
    }
  }

  // ---------- 绘制 ----------
  function draw(s, view) {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    const dpr = window.devicePixelRatio || 1
    const W = wrap.clientWidth, H = wrap.clientHeight
    if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
      canvas.width = W * dpr; canvas.height = H * dpr
      canvas.style.width = `${W}px`; canvas.style.height = `${H}px`
    }
    const ctx = canvas.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)
    const dark = document.documentElement.dataset.theme === 'dark'
    // 极淡点阵网格（氛围层）
    ctx.fillStyle = dark ? 'rgba(148,163,184,0.14)' : 'rgba(100,116,139,0.16)'
    const gap = 26
    for (let gx = gap / 2; gx < W; gx += gap) {
      for (let gy = gap / 2; gy < H; gy += gap) {
        ctx.fillRect(gx, gy, 1.4, 1.4)
      }
    }
    const { nodes, edges, tx, ty, scale } = s
    const cx = W / 2 + tx, cy = H / 2 + ty

    // 边
    for (const e of edges) {
      if (e.kind === 'sim' && !view.showSim) continue
      ctx.strokeStyle = e.kind === 'link' ? 'rgba(37,99,235,0.55)' : 'rgba(148,163,184,0.28)'
      ctx.lineWidth = e.kind === 'link' ? 1.8 : 1
      ctx.beginPath()
      ctx.moveTo(cx + e.a.x * scale, cy + e.a.y * scale)
      ctx.lineTo(cx + e.b.x * scale, cy + e.b.y * scale)
      ctx.stroke()
    }
    // 节点
    for (const nd of nodes) {
      const x = cx + nd.x * scale, y = cy + nd.y * scale, r = nd.r * Math.sqrt(scale)
      const hovered = view.hoverId === nd.id
      ctx.beginPath()
      ctx.arc(x, y, r + (hovered ? 2 : 0), 0, Math.PI * 2)
      ctx.fillStyle = STATUS_COLOR[nd.status] || '#94a3b8'
      ctx.fill()
      if (nd.starred) {
        ctx.strokeStyle = '#f59e0b'; ctx.lineWidth = 2; ctx.stroke()
      }
      if (hovered || scale > 1.4) {
        ctx.font = '12px system-ui, sans-serif'
        ctx.fillStyle = dark ? '#a8b3c2' : '#334155'
        const t = nd.title.length > 28 ? nd.title.slice(0, 28) + '…' : nd.title
        ctx.fillText(t, x + r + 4, y + 4)
      }
    }
  }

  // ---------- 交互 ----------
  function pick(e) {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    const px = e.clientX - rect.left, py = e.clientY - rect.top
    const s = simRef.current
    const cx = canvas.clientWidth / 2 + s.tx, cy = canvas.clientHeight / 2 + s.ty
    let best = null, bestD = 1e9
    for (const nd of s.nodes) {
      const x = cx + nd.x * s.scale, y = cy + nd.y * s.scale
      const d = Math.hypot(px - x, py - y)
      if (d < nd.r * Math.sqrt(s.scale) + 6 && d < bestD) { best = nd; bestD = d }
    }
    return best
  }

  function onMouseDown(e) {
    const nd = pick(e)
    if (nd) { simRef.current.drag = nd; setHoverId(nd.id) }
    else { simRef.current.panning = { x: e.clientX, y: e.clientY, tx: simRef.current.tx, ty: simRef.current.ty } }
  }
  function onMouseMove(e) {
    const s = simRef.current
    if (s.drag) {
      const canvas = canvasRef.current
      const rect = canvas.getBoundingClientRect()
      const cx = rect.width / 2 + s.tx, cy = rect.height / 2 + s.ty
      s.drag.x = (e.clientX - rect.left - cx) / s.scale
      s.drag.y = (e.clientY - rect.top - cy) / s.scale
      s.drag.vx = 0; s.drag.vy = 0
    } else if (s.panning) {
      s.tx = s.panning.tx + (e.clientX - s.panning.x)
      s.ty = s.panning.ty + (e.clientY - s.panning.y)
    } else {
      const nd = pick(e)
      if ((nd?.id) !== hoverId) setHoverId(nd?.id ?? null)
    }
  }
  function onMouseUp() { simRef.current.drag = null; simRef.current.panning = false }
  function onClick(e) {
    // 拖动过的节点不算点击
    if (simRef.current.dragMoved) { simRef.current.dragMoved = false; return }
    const nd = pick(e)
    if (nd) nav(`/papers/${nd.id}`)
  }
  function onWheel(e) {
    e.preventDefault()
    const s = simRef.current
    s.scale = Math.min(3, Math.max(0.3, s.scale * (e.deltaY < 0 ? 1.1 : 0.9)))
  }

  const nodes = data?.nodes || []
  const edges = data?.edges || []
  const linkCount = edges.filter(e => e.kind === 'link').length
  const simCount = edges.length - linkCount

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 90px)' }}>
      <div className="page-head">
        <h1>知识图谱 <span className="muted">（{nodes.length} 篇 · 双链 {linkCount} · 相似 {simCount}）</span>
          <Tip text="节点为库内文献，颜色代表阅读状态（灰=未读、橙=在读、绿=已读，金圈=星标）。蓝线是笔记 [[双链]]，灰线是 AI 标签重合度自动连线。拖动节点、滚轮缩放、点击进入详情。" />
        </h1>
        <div className="row">
          <label className="row" style={{ fontSize: 13.5, cursor: 'pointer', gap: 5 }}>
            <input type="checkbox" checked={showSim} onChange={e => setShowSim(e.target.checked)} />
            显示相似连线
          </label>
          <button className="btn" disabled={loading} onClick={() => { setLoading(true); api.get('/graph').then(d => { setData(d); initSim(d) }).catch(e => setError(e.message)).finally(() => setLoading(false)) }}>
            重新计算
          </button>
        </div>
      </div>

      {error && <div className="err-msg">{error}</div>}
      {loading && <div className="loading">计算图谱中…</div>}
      {!loading && nodes.length === 0 && (
          <div className="empty-state" style={{ paddingTop: 80 }}>
            <div className="empty-ico"><Icon name="network" size={30} /></div>
            <div className="empty-title">文献库还是空的</div>
            <div className="muted" style={{ fontSize: 13.5 }}>入库几篇文献后再来生成图谱</div>
          </div>
        )}

      <div ref={wrapRef} style={{ flex: 1, position: 'relative', border: '1px solid var(--border)', borderRadius: 'var(--radius)', background: 'var(--panel)', overflow: 'hidden' }}>
        <canvas
          ref={canvasRef}
          style={{ cursor: hoverId ? 'pointer' : 'grab', display: 'block' }}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={onMouseUp}
          onClick={onClick}
          onWheel={onWheel}
        />
        <div className="graph-legend">
          <span><span className="dot" style={{ background: '#94a3b8' }} />未读</span>
          <span><span className="dot" style={{ background: '#f59e0b' }} />在读</span>
          <span><span className="dot" style={{ background: '#22c55e' }} />已读</span>
          <span><span className="dot" style={{ background: '#2563eb', borderRadius: 2, height: 2, marginTop: 5 }} />双链</span>
          <span><span className="dot" style={{ background: '#94a3b8', borderRadius: 2, height: 2, marginTop: 5 }} />相似</span>
          <span>★ 星标</span>
        </div>
      </div>
    </div>
  )
}
