import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import Tip from '../components/Tip'
import Icon from '../components/Icon'
import EmptyState from '../components/EmptyState'

function FilterRow({ checked, onChange, label, count }) {
  return (
    <label className="fopt">
      <input type="checkbox" checked={checked} onChange={onChange} />
      <span className="fopt-label">{label}</span>
      {count != null && <span className="cnt">{count}</span>}
    </label>
  )
}

export default function Feed() {
  const nav = useNavigate()
  const [data, setData] = useState(null)        // { items, facets }
  const [sources, setSources] = useState(new Set())  // 选中的来源：'arxiv' / 期刊名
  const [onlyScored, setOnlyScored] = useState(false)
  const [showDismissed, setShowDismissed] = useState(false)
  const [showAdded, setShowAdded] = useState(false)
  const [busy, setBusy] = useState(false)       // arXiv 抓取中
  const [jBusy, setJBusy] = useState(false)     // 期刊抓取中
  const [jobs, setJobs] = useState([])
  const [adding, setAdding] = useState(0)       // 正在入库的条目数（防连点）
  const [summaries, setSummaries] = useState({}) // itemKey -> {loading, text, error}
  // 期刊订阅管理
  const [jAdding, setJAdding] = useState('')
  const [jErr, setJErr] = useState('')
  const [refreshTick, setRefreshTick] = useState(0)

  const load = useCallback(async () => {
    const params = new URLSearchParams({
      limit: '300',
      hide_dismissed: String(!showDismissed),
      hide_added: String(!showAdded),
      min_score: String(onlyScored),
    })
    if (sources.size) params.set('source', [...sources].join(','))
    const d = await api.get(`/feed?${params}`)
    setData(d)
  }, [showDismissed, showAdded, onlyScored, sources])

  useEffect(() => { load() }, [load])

  // 抓取任务轮询：完成后刷新列表
  useEffect(() => {
    const t = setInterval(async () => {
      const d = await api.get('/jobs?limit=5')
      const running = d.items.filter(j => (j.type === 'fetch_feed' || j.type === 'fetch_journal_feed') && j.status !== 'done')
      setJobs(running)
      setJBusy(running.some(j => j.type === 'fetch_journal_feed'))
      setBusy(running.some(j => j.type === 'fetch_feed'))
      const done = d.items.some(j => (j.type === 'fetch_feed' || j.type === 'fetch_journal_feed') && j.status === 'done')
      if (done) setRefreshTick(v => v + 1)
    }, 3000)
    return () => clearInterval(t)
  }, [])
  useEffect(() => { if (refreshTick) load() }, [refreshTick]) // eslint-disable-line

  function toggleSet(key) {
    setSources(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  // 右上角「抓取最新」：同时拉 arXiv 与期刊两条线
  async function fetchNow() {
    setBusy(true)
    setJBusy(true)
    try {
      await Promise.all([api.post('/feed/fetch'), api.post('/journals/fetch')])
    } finally {
      setTimeout(() => { setBusy(false); setJBusy(false) }, 1500)
    }
  }

  async function add(it) {
    setAdding(n => n + 1)
    try {
      const url = it.source === 'arxiv' ? `/feed/${it.id}/add` : `/journals/feed/${it.id}/add`
      const r = await api.post(url)
      if (r.paper_id) nav(`/papers/${r.paper_id}`)
    } finally {
      setAdding(n => n - 1)
    }
  }

  async function dismiss(it) {
    await api.post(`/feed/${it.source}/${it.id}/dismiss`)
    setData(d => ({ ...d, items: d.items.filter(x => !(x.source === it.source && x.id === it.id)) }))
  }

  async function toggleSummary(it) {
    const k = `${it.source}-${it.id}`
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
        item: { title: it.title, abstract: it.abstract },
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
      await load()
      if (!r.duplicate) await api.post('/journals/fetch')
    } catch (e) {
      setJErr(e.message)
    }
  }

  async function removeJournalSub(name) {
    const sub = data?.facets?.sources?.find(([n]) => n === name)
    if (!sub) return
    if (!confirm(`取消订阅「${name}」？已抓取的条目会一并删除。`)) return
    // journal_subs 的删除接口按 id；从 facets 里只拿到名字，先查订阅列表
    const subs = await api.get('/journals')
    const s = subs.items.find(x => x.name === name)
    if (!s) return
    await api.del(`/journals/${s.id}`)
    setSources(prev => {
      const next = new Set(prev)
      next.delete(name)
      return next
    })
    load()
  }

  const items = data?.items
  const facets = data?.facets
  const fetching = busy || jBusy || jobs.length > 0

  return (
    <div className="page-fixed">
      <div className="page-head">
        <h1>
          订阅 {facets && <span className="muted">（{facets.total} 条）</span>}
          <Tip text="arXiv 按设置页的分类+关键词抓取预印本；期刊订阅从 Crossref 追踪正式期刊最新论文。两条线统一按 AI 相关度排序，点「加入文献库」自动入库，点击标题可查看 AI 中文速览。" />
        </h1>
        <div className="row">
          <button className="btn" onClick={() => setShowDismissed(s => !s)}>
            {showDismissed ? '隐藏已忽略' : '显示已忽略'}
          </button>
          <button className="btn" onClick={() => setShowAdded(s => !s)}>
            {showAdded ? '隐藏已入库' : '显示已入库'}
          </button>
          <button className="btn" onClick={() => setOnlyScored(s => !s)}>
            {onlyScored ? '显示全部' : '只看 AI 高分'}
          </button>
          <button className="btn primary" onClick={fetchNow} disabled={fetching}>
            <><Icon name="refresh" /> {fetching ? '抓取中…' : '抓取最新'}</>
          </button>
        </div>
      </div>

      <div className="library-grid">
        <aside className="filter-side">
          <div className="fgroup">
            <div className="fgroup-title">订阅源</div>
            <FilterRow checked={sources.size === 0} onChange={() => setSources(new Set())}
              label="全部来源" count={facets?.total} />
            {(facets?.sources || []).map(([name, n]) => (
              <FilterRow key={name} checked={sources.has(name)}
                onChange={() => toggleSet(name)} count={n}
                label={name === 'arxiv' ? 'arXiv 推荐' : name} />
            ))}
          </div>

          <div className="fgroup">
            <div className="fgroup-title">订阅期刊</div>
            {(facets?.sources || []).filter(([n]) => n !== 'arxiv').map(([name]) => (
              <div key={name} className="fopt" style={{ justifyContent: 'space-between' }}>
                <span className="fopt-label" title={name}>{name}</span>
                <span role="button" style={{ cursor: 'pointer', opacity: 0.6, fontSize: 12 }}
                  title="取消订阅" onClick={() => removeJournalSub(name)}>✕</span>
              </div>
            ))}
            {facets && facets.sources.filter(([n]) => n !== 'arxiv').length === 0 && (
              <div className="muted" style={{ fontSize: 13 }}>还没有订阅期刊。</div>
            )}
            <form style={{ display: 'flex', gap: 6, marginTop: 6 }} onSubmit={e => { e.preventDefault(); addJournalSub() }}>
              <input type="text" style={{ width: '100%', fontSize: 13 }} placeholder="期刊名，如 Hippocampus"
                value={jAdding} onChange={e => setJAdding(e.target.value)} />
              <button className="btn sm primary" disabled={!jAdding.trim()}><Icon name="plus" size={12} /></button>
            </form>
            {jErr && <div className="err-msg" style={{ marginTop: 6 }}>{jErr}</div>}
          </div>

          {(sources.size > 0 || onlyScored || showDismissed || showAdded) && (
            <button type="button" className="fclear" onClick={() => { setSources(new Set()); setOnlyScored(false); setShowDismissed(false); setShowAdded(false) }}>
              清空筛选
            </button>
          )}
        </aside>

        <div className="library-main" style={{ padding: 0 }}>
          <div className="scroll-list">
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
                hint="点右上角「抓取最新」拉取 arXiv 与已订阅期刊的新论文，AI 会按你的研究方向打分排序">
                <button className="btn primary" onClick={fetchNow} disabled={fetching}>
                  <Icon name="refresh" /> 立即抓取
                </button>
              </EmptyState>
            ) : (
              items.map(it => {
                const k = `${it.source}-${it.id}`
                return (
                  <div key={k} className="feed-item" style={it.dismissed ? { opacity: 0.5 } : undefined}>
                    {it.relevance != null && (() => {
                      const sc = Number(it.relevance)
                      const cls = sc >= 8 ? 'high' : sc >= 6 ? 'mid' : 'low'
                      return <span className={`score-badge ${cls}`} title="AI 相关度评分（0-10）">{sc.toFixed(0)}</span>
                    })()}
                    <strong className="feed-title clickable"
                      title="点击查看 AI 中文速览"
                      onClick={() => toggleSummary(it)}>{it.title}</strong>
                    <div className="p-meta">
                      <span className="venue-chip">{it.source === 'arxiv' ? 'arXiv' : it.sub_name}</span>
                      <span>{it.authors?.slice(0, 4).join(', ')}{it.authors?.length > 4 ? ' et al.' : ''}</span>
                      {it.venue && <span>{it.venue}</span>}
                      {it.published && <span className="year-badge">{it.published.slice(0, 10)}</span>}
                    </div>
                    {summaries[k] && (
                      <div className="reason" style={{ marginTop: 6 }}>
                        {summaries[k].loading && <span className="muted">AI 速览生成中…</span>}
                        {summaries[k].text && <><Icon name="zap" size={13} /> {summaries[k].text}</>}
                        {summaries[k].error && <span style={{ color: 'var(--danger)' }}>{summaries[k].error}</span>}
                      </div>
                    )}
                    {it.relevance_reason && <div className="reason"><Icon name="bot" size={13} /> {it.relevance_reason}</div>}
                    <div className="row mt" style={{ marginTop: 10 }}>
                      {it.added_paper_id ? (
                        <button className="btn sm" onClick={() => nav(`/papers/${it.added_paper_id}`)}>已入库 → 查看</button>
                      ) : (
                        <button className="btn sm primary" disabled={adding > 0} onClick={() => add(it)}>
                          <Icon name="plus" size={13} /> {adding > 0 ? '入库中…' : '加入文献库'}
                        </button>
                      )}
                      <a href={it.ext_url} target="_blank" rel="noreferrer">
                        <button className="btn sm">{it.source === 'arxiv' ? 'arXiv 页面' : 'DOI 页面'}</button>
                      </a>
                      {!it.dismissed && <button className="btn sm" onClick={() => dismiss(it)}><Icon name="x" size={13} /> 忽略</button>}
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
