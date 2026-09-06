import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, displayTitle } from '../api'
import PdfViewer from '../components/PdfViewer'
import AiPanel from '../components/AiPanel'
import Tip from '../components/Tip'
import JournalBadge from '../components/JournalBadge'
import Icon from '../components/Icon'

const STATUS_LABEL = { unread: '未读', reading: '在读', read: '已读' }

export default function PaperDetail() {
  const { id } = useParams()
  const nav = useNavigate()
  const [paper, setPaper] = useState(null)
  const [annotations, setAnnotations] = useState([])
  const [error, setError] = useState('')
  const [fileInput, setFileInput] = useState(null)

  async function loadPaper() {
    try {
      const p = await api.get(`/papers/${id}`)
      setPaper(p)
      const a = await api.get(`/papers/${id}/annotations`)
      setAnnotations(a.items)
    } catch (e) {
      setError(e.message)
    }
  }
  useEffect(() => { loadPaper() }, [id])

  async function patch(body) {
    const p = await api.patch(`/papers/${id}`, body)
    setPaper(prev => ({ ...prev, ...p }))
  }

  async function addAnnotation(body) {
    const a = await api.post(`/papers/${id}/annotations`, body)
    setAnnotations(prev => [...prev, a])
  }

  async function deleteAnnotation(annId) {
    await api.del(`/annotations/${annId}`)
    setAnnotations(prev => prev.filter(x => x.id !== annId))
  }

  async function attachPdf(file) {
    const fd = new FormData()
    fd.append('file', file)
    try {
      await api.post(`/papers/${id}/attach`, fd)
      loadPaper()
    } catch (e) { setError(e.message) }
  }

  async function delPaper() {
    if (!confirm('确定删除这篇文献？PDF 与批注会一并删除。')) return
    await api.del(`/papers/${id}`)
    nav('/')
  }

  async function copyBibtex() {
    try {
      const bib = await api.getText(`/papers/${id}/bibtex`)
      await navigator.clipboard.writeText(bib)
      alert('BibTeX 已复制到剪贴板')
    } catch (e) {
      // 剪贴板失败时退化为下载
      const blob = new Blob([await api.getText(`/papers/${id}/bibtex`)], { type: 'application/x-bibtex' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = 'paper.bib'
      a.click()
    }
  }

  if (error) return <div className="err-msg">{error} <button className="btn sm" onClick={() => nav('/')}>返回</button></div>
  if (!paper) return <div className="loading">加载中…</div>

  return (
    <div>
      <div className="page-head">
        <div>
          <Link to="/">← 文献库</Link>
          <h1 style={{ marginTop: 6 }}>{displayTitle(paper.title)}</h1>
          <div className="muted">
            {paper.authors?.join(', ')}
            {paper.year ? ` · ${paper.year}` : ''}{paper.venue ? ` · ${paper.venue}` : ''}
            {paper.doi ? ` · DOI: ${paper.doi}` : ''}
            {paper.arxiv_id ? ` · arXiv:${paper.arxiv_id}` : ''}
          </div>
          <div style={{ marginTop: 6 }}>
            <JournalBadge info={paper.journal_info} />
          </div>
        </div>
        <div className="row">
          <select value={paper.status} onChange={e => patch({ status: e.target.value })}>
            {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <button className="btn" onClick={() => patch({ starred: !paper.starred })}>
            <Icon name="star" size={13} filled={paper.starred} /> {paper.starred ? '已星标' : '星标'}
          </button>
          <button className="btn" onClick={copyBibtex}>BibTeX</button>
          <button className="btn danger" onClick={delPaper}><Icon name="trash" size={13} /> 删除</button>
        </div>
      </div>

      {paper.duplicate_ids?.length > 0 && (
        <div className="err-msg">
          ⚠ 疑似重复条目（相同 DOI/arXiv 号）：
          {paper.duplicate_ids.map(did => <Link key={did} to={`/papers/${did}`} style={{ marginRight: 8 }}>#{did}</Link>)}
        </div>
      )}

      <div className="detail-grid">
        <div className="pdf-pane">
          {paper.has_pdf ? (
            <PdfViewer paperId={paper.id} initialPage={paper.last_page || 1} annotations={annotations} onAdd={addAnnotation} onDelete={deleteAnnotation} />
          ) : (
            <div style={{ padding: 30 }}>
              <div className="empty">这篇文献还没有 PDF。</div>
              <input type="file" accept=".pdf" hidden
                ref={el => el && setFileInput(el)}
                onChange={e => e.target.files[0] && attachPdf(e.target.files[0])} />
              <div className="row" style={{ justifyContent: 'center' }}>
                <button className="btn primary" onClick={() => fileInput?.click()}>上传 PDF</button>
              </div>
            </div>
          )}
        </div>

        <div className="side-pane">
          <div className="card">
            <strong className="row" style={{ gap: 5 }}>
              <Icon name="zap" size={14} /> AI 摘要
              <Tip text="入库后台处理时自动生成；也可在下方 AI 助手里点「生成结构化摘要」手动生成。" />
            </strong>
            {paper.ai_summary ? (
              <div style={{ whiteSpace: 'pre-wrap', fontSize: 14, lineHeight: 1.6 }}>{paper.ai_summary}</div>
            ) : (
              <div className="muted">暂无摘要。</div>
            )}
            <div className="mb8" />
            <div>
              {paper.projects?.map(p => <span key={p} className="tag accent">{p}</span>)}
              {paper.tags?.map(t => <span key={t} className="tag">{t}</span>)}
            </div>
          </div>

          <EditMetaCard paper={paper} onSaved={p => setPaper(prev => ({ ...prev, ...p }))} />

          <div className="card">
            <strong className="row mb8" style={{ gap: 5 }}><Icon name="pen" size={14} /> 批注 / 高亮（{annotations.length}）</strong>
            {annotations.length === 0 && <div className="muted">在 PDF 里选中文字即可高亮。</div>}
            {annotations.map(a => (
              <div key={a.id} className="ann-item">
                <button className="btn sm" onClick={() => deleteAnnotation(a.id)}>删</button>
                <div>第 {a.page} 页 · <span style={{ color: 'var(--accent)' }}> {a.color === 'yellow' ? '🟡' : a.color === 'green' ? '🟢' : a.color === 'blue' ? '🔵' : '🔴'}</span></div>
                <div>“{a.content?.slice(0, 120)}{a.content?.length > 120 ? '…' : ''}”</div>
                {a.comment && <div className="muted">💬 {a.comment}</div>}
              </div>
            ))}
          </div>

          <NotesCard paper={paper} onSaved={p => setPaper(prev => ({ ...prev, ...p }))} />

          <CitationsCard paper={paper} nav={nav} />

          <RelatedCard paper={paper} nav={nav} />

          <AiPanel paper={paper} />
        </div>
      </div>
    </div>
  )
}

function EditMetaCard({ paper, onSaved }) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState(null)

  function start() {
    setForm({
      title: paper.title,
      authors: (paper.authors || []).join(', '),
      year: paper.year || '',
      venue: paper.venue || '',
      tags: (paper.tags || []).join(', '),
      projects: (paper.projects || []).join(', '),
    })
    setOpen(true)
  }

  async function save() {
    const body = {
      title: form.title,
      authors: form.authors.split(/[,，;；]/).map(s => s.trim()).filter(Boolean),
      year: form.year ? parseInt(form.year) : null,
      venue: form.venue,
      tags: form.tags.split(/[,，;；]/).map(s => s.trim()).filter(Boolean),
      projects: form.projects.split(/[,，;；]/).map(s => s.trim()).filter(Boolean),
    }
    const p = await api.patch(`/papers/${paper.id}`, body)
    onSaved(p)
    setOpen(false)
  }

  if (!open) return (
    <div className="card">
      <div className="row spread">
        <strong>
          标签 / 项目
          <Tip text="标签按主题（如「网格细胞」「SNN」），项目按研究方向分组；配置 API 后入库时 AI 会按你的标签体系自动打标。" />
        </strong>
        <button className="btn sm" onClick={start}>编辑</button>
      </div>
      <div>
        {paper.projects?.map(p => <span key={p} className="tag accent">{p}</span>)}
        {paper.tags?.map(t => <span key={t} className="tag">{t}</span>)}
        {(paper.projects?.length || 0) + (paper.tags?.length || 0) === 0 && (
          <span className="muted">暂无标签。</span>
        )}
      </div>
    </div>
  )

  return (
    <div className="card">
      <strong className="mb8">编辑信息</strong>
      <div className="form-row"><label>标题</label><input value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} /></div>
      <div className="form-row"><label>作者（逗号分隔）</label><input value={form.authors} onChange={e => setForm({ ...form, authors: e.target.value })} /></div>
      <div className="form-row"><label>年份</label><input value={form.year} onChange={e => setForm({ ...form, year: e.target.value })} /></div>
      <div className="form-row"><label>期刊 / 会议</label><input value={form.venue} onChange={e => setForm({ ...form, venue: e.target.value })} /></div>
      <div className="form-row"><label>标签（逗号分隔）</label><input value={form.tags} onChange={e => setForm({ ...form, tags: e.target.value })} /></div>
      <div className="form-row"><label>项目（逗号分隔）</label><input value={form.projects} onChange={e => setForm({ ...form, projects: e.target.value })} /></div>
      <div className="row">
        <button className="btn primary" onClick={save}>保存</button>
        <button className="btn" onClick={() => setOpen(false)}>取消</button>
      </div>
    </div>
  )
}

function NotesCard({ paper, onSaved }) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(paper.notes || '')
  const [saving, setSaving] = useState(false)
  const [drafting, setDrafting] = useState(false)

  useEffect(() => { setText(paper.notes || '') }, [paper.id])

  async function save() {
    setSaving(true)
    try {
      const p = await api.patch(`/papers/${paper.id}`, { notes: text })
      onSaved(p)
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }

  async function genDraft() {
    if (drafting) return
    if (paper.notes && !confirm('将用 AI 整理本文的高亮/批注生成笔记草稿，追加到现有笔记末尾。继续？')) return
    setDrafting(true)
    try {
      const r = await api.post(`/papers/${paper.id}/note_draft`)
      const p = await api.get(`/papers/${paper.id}`)
      onSaved(p)
      setText(r.notes)
      setEditing(true)
    } catch (e) {
      alert(e.message)
    } finally {
      setDrafting(false)
    }
  }

  return (
    <div className="card">
      <div className="row spread">
        <strong className="row" style={{ gap: 5 }}>
          <Icon name="pen" size={14} /> 阅读笔记
          <Tip text="支持 Markdown；用 [[论文标题]] 可双链到库里其他论文（点击跳转）。「AI 整理草稿」把本文的高亮和批注整理成结构化笔记追加到这里。" />
        </strong>
        {!editing && (
          <div className="row">
            <button className="btn sm" disabled={drafting} onClick={genDraft}>
              <>{drafting ? '整理中…' : <><Icon name="zap" size={13} /> AI 整理草稿</>}</>
            </button>
            <button className="btn sm" onClick={() => setEditing(true)}>编辑</button>
          </div>
        )}
      </div>
      {editing ? (
        <>
          <textarea rows={10} style={{ width: '100%' }} value={text}
            placeholder="支持 Markdown…" onChange={e => setText(e.target.value)} />
          <div className="row mb8" />
          <div className="row">
            <button className="btn primary" disabled={saving} onClick={save}>保存</button>
            <button className="btn" onClick={() => { setEditing(false); setText(paper.notes || '') }}>取消</button>
          </div>
        </>
      ) : (
        <div style={{ fontSize: 14, lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>
          {paper.notes ? <Markdownish text={paper.notes} /> : <span className="muted">暂无笔记</span>}
        </div>
      )}
    </div>
  )
}

function CitationsCard({ paper, nav }) {
  const [dir, setDir] = useState(null) // 'refs' | 'cited'
  const [items, setItems] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [collapsed, setCollapsed] = useState(false)
  const [summaries, setSummaries] = useState({}) // idx -> {text, loading}

  async function load(d) {
    if (dir === d) { setDir(null); setItems(null); return }
    setDir(d); setLoading(true); setError(''); setItems(null); setSummaries({}); setCollapsed(false)
    try {
      const r = await api.get(`/papers/${paper.id}/citations?direction=${d}&limit=30`)
      setItems(d === 'refs' ? (r.references || []) : (r.citations || []))
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  async function showSummary(it, idx) {
    // 已展开则收起
    if (summaries[idx]?.text) {
      setSummaries(prev => ({ ...prev, [idx]: undefined }))
      return
    }
    setSummaries(prev => ({ ...prev, [idx]: { loading: true } }))
    try {
      if (it.in_library && it.paper_id) {
        // 已入库：直接用库里的 AI 摘要
        const p = await api.get(`/papers/${it.paper_id}`)
        setSummaries(prev => ({ ...prev, [idx]: { text: p.ai_summary || '（该文献还没有 AI 摘要，等后台处理完成或到详情页手动生成）' } }))
      } else {
        const r = await api.post('/citations/quick_summary', { item: it })
        setSummaries(prev => ({ ...prev, [idx]: { text: r.summary } }))
      }
    } catch (e) {
      setSummaries(prev => ({ ...prev, [idx]: { text: null, error: e.message } }))
    }
  }

  async function add(it, idx) {
    try {
      const r = await api.post('/papers/add_cited', { item: it })
      setItems(prev => prev.map((x, i) => i === idx ? { ...x, in_library: true, paper_id: r.paper_id } : x))
    } catch (e) {
      alert(e.message)
    }
  }

  return (
    <div className="card">
      <div className="row spread mb8">
        <strong className="row" style={{ gap: 5 }}>
          <Icon name="network" size={14} /> 引文网络
          <Tip text="查这篇论文引用了谁、被谁引用（数据来自 Semantic Scholar）。点文献标题可看 AI 速览；「折叠」可收起列表。" />
        </strong>
        <div className="row">
          <button className={`chip ${dir === 'refs' ? 'active' : ''}`} onClick={() => load('refs')}>参考文献</button>
          <button className={`chip ${dir === 'cited' ? 'active' : ''}`} onClick={() => load('cited')}>被引论文</button>
          {items && items.length > 0 && (
            <button className="btn sm" onClick={() => setCollapsed(c => !c)}>
              {collapsed ? `展开（${items.length}）` : '折叠'}
            </button>
          )}
        </div>
      </div>
      {dir === null && <div className="muted">点击「参考文献」或「被引论文」开始查询。</div>}
      {loading && <div className="muted">查询中…</div>}
      {error && <div className="err-msg">{error}</div>}
      {items && items.length === 0 && <div className="muted">没有查到记录。</div>}
      {!collapsed && (items || []).map((it, i) => (
        <div key={i} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
          <div
            className="clickable"
            style={{ fontSize: 13.5, fontWeight: 600, color: summaries[i] ? 'var(--accent)' : undefined }}
            onClick={() => showSummary(it, i)}
            title="点击查看 AI 速览"
          >
            {it.title}
            {summaries[i]?.loading && <span className="muted">（生成速览中…）</span>}
            {summaries[i]?.text && <span style={{ fontWeight: 400 }}>（点击收起）</span>}
          </div>
          <div className="muted">
            {it.authors?.slice(0, 3).join(', ')}{it.authors?.length > 3 ? ' et al.' : ''}
            {it.year ? ` · ${it.year}` : ''}{it.venue ? ` · ${it.venue}` : ''}
            {it.citationCount != null ? ` · 被引 ${it.citationCount}` : ''}
          </div>
          {summaries[i] && (summaries[i].text || summaries[i].error) && (
            <div style={{
              marginTop: 6, padding: '8px 10px', borderRadius: 6, fontSize: 13, lineHeight: 1.7,
              background: 'var(--accent-weak)', color: '#1e3a8a',
            }}>
              {summaries[i].text || <span style={{ color: 'var(--danger)' }}>{summaries[i].error}</span>}
            </div>
          )}
          <div className="row" style={{ marginTop: 4 }}>
            {it.in_library ? (
              <button className="btn sm" onClick={() => it.paper_id && nav(`/papers/${it.paper_id}`)}>✓ 已入库，查看</button>
            ) : (
              <button className="btn sm primary" onClick={() => add(it, i)}>＋ 入库</button>
            )}
            {it.arxiv_id && <a href={`https://arxiv.org/abs/${it.arxiv_id}`} target="_blank" rel="noreferrer">
              <button className="btn sm">arXiv</button></a>}
          </div>
        </div>
      ))}
    </div>
  )
}

function RelatedCard({ paper, nav }) {
  const [items, setItems] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [collapsed, setCollapsed] = useState(false)

  async function load() {
    setLoading(true); setError(''); setItems(null); setCollapsed(false)
    try {
      const r = await api.get(`/papers/${paper.id}/related`)
      setItems(r.items)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  async function add(it, idx) {
    try {
      const r = await api.post('/papers/add_cited', { item: it })
      setItems(prev => prev.map((x, i) => i === idx ? { ...x, in_library: true, paper_id: r.paper_id } : x))
    } catch (e) {
      alert(e.message)
    }
  }

  return (
    <div className="card">
      <div className="row spread mb8">
        <strong className="row" style={{ gap: 5 }}>
          <Icon name="zap" size={14} /> 相关文献推荐
          <Tip text="基于本文在 Semantic Scholar 上的相似论文推荐，库内已有的会直接标出。" />
        </strong>
        <div className="row">
          {items && items.length > 0 && (
            <button className="btn sm" onClick={() => setCollapsed(c => !c)}>
              {collapsed ? `展开（${items.length}）` : '折叠'}
            </button>
          )}
          <button className="btn sm" disabled={loading} onClick={load}>
            {loading ? '查询中…' : items ? '刷新' : '查询推荐'}
          </button>
        </div>
      </div>
      {!items && !loading && !error && <div className="muted">点击「查询推荐」看看相关研究。</div>}
      {error && <div className="err-msg">{error}</div>}
      {items && items.length === 0 && <div className="muted">没有查到推荐。</div>}
      {!collapsed && (items || []).map((it, i) => (
        <div key={i} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontSize: 13.5, fontWeight: 600 }}>
            {it.in_library ? (
              <span className="clickable" style={{ color: 'var(--accent)' }}
                onClick={() => it.paper_id && nav(`/papers/${it.paper_id}`)}>
                {it.title}（已入库，点击查看）
              </span>
            ) : it.title}
          </div>
          <div className="muted">
            {it.authors?.slice(0, 3).join(', ')}{it.authors?.length > 3 ? ' et al.' : ''}
            {it.year ? ` · ${it.year}` : ''}{it.venue ? ` · ${it.venue}` : ''}
            {it.citationCount != null ? ` · 被引 ${it.citationCount}` : ''}
          </div>
          {!it.in_library && (
            <div className="row" style={{ marginTop: 4 }}>
              <button className="btn sm primary" onClick={() => add(it, i)}>＋ 入库</button>
              {it.arxiv_id && <a href={`https://arxiv.org/abs/${it.arxiv_id}`} target="_blank" rel="noreferrer">
                <button className="btn sm">arXiv</button></a>}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

// 轻量渲染：[[标题]] 链接 + 换行
function Markdownish({ text }) {
  const parts = []
  const re = /\[\[(.+?)\]\]/g
  let last = 0, m
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    parts.push(<NoteLink key={m[1]} title={m[1]} />)
    last = re.lastIndex
  }
  parts.push(text.slice(last))
  return <>{parts}</>
}

function NoteLink({ title }) {
  const nav = useNavigate()
  const [hit, setHit] = useState(null)
  useEffect(() => {
    api.get(`/papers?q=${encodeURIComponent(title)}&limit=5`).then(d => {
      setHit(d.items.find(p => p.title === title) || (d.items.length === 1 ? d.items[0] : null))
    }).catch(() => {})
  }, [title])
  return (
    <span className="clickable" style={{ color: 'var(--accent)', textDecoration: 'underline' }}
      onClick={() => hit ? nav(`/papers/${hit.id}`) : alert('库里没有完全匹配的论文')}>
      {title}
    </span>
  )
}
