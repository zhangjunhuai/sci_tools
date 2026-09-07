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
  const [summaries, setSummaries] = useState({}) // feedId -> {loading, text, error}
  const [tab, setTab] = useState('arxiv') // arxiv | journal
  const [jSubs, setJSubs] = useState(null)
  const [jItems, setJItems] = useState(null)
  const [jBusy, setJBusy] = useState(false)
  const [jAdding, setJAdding] = useState('')
  const [jErr, setJErr] = useState('')
  const [jOnlyScored, setJOnlyScored] = useState(false)

  const load = useCallback(async () => {
    const d = await api.get(`/feed?limit=200&hide_dismissed=${!showDismissed}`)
    setItems(d.items.filter(it => (onlyScored ? it.relevance != null : true)))
  }, [showDismissed, onlyScored])

  const loadJournals = useCallback(async () => {
    try {
      const [s, f] = await Promise.all([
        api.get('/journals'),
        api.get(`/journals/feed?hide_dismissed=true${jOnlyScored ? '&min_score=7' : ''}`),
      ])
      setJSubs(s.items)
      setJItems(f.items)
      setJErr('')
    } catch (e) {
      setJErr(e.message)
    }
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => { if (tab === 'journal') loadJournals() }, [tab, loadJournals, jOnlyScored])

  useEffect(() => {
    const t = setInterval(async () => {
      const d = await api.get('/jobs?limit=5')
      const running = d.items.filter(j => (j.type === 'fetch_feed' || j.type === 'fetch_journal_feed') && j.status !== 'done')
      setJobs(running)
      setJBusy(running.some(j => j.type === 'fetch_journal_feed'))
      if (d.items.some(j => j.type === 'fetch_feed' && j.status === 'done')) load()
      if (d.items.some(j => j.type === 'fetch_journal_feed' && j.status === 'done')) loadJournals()
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

  async function toggleSummary(it, key = it.id, src = it) {
    const k = key
    if (summaries[k]?.text || summaries[k]?.loading) {
      setSummaries(prev => {
        const next = { ...prev }
        delete next[k]
        return next
      })
      return
    }
    setSummaries(prev => ({ ...prev, [k]: { loading: true } }))
    try {
      const r = await api.post('/citations/quick_summary', {
        item: { title: src.title, abstract: src.abstract },
      })
      setSummaries(prev => ({ ...prev, [k]: { text: r.summary } }))
    } catch (e) {
      setSummaries(prev => ({ ...prev, [k]: { error: e.message } }))
    }
  }

  async function addJournalSub() {
    const q = jAdding.trim()
    if (!q) return
    setJErr('')
    try {
      const r = await api.post('/journals', { query: q })
      setJAdding('')
      await loadJournals()
      if (!r.duplicate) {
        await api.post('/journals/fetch')
      }
    } catch (e) {
      setJErr(e.message)
    }
  }

  async function removeJournalSub(id) {
    if (!confirm('取消订阅该期刊？已抓取的条目会一并删除。')) return
    await api.del(`/journals/${id}`)
    loadJournals()
  }

  async function fetchJournals() {
    await api.post('/journals/fetch')
    setTimeout(() => loadJournals(), 3000)
  }

  async function addJournalItem(it) {
    const r = await api.post(`/journals/feed/${it.id}/add`)
    loadJournals()
    if (r.paper_id) nav(`/papers/${r.paper_id}`)
  }

  async function dismissJournal(it) {
    await api.post(`/journals/feed/${it.id}/dismiss`)
    setJItems(prev => prev.filter(x => x.id !== it.id))
  }

  async function dismiss(it) {
    await api.post(`/feed/${it.id}/dismiss`)
    setItems(prev => prev.filter(x => x.id !== it.id))
  }

  return (
    <div>
      <div className="page-head">
        <h1>
          订阅
          <Tip text="两条订阅线：「arXiv 推荐」按设置页的分类+关键词抓取预印本并打相关度分；「期刊订阅」从 Crossref 追踪正式期刊的最新论文。点「加入文献库」自动入库，点击标题可查看 AI 中文速览。" />
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

      <div className="row mb16" style={{ gap: 6 }}>
        <button className={`chip ${tab === 'arxiv' ? 'active' : ''}`} onClick={() => setTab('arxiv')}>
          arXiv 推荐
        </button>
        <button className={`chip ${tab === 'journal' ? 'active' : ''}`} onClick={() => setTab('journal')}>
          期刊订阅
        </button>
      </div>

      {tab === 'arxiv' && (!items ? (
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
            <strong className="feed-title clickable"
              title="点击查看 AI 中文速览"
              onClick={() => toggleSummary(it)}>{it.title}</strong>
            <div className="muted">
              {it.authors?.slice(0, 5).join(', ')}{it.authors?.length > 5 ? ' et al.' : ''}
              {' · '}{it.primary_category}{' · '}{it.arxiv_id}
              {it.published ? ` · ${it.published.slice(0, 10)}` : ''}
            </div>
            {summaries[it.id] && (
              <div className="reason" style={{ marginTop: 6 }}>
                {summaries[it.id].loading && <span className="muted">AI 速览生成中…</span>}
                {summaries[it.id].text && <><Icon name="zap" size={13} /> {summaries[it.id].text}</>}
                {summaries[it.id].error && <span style={{ color: 'var(--danger)' }}>{summaries[it.id].error}</span>}
              </div>
            )}
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
      ))}

      {tab === 'journal' && (
        <div>
          <div className="card mb16">
            <div className="row spread mb8">
              <strong className="row" style={{ gap: 5 }}>
                已订阅期刊（{jSubs ? jSubs.length : 0}）
                <Tip text="输入期刊名称，从 Crossref 数据库匹配；每次抓取自动拉取该期刊最新论文，点「加入文献库」走 DOI 入库管道（自动尝试 OA PDF + AI 标签）。" />
              </strong>
              <button className="btn sm" onClick={() => setJOnlyScored(v => !v)}>
                {jOnlyScored ? '显示全部' : '只看高分'}
              </button>
              <button className="btn sm" disabled={jBusy} onClick={fetchJournals}>
                <Icon name="refresh" size={13} /> {jBusy ? '抓取中…' : '抓取最新'}
              </button>
            </div>
            <div className="row mb8" style={{ flexWrap: 'wrap' }}>
              {(jSubs || []).map(sub => (
                <span key={sub.id} className="tag accent" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  {sub.name}
                  <span role="button" style={{ cursor: 'pointer', opacity: 0.7 }}
                    title="取消订阅" onClick={() => removeJournalSub(sub.id)}>✕</span>
                </span>
              ))}
              {jSubs && jSubs.length === 0 && <span className="muted">还没有订阅，在下方输入期刊名称添加。</span>}
            </div>
            <form className="row" onSubmit={e => { e.preventDefault(); addJournalSub() }}>
              <input type="text" className="flex1" placeholder="输入期刊名称，如：Hippocampus / Nature Neuroscience"
                value={jAdding} onChange={e => setJAdding(e.target.value)} />
              <button className="btn primary" disabled={!jAdding.trim()}>
                <Icon name="plus" size={13} /> 订阅
              </button>
            </form>
            {jErr && <div className="err-msg" style={{ marginTop: 8 }}>{jErr}</div>}
          </div>

          {!jItems ? (
            <div>
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="skel-card">
                  <div className="skel-line head w60" />
                  <div className="skel-line w40" />
                  <div className="skel-line w90" />
                </div>
              ))}
            </div>
          ) : jItems.length === 0 ? (
            <EmptyState icon="flask" title="还没有期刊论文"
              hint="订阅期刊后点「抓取最新」，新论文会出现在这里" />
          ) : (
            jItems.map(it => (
              <div key={`j-${it.id}`} className="feed-item">
                {it.relevance != null && (() => {
                  const sc = Number(it.relevance)
                  const cls = sc >= 8 ? 'high' : sc >= 6 ? 'mid' : 'low'
                  return <span className={`score-badge ${cls}`} title="AI 相关度评分（0-10）">{sc.toFixed(0)}</span>
                })()}
                <strong className="feed-title clickable" title="点击查看 AI 中文速览"
                  onClick={() => toggleSummary(it, `j-${it.id}`, it)}>{it.title}</strong>
                <div className="p-meta">
                  <span className="venue-chip">{it.sub_name}</span>
                  <span>{it.authors?.slice(0, 4).join(', ')}{it.authors?.length > 4 ? ' et al.' : ''}</span>
                  {it.published && <span className="year-badge">{it.published.slice(0, 10)}</span>}
                </div>
                {it.relevance_reason && <div className="reason"><Icon name="bot" size={13} /> {it.relevance_reason}</div>}
                {summaries[`j-${it.id}`] && (
                  <div className="reason" style={{ marginTop: 6 }}>
                    {summaries[`j-${it.id}`].loading && <span className="muted">AI 速览生成中…</span>}
                    {summaries[`j-${it.id}`].text && <><Icon name="zap" size={13} /> {summaries[`j-${it.id}`].text}</>}
                    {summaries[`j-${it.id}`].error && <span style={{ color: 'var(--danger)' }}>{summaries[`j-${it.id}`].error}</span>}
                  </div>
                )}
                <div className="row mt" style={{ marginTop: 10 }}>
                  {it.added_paper_id ? (
                    <button className="btn sm" onClick={() => nav(`/papers/${it.added_paper_id}`)}>已入库 → 查看</button>
                  ) : (
                    <button className="btn sm primary" onClick={() => addJournalItem(it)}>
                      <Icon name="plus" size={13} /> 加入文献库
                    </button>
                  )}
                  <a href={`https://doi.org/${it.doi}`} target="_blank" rel="noreferrer">
                    <button className="btn sm">DOI 页面</button>
                  </a>
                  {!it.dismissed && <button className="btn sm" onClick={() => dismissJournal(it)}><Icon name="x" size={13} /> 忽略</button>}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
