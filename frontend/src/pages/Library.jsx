import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, displayTitle } from '../api'
import Tip from '../components/Tip'

const STATUS_LABEL = { unread: '未读', reading: '在读', read: '已读' }

export default function Library() {
  const nav = useNavigate()
  const [papers, setPapers] = useState(null)
  const [facets, setFacets] = useState(null)
  const [q, setQ] = useState('')
  const [mode, setMode] = useState('keyword')
  const [filters, setFilters] = useState({ status: '', tag: '', project: '', starred: false })
  const [sort, setSort] = useState('created_desc')
  const [dragOver, setDragOver] = useState(false)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState('')
  const [jobsRunning, setJobsRunning] = useState(0)
  const [pasteId, setPasteId] = useState('')
  const [addingId, setAddingId] = useState(false)
  const [checked, setChecked] = useState(new Set())
  const [deleting, setDeleting] = useState(false)
  const fileInput = useRef(null)
  const zoteroInput = useRef(null)

  const load = useCallback(async () => {
    const params = new URLSearchParams()
    if (q) params.set('q', q), params.set('mode', mode)
    if (filters.status) params.set('status', filters.status)
    if (filters.tag) params.set('tag', filters.tag)
    if (filters.project) params.set('project', filters.project)
    if (filters.starred) params.set('starred', 'true')
    params.set('sort', sort)
    try {
      const d = await api.get(`/papers?${params}`)
      setPapers(d)
      setError('')
    } catch (e) {
      setError(e.message)
    }
  }, [q, mode, filters, sort])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    api.get('/facets').then(setFacets).catch(() => {})
  }, [papers])

  // 后台有任务时轮询刷新（AI 处理完标题等会变化）
  useEffect(() => {
    const t = setInterval(async () => {
      try {
        const d = await api.get('/jobs?limit=20')
        const active = d.items.filter(j => j.status === 'running' || j.status === 'pending').length
        setJobsRunning(active)
        if (active > 0) load()
      } catch {}
    }, 3000)
    return () => clearInterval(t)
  }, [load])

  async function handleFiles(files) {
    for (const f of files) {
      if (!f.name.toLowerCase().endsWith('.pdf')) continue
      const fd = new FormData()
      fd.append('file', f)
      await api.post('/papers/upload', fd)
    }
    load()
  }

  async function handleZotero(file) {
    setImporting(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const r = await api.post('/zotero/import', fd)
      setError('')
      alert(r.message || '导入已开始')
    } catch (e) {
      setError(e.message)
    } finally {
      setImporting(false)
    }
  }

  async function addById() {
    const t = pasteId.trim()
    if (!t || addingId) return
    setAddingId(true)
    try {
      const r = await api.post('/papers/add_by_id', { identifier: t })
      setPasteId('')
      if (r.duplicate) {
        setError('')
        alert('该文献已在库中')
        nav(`/papers/${r.paper_id}`)
      } else {
        setError('')
        load()
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setAddingId(false)
    }
  }

  function exportBibtex() {
    // 勾选了就导勾选的；否则导当前筛选的全部
    if (checked.size > 0) {
      window.open(`/api/papers/bibtex?ids=${[...checked].join(',')}`)
      return
    }
    const params = new URLSearchParams()
    if (q) params.set('q', q)
    if (filters.status) params.set('status', filters.status)
    if (filters.tag) params.set('tag', filters.tag)
    if (filters.project) params.set('project', filters.project)
    if (filters.starred) params.set('starred', 'true')
    params.set('limit', '2000')
    fetch(`/api/papers?${params}`).then(r => r.json()).then(d => {
      const ids = d.items.map(p => p.id)
      if (!ids.length) { alert('当前筛选下没有文献'); return }
      window.open(`/api/papers/bibtex?ids=${ids.join(',')}`)
    })
  }

  function toggleCheck(id) {
    setChecked(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  function selectPage() {
    if (!papers) return
    setChecked(prev => {
      const next = new Set(prev)
      const allChecked = papers.items.every(p => prev.has(p.id))
      for (const p of papers.items) {
        if (allChecked) next.delete(p.id); else next.add(p.id)
      }
      return next
    })
  }

  async function batchDelete() {
    const n = checked.size
    if (!n || deleting) return
    if (!confirm(`确定删除选中的 ${n} 篇文献？对应的 PDF 和批注会一并删除，不可恢复。`)) return
    setDeleting(true)
    try {
      await api.post('/papers/batch_delete', { ids: [...checked] })
      setChecked(new Set())
      setError('')
      load()
    } catch (e) {
      setError(e.message)
    } finally {
      setDeleting(false)
    }
  }

  function toggleFilter(key, value) {
    setFilters(f => ({ ...f, [key]: f[key] === value ? '' : value }))
  }

  return (
    <div>
      <div className="page-head">
        <h1>文献库 {papers && <span className="muted">（{papers.total} 篇）</span>}</h1>
        <div className="row">
          <input ref={zoteroInput} type="file" accept=".json" hidden
            onChange={e => e.target.files[0] && handleZotero(e.target.files[0])} />
          <button className="btn" disabled={importing} onClick={() => zoteroInput.current.click()}>
            {importing ? '导入中…' : '导入 Zotero'}
          </button>
          <button className="btn" onClick={exportBibtex}>
            {checked.size > 0 ? `导出 BibTeX（已选 ${checked.size}）` : '导出 BibTeX'}
          </button>
          <input ref={fileInput} type="file" accept=".pdf" multiple hidden
            onChange={e => handleFiles([...e.target.files])} />
          <button className="btn primary" onClick={() => fileInput.current.click()}>＋ 添加 PDF</button>
        </div>
      </div>

      <form className="toolbar" onSubmit={e => { e.preventDefault(); addById() }}>
        <input type="text" style={{ flex: 1, minWidth: 260 }} placeholder="粘贴 arXiv 链接 / ID / DOI，回车入库"
          value={pasteId} onChange={e => setPasteId(e.target.value)} />
        <Tip text="支持 arXiv 链接 / arXiv ID / DOI / DOI 链接。入库后自动抓取元数据；arXiv 论文自动下载 PDF，DOI 论文自动尝试 Unpaywall 的合法 OA 副本。" />
        <button className="btn primary" disabled={addingId || !pasteId.trim()}>
          {addingId ? '入库中…' : '入库'}
        </button>
      </form>

      <div className="toolbar">
        <form onSubmit={e => { e.preventDefault(); load() }} className="row flex1">
          <input type="text" placeholder="搜索标题 / 摘要 / 全文…" value={q}
            onChange={e => setQ(e.target.value)} />
          <select value={mode} onChange={e => setMode(e.target.value)}>
            <option value="keyword">关键词</option>
            <option value="semantic">语义</option>
          </select>
        </form>
        <select value={sort} onChange={e => setSort(e.target.value)}>
          <option value="created_desc">最新添加</option>
          <option value="year_desc">年份新→旧</option>
          <option value="year_asc">年份旧→新</option>
          <option value="title_asc">标题 A→Z</option>
          <option value="starred">星标优先</option>
        </select>
      </div>

      {facets && (
        <div className="filters mb16">
          {['unread', 'reading', 'read'].map(s => (
            <button key={s} className={`chip ${filters.status === s ? 'active' : ''}`}
              onClick={() => toggleFilter('status', s)}>
              {STATUS_LABEL[s]} {facets.statuses?.find(x => x[0] === s)?.[1] || ''}
            </button>
          ))}
          <button className={`chip ${filters.starred ? 'active' : ''}`}
            onClick={() => setFilters(f => ({ ...f, starred: !f.starred }))}>★ 星标</button>
          {facets.projects?.map(([p, n]) => (
            <button key={p} className={`chip ${filters.project === p ? 'active' : ''}`}
              onClick={() => toggleFilter('project', p)}>📁 {p} {n}</button>
          ))}
          {(facets.tags || []).slice(0, 25).map(([t, n]) => (
            <button key={t} className={`chip ${filters.tag === t ? 'active' : ''}`}
              onClick={() => toggleFilter('tag', t)}>{t} {n}</button>
          ))}
        </div>
      )}

      {error && <div className="err-msg">{error}</div>}

      <div
        className="drop-zone mb16"
        style={dragOver ? { borderColor: 'var(--accent)' } : undefined}
        onDragOver={e => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => { e.preventDefault(); setDragOver(false); handleFiles([...e.dataTransfer.files]) }}
        onClick={() => fileInput.current.click()}
      >
        把 PDF 拖到这里，或点击选择文件
        <Tip text="自动识别 PDF 里的 arXiv 号 / DOI 并抓取标题、作者、期刊、摘要；识别失败会退化为按标题搜索匹配。" />
      </div>

      {jobsRunning > 0 && (
        <div className="muted mb8">
          ⏳ {jobsRunning} 个文献正在后台处理…
          <Tip text="后台正在提取 PDF 全文、抓取元数据、生成 AI 标签与向量索引，完成后文献条目会自动更新。" />
        </div>
      )}

      <div className="row mb16" style={{
        background: checked.size > 0 ? 'var(--accent-weak)' : 'var(--panel)',
        border: checked.size > 0 ? '1px solid #bfdbfe' : '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        padding: '8px 14px', flexWrap: 'wrap',
        position: 'sticky', top: -10, zIndex: 9,
        boxShadow: '0 2px 8px rgba(30,40,60,0.06)',
      }}>
        <strong style={{ color: checked.size > 0 ? undefined : 'var(--text2)' }}>
          {checked.size > 0 ? `已选 ${checked.size} 篇` : '批量操作'}
          <Tip text="勾选文献前的复选框后，可批量导出 BibTeX 或批量删除；「全选/取消本页」作用于当前列表。" />
        </strong>
        <button className="btn sm" onClick={selectPage} disabled={!papers || papers.items.length === 0}>
          全选/取消本页
        </button>
        <button className="btn sm" onClick={exportBibtex} disabled={checked.size === 0}>导出 BibTeX</button>
        <button className="btn sm danger" disabled={checked.size === 0 || deleting} onClick={batchDelete}>
          {deleting ? '删除中…' : '🗑 批量删除'}
        </button>
        <button className="btn sm" onClick={() => setChecked(new Set())} disabled={checked.size === 0}>清空选择</button>
      </div>

      {!papers ? <div className="loading">加载中…</div> : papers.items.length === 0 ? (
        <div className="empty">还没有文献。上传 PDF、从 Zotero 导入，或到「arXiv 订阅」页看看新论文。</div>
      ) : (
        <div className="paper-list">
          {papers.items.map(p => (
            <div key={p.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <input type="checkbox" checked={checked.has(p.id)} onClick={e => e.stopPropagation()}
                onChange={() => toggleCheck(p.id)}
                style={{ marginTop: 16 }} title="勾选后可批量导出 BibTeX" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <PaperItem p={p} nav={nav} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function PaperItem({ p, nav }) {
  return (
    <div className="paper-item" onClick={() => nav(`/papers/${p.id}`)}>
      <div className="p-title">
        <span className={`status-dot status-${p.status}`} />
        {p.starred ? <span className="star">★ </span> : null}
        {displayTitle(p.title)}
      </div>
      <div className="p-meta">
        {p.authors?.slice(0, 4).join(', ')}{p.authors?.length > 4 ? ' et al.' : ''}
        {p.year ? ` · ${p.year}` : ''}{p.venue ? ` · ${p.venue}` : ''}
        {p.has_pdf ? '' : ' · ⚠ 无 PDF'}
      </div>
      {p.abstract && <div className="p-abstract">{p.abstract}</div>}
      <div style={{ marginTop: 6 }}>
        {(p.projects || []).map(pr => <span key={pr} className="tag accent">{pr}</span>)}
        {(p.tags || []).map(t => <span key={t} className="tag">{t}</span>)}
      </div>
    </div>
  )
}
