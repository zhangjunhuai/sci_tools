import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, displayTitle } from '../api'
import Tip from '../components/Tip'
import CompareModal from '../components/CompareModal'
import JournalBadge from '../components/JournalBadge'

const STATUS_LABEL = { unread: '未读', reading: '在读', read: '已读' }
const ZONE_LABEL = { 1: '1 区', 2: '2 区', 3: '3 区', 4: '4 区' }
const TAG_PREVIEW = 12

const EMPTY_FILTERS = { status: new Set(), projects: new Set(), tags: new Set(), zones: new Set(), starred: false }

export default function Library() {
  const nav = useNavigate()
  const [papers, setPapers] = useState(null)
  const [facets, setFacets] = useState(null)
  const [q, setQ] = useState('')
  const [mode, setMode] = useState('keyword')
  const [filters, setFilters] = useState(EMPTY_FILTERS)
  const [showAllTags, setShowAllTags] = useState(false)
  const [sort, setSort] = useState('created_desc')
  const [dragOver, setDragOver] = useState(false)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState('')
  const [jobsRunning, setJobsRunning] = useState(0)
  const [pasteId, setPasteId] = useState('')
  const [addingId, setAddingId] = useState(false)
  const [checked, setChecked] = useState(new Set())
  const [compareIds, setCompareIds] = useState(null)
  const [deleting, setDeleting] = useState(false)
  const fileInput = useRef(null)
  const zoteroInput = useRef(null)

  const filterParams = useCallback(() => {
    const params = new URLSearchParams()
    if (q) params.set('q', q), params.set('mode', mode)
    if (filters.status.size) params.set('status', [...filters.status].join(','))
    if (filters.projects.size) params.set('project', [...filters.projects].join(','))
    if (filters.tags.size) params.set('tag', [...filters.tags].join(','))
    if (filters.zones.size) params.set('zone', [...filters.zones].join(','))
    if (filters.starred) params.set('starred', 'true')
    return params
  }, [q, mode, filters])

  const load = useCallback(async () => {
    const params = filterParams()
    params.set('sort', sort)
    try {
      const d = await api.get(`/papers?${params}`)
      setPapers(d)
      setError('')
    } catch (e) {
      setError(e.message)
    }
  }, [filterParams, sort])

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
    const params = filterParams()
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

  function toggleSet(key, value) {
    setFilters(f => {
      const next = new Set(f[key])
      if (next.has(value)) next.delete(value); else next.add(value)
      return { ...f, [key]: next }
    })
  }

  const activeFilterCount =
    filters.status.size + filters.projects.size + filters.tags.size + filters.zones.size +
    (filters.starred ? 1 : 0)

  function clearFilters() {
    setFilters(EMPTY_FILTERS)
    setShowAllTags(false)
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

      <div className="library-grid">
        <aside className="filter-side">
          <div className="fgroup">
            <div className="fgroup-title">阅读状态</div>
            {['unread', 'reading', 'read'].map(s => (
              <FilterRow key={s} checked={filters.status.has(s)} onChange={() => toggleSet('status', s)}
                label={STATUS_LABEL[s]} count={facets?.statuses?.find(x => x[0] === s)?.[1]} />
            ))}
          </div>

          <div className="fgroup">
            <div className="fgroup-title">星标</div>
            <FilterRow checked={filters.starred}
              onChange={() => setFilters(f => ({ ...f, starred: !f.starred }))}
              label="★ 星标文献" />
          </div>

          {(facets?.zones?.length ?? 0) > 0 && (
            <div className="fgroup">
              <div className="fgroup-title">中科院分区</div>
              {facets.zones.map(([z, n]) => (
                <FilterRow key={z} checked={filters.zones.has(z)} onChange={() => toggleSet('zones', z)}
                  label={ZONE_LABEL[z] || `${z} 区`} count={n} />
              ))}
            </div>
          )}

          {(facets?.projects?.length ?? 0) > 0 && (
            <div className="fgroup">
              <div className="fgroup-title">项目</div>
              {facets.projects.map(([p, n]) => (
                <FilterRow key={p} checked={filters.projects.has(p)} onChange={() => toggleSet('projects', p)}
                  label={p} count={n} />
              ))}
            </div>
          )}

          {(facets?.tags?.length ?? 0) > 0 && (
            <div className="fgroup">
              <div className="fgroup-title">标签</div>
              {(showAllTags ? facets.tags : facets.tags.slice(0, TAG_PREVIEW)).map(([t, n]) => (
                <FilterRow key={t} checked={filters.tags.has(t)} onChange={() => toggleSet('tags', t)}
                  label={t} count={n} />
              ))}
              {facets.tags.length > TAG_PREVIEW && (
                <button type="button" className="fshow-more" onClick={() => setShowAllTags(v => !v)}>
                  {showAllTags ? '收起 ▴' : `显示更多 (${facets.tags.length - TAG_PREVIEW}) ▾`}
                </button>
              )}
            </div>
          )}

          <button type="button" className="fclear" disabled={activeFilterCount === 0} onClick={clearFilters}>
            清空筛选
          </button>
        </aside>

        <div className="library-main">
          <div className="toolbar">
            <form onSubmit={e => { e.preventDefault(); load() }} className="row flex1">
              <input type="text" className="flex1" placeholder="搜索标题 / 摘要 / 全文…" value={q}
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

          {error && <div className="err-msg">{error}</div>}

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
              <Tip text="勾选文献前的复选框后，可批量导出 BibTeX、AI 跨文献对比（2-8 篇，生成方法/数据集/核心结论/局限对比表）或批量删除；「全选/取消本页」作用于当前列表。" />
            </strong>
            <button className="btn sm" onClick={selectPage} disabled={!papers || papers.items.length === 0}>
              全选/取消本页
            </button>
            <button className="btn sm" onClick={exportBibtex} disabled={checked.size === 0}>导出 BibTeX</button>
            <button className="btn sm" disabled={checked.size < 2 || checked.size > 8}
              onClick={() => setCompareIds([...checked])}
              title={checked.size < 2 ? '勾选至少 2 篇' : checked.size > 8 ? '最多同时对比 8 篇' : ''}>
              ⚖ AI 对比{checked.size >= 2 && checked.size <= 8 ? `（${checked.size} 篇）` : ''}
            </button>
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
      </div>

      {compareIds && <CompareModal ids={compareIds} onClose={() => setCompareIds(null)} />}
    </div>
  )
}

function FilterRow({ checked, onChange, label, count }) {
  return (
    <label className="fopt">
      <input type="checkbox" checked={checked} onChange={onChange} />
      <span className="fopt-label" title={label}>{label}</span>
      {count != null && <span className="cnt">({count})</span>}
    </label>
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
      {p.journal_info && <JournalBadge info={p.journal_info} />}
      {p.abstract && <div className="p-abstract">{p.abstract}</div>}
      <div style={{ marginTop: 6 }}>
        {(p.projects || []).map(pr => <span key={pr} className="tag accent">{pr}</span>)}
        {(p.tags || []).map(t => <span key={t} className="tag">{t}</span>)}
      </div>
    </div>
  )
}
