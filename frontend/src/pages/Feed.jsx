import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import Tip from '../components/Tip'
import Icon from '../components/Icon'
import EmptyState from '../components/EmptyState'

export default function Feed() {
  const nav = useNavigate()
  const [items, setItems] = useState(null)
  const [busy, setBusy] = useState(false)
  const [showDismissed, setShowDismissed] = useState(false)
  const [onlyScored, setOnlyScored] = useState(false)
  const [jobs, setJobs] = useState([])

  const load = useCallback(async () => {
    const d = await api.get(`/feed?limit=200&hide_dismissed=${!showDismissed}`)
    setItems(d.items.filter(it => (onlyScored ? it.relevance != null : true)))
  }, [showDismissed, onlyScored])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    const t = setInterval(async () => {
      const d = await api.get('/jobs?limit=5')
      setJobs(d.items.filter(j => j.type === 'fetch_feed' && j.status !== 'done'))
      if (d.items.some(j => j.type === 'fetch_feed' && j.status === 'done')) load()
    }, 3000)
    return () => clearInterval(t)
  }, [load])

  async function fetchNow() {
    setBusy(true)
    await api.post('/feed/fetch')
    setTimeout(() => { setBusy(false); load() }, 1500)
  }

  async function add(it) {
    const r = await api.post(`/feed/${it.id}/add`)
    if (r.paper_id) nav(`/papers/${r.paper_id}`)
  }

  async function dismiss(it) {
    await api.post(`/feed/${it.id}/dismiss`)
    setItems(prev => prev.filter(x => x.id !== it.id))
  }

  return (
    <div>
      <div className="page-head">
        <h1>
          arXiv 订阅
          <Tip text="按设置页里配置的分类+关键词抓取 arXiv 新论文，AI 按你的研究方向打相关度分（0-10）排序；点「加入文献库」自动下载 PDF 入库。" />
        </h1>
        <div className="row">
          <button className="btn" onClick={() => setShowDismissed(s => !s)}>
            {showDismissed ? '隐藏已忽略' : '显示已忽略'}
          </button>
          <button className="btn" onClick={() => setOnlyScored(s => !s)}>
            {onlyScored ? '显示全部' : '只看 AI 高分'}
          </button>
          <button className="btn primary" onClick={fetchNow} disabled={busy || jobs.length > 0}>
            <><Icon name="refresh" /> {busy || jobs.length > 0 ? '抓取中…' : '抓取最新'}</>
          </button>
        </div>
      </div>

      {!items ? (
        <div>
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="skel-card">
              <div className="skel-line head w60" />
              <div className="skel-line w40" />
              <div className="skel-line w90" />
              <div className="skel-line w60" />
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState icon="rss" title="暂无订阅内容"
          hint="点右上角「抓取最新」拉取 arXiv 新论文，AI 会按你的研究方向打分排序">
          <button className="btn primary" onClick={fetchNow} disabled={busy || jobs.length > 0}>
            <Icon name="refresh" /> 立即抓取
          </button>
        </EmptyState>
      ) : (
        items.map(it => (
          <div key={it.id} className="feed-item" style={it.dismissed ? { opacity: 0.5 } : undefined}>
            {it.relevance != null && (() => {
              const sc = Number(it.relevance)
              const cls = sc >= 8 ? 'high' : sc >= 6 ? 'mid' : 'low'
              return <span className={`score-badge ${cls}`} title="AI 相关度评分（0-10）">{sc.toFixed(0)}</span>
            })()}
            <strong>{it.title}</strong>
            <div className="muted">
              {it.authors?.slice(0, 5).join(', ')}{it.authors?.length > 5 ? ' et al.' : ''}
              {' · '}{it.primary_category}{' · '}{it.arxiv_id}
              {it.published ? ` · ${it.published.slice(0, 10)}` : ''}
            </div>
            <div className="muted" style={{ marginTop: 6 }}>{it.abstract?.slice(0, 220)}{it.abstract?.length > 220 ? '…' : ''}</div>
            {it.relevance_reason && <div className="reason"><Icon name="bot" size={13} /> {it.relevance_reason}</div>}
            <div className="row mt" style={{ marginTop: 10 }}>
              {it.added_paper_id ? (
                <button className="btn sm" onClick={() => nav(`/papers/${it.added_paper_id}`)}>已入库 → 查看</button>
              ) : (
                <button className="btn sm primary" onClick={() => add(it)}><Icon name="plus" /> 加入文献库</button>
              )}
              <a href={`https://arxiv.org/abs/${it.arxiv_id}`} target="_blank" rel="noreferrer">
                <button className="btn sm">arXiv 页面</button>
              </a>
              {!it.dismissed && <button className="btn sm" onClick={() => dismiss(it)}><Icon name="x" size={13} /> 忽略</button>}
            </div>
          </div>
        ))
      )}
    </div>
  )
}
