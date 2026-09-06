import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, displayTitle } from '../api'
import Tip from '../components/Tip'
import JournalBadge from '../components/JournalBadge'
import ProjectAiPanel from '../components/ProjectAiPanel'

const TYPE_LABEL = { note: '📝 笔记', result: '🧪 实验记录', latex: '📄 LaTeX 文档' }

const TEX_TEMPLATE = `\\documentclass[UTF8]{ctexart}
\\usepackage{amsmath,graphicx,booktabs}
\\usepackage{hyperref}
\\title{文档标题}
\\author{}
\\date{\\today}

\\begin{document}
\\maketitle

\\section{背景}
在这里写背景。

\\section{方法}
公式示例：$E = mc^2$，行内公式直接用美元符号包裹。

\\section{结果}
\\begin{tabular}{lr}
\\toprule
指标 & 数值 \\\\
\\midrule
grid score & 0.72 \\\\
\\bottomrule
\\end{tabular}

\\end{document}`

export default function ProjectDetail() {
  const { id } = useParams()
  const nav = useNavigate()
  const [proj, setProj] = useState(null)
  const [error, setError] = useState('')
  const [editingMeta, setEditingMeta] = useState(false)
  const [metaForm, setMetaForm] = useState(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [latexState, setLatexState] = useState({}) // item_id -> {status: compiling|ok|error, error?}
  const [uploading, setUploading] = useState(false)
  const [collapsed, setCollapsed] = useState(new Set()) // 折叠的树分组
  const [sideHidden, setSideHidden] = useState(false) // 收起整个左侧栏
  // VSCode 式选中：{kind: overview|paper|note|result|latex|ai, id?}
  const [sel, setSel] = useState({ kind: 'overview', id: null })
  const [draft, setDraft] = useState(null) // 选中条目的编辑草稿 {title, content}
  const [saving, setSaving] = useState(false)
  const latexInputRef = useRef(null)

  async function load() {
    try {
      setProj(await api.get(`/projects/${id}`))
      setError('')
    } catch (e) {
      setError(e.message)
    }
  }

  useEffect(() => { load() }, [id])

  // 选中项变化（或数据刷新）时同步编辑草稿
  const selItem = proj?.items?.find(i => i.id === sel.id) || null
  const selPaper = sel.kind === 'paper' ? proj?.papers?.find(p => p.id === sel.id) : null
  useEffect(() => {
    if (selItem && ['note', 'result', 'latex'].includes(selItem.item_type)) {
      setDraft({ title: selItem.title || '', content: selItem.content || '' })
    } else {
      setDraft(null)
    }
  }, [sel.kind, sel.id, selItem?.id, selItem?.updated_at])

  function toggleGroup(key) {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }

  function startEditMeta() {
    setMetaForm({ name: proj.name, description: proj.description || '' })
    setEditingMeta(true)
    setSel({ kind: 'overview', id: null })
  }

  async function saveMeta() {
    try {
      const d = await api.patch(`/projects/${id}`, metaForm)
      setProj(d)
      setEditingMeta(false)
    } catch (e) {
      setError(e.message)
    }
  }

  async function deleteProject() {
    if (!confirm(`确定删除项目「${proj.name}」？项目下的 ${proj.items.length} 条笔记/实验记录会一并删除；文献本身不会被删除（仅移出本项目）。`)) return
    await api.del(`/projects/${id}`)
    nav('/projects')
  }

  async function removePaper(pid) {
    await api.del(`/projects/${id}/papers/${pid}`)
    if (sel.kind === 'paper' && sel.id === pid) setSel({ kind: 'overview', id: null })
    load()
  }

  // 新建条目：立即创建并选中进入编辑（VSCode 新文件式）
  async function newItem(itemType) {
    const defaults = itemType === 'latex'
      ? { title: '未命名文档', content: TEX_TEMPLATE }
      : { title: '', content: '' }
    const r = await api.post(`/projects/${id}/items`, { item_type: itemType, ...defaults })
    await load()
    setSel({ kind: itemType, id: r.id })
  }

  async function saveDraft() {
    if (!draft || !selItem) return false
    setSaving(true)
    try {
      await api.patch(`/projects/${id}/items/${selItem.id}`, draft)
      await load()
      return true
    } catch (e) {
      setError(e.message)
      return false
    } finally {
      setSaving(false)
    }
  }

  async function deleteItem(it) {
    if (!confirm(`删除${TYPE_LABEL[it.item_type] || '条目'}「${it.title || '无标题'}」？不可恢复。`)) return
    await api.del(`/projects/${id}/items/${it.id}`)
    if (sel.id === it.id) setSel({ kind: 'overview', id: null })
    load()
  }

  async function compileLatex(it) {
    if (latexState[it.id]?.status === 'compiling') return
    // 编译前先保存编辑中的内容
    if (sel.kind === 'latex' && sel.id === it.id && draft) await saveDraft()
    setLatexState(s => ({ ...s, [it.id]: { status: 'compiling' } }))
    try {
      const r = await api.post(`/projects/${id}/items/${it.id}/compile`)
      setLatexState(s => ({ ...s, [it.id]: { status: 'ok', pdfUrl: r.pdf_url, compiledAt: r.compiled_at } }))
    } catch (e) {
      setLatexState(s => ({ ...s, [it.id]: { status: 'error', error: e.message } }))
    }
  }

  async function importArchive(file) {
    if (!/\.(zip|tar\.gz|tgz|tar\.bz2|tar)$/i.test(file.name)) {
      alert('仅支持 .zip / .tar.gz / .tgz / .tar.bz2 / .tar 压缩包')
      return
    }
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const r = await api.post(`/projects/${id}/latex_import`, fd)
      await load()
      setSel({ kind: 'latex', id: r.id })
      await compileLatex({ id: r.id })
      load()
    } catch (e) {
      alert(e.message)
    } finally {
      setUploading(false)
    }
  }

  if (error) return <div className="err-msg">{error} <Link to="/projects">返回项目列表</Link></div>
  if (!proj) return <div className="loading">加载中…</div>

  const notes = proj.items.filter(i => i.item_type === 'note')
  const results = proj.items.filter(i => i.item_type === 'result')
  const latexDocs = proj.items.filter(i => i.item_type === 'latex')
  const inProject = new Set(proj.papers.map(p => p.id))
  const groupItems = { papers: proj.papers, notes, results, latex: latexDocs }

  const groups = [
    { key: 'papers', label: '文献', icon: '📄', count: proj.papers.length,
      onAdd: () => setPickerOpen(true) },
    { key: 'notes', label: '笔记', icon: '📝', count: notes.length, onAdd: () => newItem('note') },
    { key: 'results', label: '实验记录', icon: '🧪', count: results.length, onAdd: () => newItem('result') },
    { key: 'latex', label: 'LaTeX 文档', icon: '📊', count: latexDocs.length, onAdd: () => newItem('latex') },
  ]

  function treeItemsFor(g) {
    if (g.key === 'papers') {
      return proj.papers.map(p => ({
        id: p.id, kind: 'paper', icon: '📄', title: displayTitle(p.title),
        badge: p.has_pdf ? null : '⚠',
      }))
    }
    return groupItems[g.key].map(it => ({
      id: it.id, kind: it.item_type, icon: it.item_type === 'latex' ? '📊' : g.icon,
      title: it.title || '（无标题）',
      badge: it.item_type === 'latex'
        ? (latexState[it.id]?.status === 'error' ? '🔴' : (it.pdf_ready || latexState[it.id]?.status === 'ok') ? '🟢' : null)
        : null,
      extra: it.item_type === 'latex' && it.archive ? `📦${it.archive.file_count}` : null,
    }))
  }

  return (
    <div className={`proj-workspace ${sideHidden ? 'side-hidden' : ''}`}>
      {/* 侧栏收起后显示的竖条开关 */}
      <button className={`proj-side-toggle ${sideHidden ? 'collapsed' : ''}`}
        onClick={() => setSideHidden(v => !v)}
        title={sideHidden ? '展开侧栏' : '收起侧栏'}>
        {sideHidden ? '»' : '«'}
      </button>

      {/* ============ 左侧资源树 ============ */}
      <aside className="proj-side">
        <div className="proj-side-head">
          <Link to="/projects" className="proj-back">← 项目</Link>
          <div className="proj-side-title" title={proj.name}>📁 {proj.name}</div>
          {proj.description && <div className="proj-side-desc">{proj.description}</div>}
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn sm" onClick={startEditMeta}>编辑</button>
            <button className="btn sm danger" onClick={deleteProject}>🗑</button>
          </div>
        </div>

        <div className="proj-tree">
          {groups.map(g => (
            <div key={g.key}>
              <div className="ptree-group-head" onClick={() => toggleGroup(g.key)}>
                <span>{collapsed.has(g.key) ? '▸' : '▾'} {g.icon} {g.label} <span className="muted">{g.count}</span></span>
                <span className="ptree-add" title={`新建${g.label}`}
                  onClick={e => { e.stopPropagation(); g.onAdd() }}>＋</span>
              </div>
              {!collapsed.has(g.key) && treeItemsFor(g).map(it => (
                <div key={it.id}
                  className={`ptree-item ${sel.kind === it.kind && sel.id === it.id ? 'active' : ''}`}
                  onClick={() => setSel({ kind: it.kind, id: it.id })}
                  title={it.title}>
                  <span className="ptree-icon">{it.icon}</span>
                  <span className="ptree-label">{it.title}</span>
                  {it.extra && <span className="ptree-extra">{it.extra}</span>}
                  {it.badge && <span className="ptree-badge">{it.badge}</span>}
                  {it.kind !== 'paper' && (
                    <span className="ptree-x" title="删除"
                      onClick={e => { e.stopPropagation(); deleteItem(groupItems[g.key].find(x => x.id === it.id)) }}>✕</span>
                  )}
                </div>
              ))}
              {!collapsed.has(g.key) && groupItems[g.key].length === 0 && (
                <div className="ptree-empty">（空）</div>
              )}
            </div>
          ))}

          <div className="ptree-group-head" style={{ marginTop: 10 }}>
            <span>🤖 AI 助手</span>
          </div>
          <div className={`ptree-item ${sel.kind === 'ai' ? 'active' : ''}`}
            onClick={() => setSel({ kind: 'ai', id: null })}>
            <span className="ptree-icon">🤖</span>
            <span className="ptree-label">与项目对话</span>
          </div>
        </div>

        <div className="proj-side-foot">
          <input type="file" hidden accept=".zip,.tar.gz,.tgz,.tar.bz2,.tar"
            ref={el => el && (latexInputRef.current = el)}
            onChange={e => { const f = e.target.files[0]; if (f) importArchive(f); e.target.value = '' }} />
          <button className="btn sm" style={{ width: '100%' }} disabled={uploading}
            onClick={() => latexInputRef.current?.click()}>
            {uploading ? '导入中…' : '📦 导入 LaTeX 压缩包'}
          </button>
        </div>
      </aside>

      {/* ============ 右侧主显示区 ============ */}
      <main className="proj-main">
        {sel.kind === 'overview' && (
          <OverviewPanel proj={proj} editingMeta={editingMeta} metaForm={metaForm}
            setMetaForm={setMetaForm} saveMeta={saveMeta} setEditingMeta={setEditingMeta}
            startEditMeta={startEditMeta} deleteProject={deleteProject} />
        )}

        {sel.kind === 'paper' && selPaper && (
          <PaperView paper={selPaper} nav={nav} onRemove={() => removePaper(selPaper.id)} />
        )}

        {sel.kind === 'ai' && <ProjectAiPanel project={proj} />}

        {['note', 'result', 'latex'].includes(sel.kind) && selItem && (
          <ItemEditor
            item={selItem} draft={draft} setDraft={setDraft} saving={saving}
            onSave={saveDraft} onDelete={() => deleteItem(selItem)}
            onCompile={() => compileLatex(selItem)}
            latexState={latexState[selItem.id] || {}}
            projectId={id}
          />
        )}

        {!['overview', 'paper', 'ai', 'note', 'result', 'latex'].includes(sel.kind) && (
          <div className="empty">从左侧选择要查看的内容。</div>
        )}
      </main>

      {pickerOpen && (
        <PaperPicker
          allPapers={proj.all_papers}
          inProject={inProject}
          onClose={() => setPickerOpen(false)}
          onAdd={async ids => {
            await api.post(`/projects/${id}/papers`, { paper_ids: ids })
            setPickerOpen(false)
            load()
          }}
        />
      )}
    </div>
  )
}

/* ---------- 右侧：项目概览 ---------- */
function OverviewPanel({ proj, editingMeta, metaForm, setMetaForm, saveMeta, setEditingMeta, startEditMeta, deleteProject }) {
  return (
    <div>
      <h2 style={{ marginTop: 0 }}>📁 {proj.name}</h2>
      {proj.description ? (
        <p className="muted" style={{ marginTop: -6 }}>{proj.description}</p>
      ) : (
        <p className="muted" style={{ marginTop: -6 }}>无描述。</p>
      )}
      <div className="row mb16" style={{ flexWrap: 'wrap', gap: 8 }}>
        <span className="tag accent">📄 {proj.papers.length} 篇文献</span>
        <span className="tag">📝 {proj.items.filter(i => i.item_type === 'note').length} 条笔记</span>
        <span className="tag">🧪 {proj.items.filter(i => i.item_type === 'result').length} 条实验记录</span>
        <span className="tag">📊 {proj.items.filter(i => i.item_type === 'latex').length} 个 LaTeX 文档</span>
      </div>
      {!editingMeta ? (
        <button className="btn sm" onClick={startEditMeta}>编辑项目信息</button>
      ) : (
        <div className="card" style={{ maxWidth: 560 }}>
          <div className="form-row"><label>项目名称</label>
            <input value={metaForm.name} onChange={e => setMetaForm({ ...metaForm, name: e.target.value })} /></div>
          <div className="form-row"><label>描述</label>
            <input value={metaForm.description} onChange={e => setMetaForm({ ...metaForm, description: e.target.value })} /></div>
          <div className="row">
            <button className="btn primary sm" onClick={saveMeta}>保存</button>
            <button className="btn sm" onClick={() => setEditingMeta(false)}>取消</button>
          </div>
        </div>
      )}
      <div className="muted" style={{ marginTop: 24, fontSize: 13 }}>
        ← 从左侧选择文献、笔记或 LaTeX 文档查看/编辑；「🤖 AI 助手」可基于项目内容问答。
      </div>
      <div style={{ marginTop: 18 }}>
        <button className="btn sm danger" onClick={deleteProject}>🗑 删除项目</button>
      </div>
    </div>
  )
}

/* ---------- 右侧：文献视图 ---------- */
function PaperView({ paper, nav, onRemove }) {
  return (
    <div>
      <h2 style={{ marginTop: 0 }}>{displayTitle(paper.title)}</h2>
      <div className="muted">
        {paper.authors?.join(', ')}
        {paper.year ? ` · ${paper.year}` : ''}{paper.venue ? ` · ${paper.venue}` : ''}
        {paper.has_pdf ? '' : ' · ⚠ 无 PDF'}
      </div>
      {paper.journal_info && <div style={{ margin: '8px 0' }}><JournalBadge info={paper.journal_info} /></div>}
      {paper.abstract && (
        <p style={{ lineHeight: 1.7, fontSize: 14 }}>{paper.abstract}</p>
      )}
      {(paper.projects?.length || paper.tags?.length) && (
        <div className="mb8">
          {paper.projects?.map(p => <span key={p} className="tag accent">{p}</span>)}
          {paper.tags?.map(t => <span key={t} className="tag">{t}</span>)}
        </div>
      )}
      <div className="row" style={{ marginTop: 16 }}>
        <button className="btn sm primary" onClick={() => nav(`/papers/${paper.id}`)}>打开完整详情（阅读 / 批注 / AI）</button>
        <button className="btn sm" onClick={onRemove} title="从项目移除（文献保留在库）">从项目移除</button>
      </div>
    </div>
  )
}

/* ---------- 右侧：条目内联编辑器 ---------- */
function ItemEditor({ item, draft, setDraft, saving, onSave, onDelete, onCompile, latexState, projectId }) {
  const isLatex = item.item_type === 'latex'
  const st = latexState
  const typeLabel = { note: '📝 笔记', result: '🧪 实验记录', latex: '📄 LaTeX 文档' }[item.item_type]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="row spread" style={{ flexWrap: 'wrap', gap: 8 }}>
        <strong>{typeLabel}</strong>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {isLatex && (
            <>
              <button className="btn sm primary" disabled={st.status === 'compiling'} onClick={onCompile}>
                {st.status === 'compiling' ? '编译中…（可能需几十秒）' : '▶ 编译'}
              </button>
              {(st.status === 'ok' || item.pdf_ready) && (
                <>
                  <a href={st.pdfUrl || `/api/projects/${projectId}/items/${item.id}/pdf`} target="_blank" rel="noreferrer">
                    <button className="btn sm">👁 预览 PDF</button>
                  </a>
                  <a href={st.pdfUrl || `/api/projects/${projectId}/items/${item.id}/pdf`}
                     download={`${displayTitle(draft?.title || item.title) || 'document'}.pdf`}>
                    <button className="btn sm">⬇ 下载</button>
                  </a>
                  <span className="muted" style={{ fontSize: 12.5 }}>编译于 {st.compiledAt || item.compiled_at}</span>
                </>
              )}
            </>
          )}
          <button className="btn sm" disabled={saving || !draft} onClick={onSave}>
            {saving ? '保存中…' : '💾 保存'}
          </button>
          <button className="btn sm danger" onClick={onDelete}>🗑 删除</button>
        </div>
      </div>

      {item.archive && (
        <div className="muted" style={{ fontSize: 12.5, margin: '6px 0' }}>
          📦 项目包：{item.archive.file_count} 个文件 · 主文件 {item.archive.main_tex}
          （编辑下方主 tex 源码，保存并编译即生效）
        </div>
      )}

      <input className="proj-item-title" value={draft?.title ?? ''}
        placeholder="标题" onChange={e => setDraft(d => ({ ...d, title: e.target.value }))} />

      <textarea className="proj-item-content" value={draft?.content ?? ''}
        placeholder={isLatex ? 'LaTeX 源码…' : '内容（支持 Markdown）…'}
        onChange={e => setDraft(d => ({ ...d, content: e.target.value }))} />

      {isLatex && st.status === 'error' && <pre className="latex-err">{st.error}</pre>}
      {isLatex && !item.archive && (
        <div className="muted" style={{ fontSize: 12.5 }}>提示：直接把 LaTeX 项目压缩包（.zip / .tar.gz）拖到左侧 LaTeX 分组可导入完整项目（图片/参考文献）。</div>
      )}
    </div>
  )
}

/* ---------- 添加文献弹窗 ---------- */
function PaperPicker({ allPapers, inProject, onAdd, onClose }) {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(new Set())
  const [saving, setSaving] = useState(false)
  const list = allPapers.filter(p => !inProject.has(p.id) &&
    (!q || (p.title || '').toLowerCase().includes(q.toLowerCase())))

  function toggle(id) {
    setSel(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ width: 640 }} onClick={e => e.stopPropagation()}>
        <h2>添加文献到项目</h2>
        <input type="text" placeholder="搜索标题…" value={q} autoFocus
          onChange={e => setQ(e.target.value)} style={{ width: '100%', marginBottom: 10 }} />
        <div style={{ maxHeight: 320, overflow: 'auto', marginBottom: 12 }}>
          {list.length === 0 && <div className="muted">没有可添加的文献（可能都已在本项目中）。</div>}
          {list.map(p => (
            <label key={p.id} className="fopt">
              <input type="checkbox" checked={sel.has(p.id)} onChange={() => toggle(p.id)} />
              <span className="fopt-label" style={{ whiteSpace: 'normal' }}>
                {displayTitle(p.title)}
                <span className="muted" style={{ fontSize: 12.5 }}>
                  {p.year ? ` · ${p.year}` : ''}{p.venue ? ` · ${p.venue}` : ''}
                </span>
              </span>
            </label>
          ))}
        </div>
        <div className="row spread">
          <span className="muted">已选 {sel.size} 篇</span>
          <div className="row">
            <button className="btn" onClick={onClose}>取消</button>
            <button className="btn primary" disabled={sel.size === 0 || saving}
              onClick={async () => { setSaving(true); await onAdd([...sel]) }}>
              {saving ? '添加中…' : '添加'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
