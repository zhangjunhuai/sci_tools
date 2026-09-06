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
  const [itemModal, setItemModal] = useState(null) // {item_type, id?, title, content}
  const [latexState, setLatexState] = useState({}) // item_id -> {status: compiling|ok|error, error?}
  const [uploading, setUploading] = useState(false)
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

  function startEditMeta() {
    setMetaForm({ name: proj.name, description: proj.description || '' })
    setEditingMeta(true)
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
    load()
  }

  async function saveItem(form) {
    if (form.id) {
      await api.patch(`/projects/${id}/items/${form.id}`, { title: form.title, content: form.content })
    } else {
      await api.post(`/projects/${id}/items`, { item_type: form.item_type, title: form.title, content: form.content })
    }
    setItemModal(null)
    load()
  }

  async function deleteItem(it) {
    if (!confirm(`删除${TYPE_LABEL[it.item_type] || '条目'}「${it.title || '无标题'}」？不可恢复。`)) return
    await api.del(`/projects/${id}/items/${it.id}`)
    load()
  }

  async function compileLatex(it) {
    if (latexState[it.id]?.status === 'compiling') return
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
      // 导入后自动编译一次，直接给出结果反馈
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

  return (
    <div>
      <div className="page-head">
        <div>
          <Link to="/projects">← 项目</Link>
          <h1 style={{ marginTop: 6 }}>📁 {proj.name}</h1>
          {proj.description && <div className="muted">{proj.description}</div>}
        </div>
        <div className="row">
          <button className="btn sm" onClick={startEditMeta}>编辑信息</button>
          <button className="btn sm danger" onClick={deleteProject}>🗑 删除项目</button>
        </div>
      </div>

      {editingMeta && (
        <div className="card mb16">
          <strong className="mb8">编辑项目信息</strong>
          <div className="form-row"><label>项目名称</label>
            <input value={metaForm.name} onChange={e => setMetaForm({ ...metaForm, name: e.target.value })} /></div>
          <div className="form-row"><label>描述</label>
            <input value={metaForm.description} onChange={e => setMetaForm({ ...metaForm, description: e.target.value })} /></div>
          <div className="row">
            <button className="btn primary" onClick={saveMeta}>保存</button>
            <button className="btn" onClick={() => setEditingMeta(false)}>取消</button>
          </div>
        </div>
      )}

      {/* ---------- 文献 ---------- */}
      <div className="card mb16">
        <div className="row spread mb8">
          <strong>📄 文献（{proj.papers.length}）</strong>
          <button className="btn sm primary" onClick={() => setPickerOpen(true)}>＋ 添加文献</button>
        </div>
        {proj.papers.length === 0 && <div className="muted">还没有文献，点「添加文献」从库里勾选。</div>}
        {proj.papers.map(p => (
          <div key={p.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
            <div className="row spread">
              <span className="clickable" style={{ fontWeight: 600, fontSize: 14 }}
                onClick={() => nav(`/papers/${p.id}`)}>
                {displayTitle(p.title)}
              </span>
              <button className="btn sm" onClick={() => removePaper(p.id)} title="从项目移除（文献保留在库）">移除</button>
            </div>
            <div className="muted">
              {p.authors?.slice(0, 3).join(', ')}{p.authors?.length > 3 ? ' et al.' : ''}
              {p.year ? ` · ${p.year}` : ''}{p.venue ? ` · ${p.venue}` : ''}
              {p.has_pdf ? '' : ' · ⚠ 无 PDF'}
            </div>
            {p.journal_info && <div style={{ marginTop: 4 }}><JournalBadge info={p.journal_info} /></div>}
          </div>
        ))}
      </div>

      {/* ---------- 笔记 / 实验记录 ---------- */}
      <ItemSection title="📝 笔记" tip="研究想法、文献综述片段、讨论记录，支持 Markdown。" 
        items={notes} onAdd={() => setItemModal({ item_type: 'note', title: '', content: '' })}
        onEdit={it => setItemModal({ ...it })} onDelete={deleteItem} />
      <ItemSection title="🧪 实验记录" tip="实验设置、结果、指标对比，支持 Markdown。"
        items={results} onAdd={() => setItemModal({ item_type: 'result', title: '', content: '' })}
        onEdit={it => setItemModal({ ...it })} onDelete={deleteItem} />

      <ItemSection title="📄 LaTeX 文档" tip="写周报、实验报告等，一键用 xelatex 编译成 PDF（支持中文）。也可直接把 LaTeX 项目压缩包（.zip / .tar.gz，如 Overleaf 导出）拖到本卡片上导入，图片、参考文献等资源会保留。需系统安装 TeX Live。"
        items={latexDocs} onAdd={() => setItemModal({ item_type: 'latex', title: '', content: TEX_TEMPLATE })}
        onEdit={it => setItemModal({ ...it })} onDelete={deleteItem}
        headerExtra={
          <>
            <input type="file" hidden accept=".zip,.tar.gz,.tgz,.tar.bz2,.tar"
              ref={el => el && (latexInputRef.current = el)}
              onChange={e => { const f = e.target.files[0]; if (f) importArchive(f); e.target.value = '' }} />
            <button className="btn sm" disabled={uploading} onClick={() => latexInputRef.current?.click()}>
              {uploading ? '导入中…' : '📦 导入压缩包'}
            </button>
          </>
        }
        onDropFile={importArchive}
        renderExtra={(it) => {
          const st = latexState[it.id] || {}
          return (
            <div style={{ marginTop: 6, display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <button className="btn sm primary" disabled={st.status === 'compiling'} onClick={() => compileLatex(it)}>
                {st.status === 'compiling' ? '编译中…（可能需几十秒）' : '▶ 编译'}
              </button>
              {(st.status === 'ok' || it.pdf_ready) && (
                <>
                  <a href={st.pdfUrl || `/api/projects/${id}/items/${it.id}/pdf`} target="_blank" rel="noreferrer">
                    <button className="btn sm">👁 预览 PDF</button>
                  </a>
                  <a href={st.pdfUrl || `/api/projects/${id}/items/${it.id}/pdf`}
                     download={`${displayTitle(it.title) || 'document'}.pdf`}>
                    <button className="btn sm">⬇ 下载</button>
                  </a>
                  <span className="muted" style={{ fontSize: 12.5 }}>
                    编译于 {st.compiledAt || it.compiled_at}
                  </span>
                </>
              )}
              {it.archive && (
                <span className="muted" style={{ fontSize: 12.5 }}>
                  📦 项目包：{it.archive.file_count} 个文件 · 主文件 {it.archive.main_tex}
                </span>
              )}
              {st.status === 'error' && (
                <pre className="latex-err">{st.error}</pre>
              )}
            </div>
          )
        }}
      />

      <ProjectAiPanel project={proj} />

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

      {itemModal && (
        <ItemModal form={itemModal} onClose={() => setItemModal(null)} onSave={saveItem} />
      )}
    </div>
  )
}

function ItemSection({ title, tip, items, onAdd, onEdit, onDelete, children, headerExtra, onDropFile, renderExtra }) {
  const [dragOver, setDragOver] = useState(false)
  return (
    <div className="card mb16"
      style={dragOver ? { outline: '2px dashed var(--accent)', outlineOffset: '-4px' } : undefined}
      onDragOver={e => { if (onDropFile) { e.preventDefault(); setDragOver(true) } }}
      onDragLeave={() => setDragOver(false)}
      onDrop={e => {
        if (!onDropFile) return
        e.preventDefault(); setDragOver(false)
        const f = [...e.dataTransfer.files].find(x => /\.(zip|tar\.gz|tgz|tar\.bz2|tar)$/i.test(x.name))
        if (f) onDropFile(f)
      }}
    >
      <div className="row spread mb8">
        <strong>{title}（{items.length}）<Tip text={tip} /></strong>
        <div className="row">
          {headerExtra}
          <button className="btn sm primary" onClick={onAdd}>＋ 新建</button>
        </div>
      </div>
      {items.length === 0 && <div className="muted">{onDropFile ? '还没有内容。可以点「新建」，或直接把 LaTeX 项目压缩包拖到这里。' : '还没有内容。'}</div>}
      {items.map(it => (
        <div key={it.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
          <div className="row spread">
            <span className="clickable" style={{ fontWeight: 600, fontSize: 14 }}
              onClick={() => onEdit(it)} title="点击编辑">
              {it.title || '（无标题）'}
            </span>
            <button className="btn sm" onClick={() => onDelete(it)}>删</button>
          </div>
          <div className="muted" style={{ fontSize: 12.5 }}>
            {it.updated_at?.slice(0, 16) || it.created_at?.slice(0, 16)}
          </div>
          {renderExtra?.(it)}
          {it.content && it.item_type !== 'latex' && (
            <div style={{
              marginTop: 4, fontSize: 13.5, lineHeight: 1.6, whiteSpace: 'pre-wrap',
              color: 'var(--text2)', display: '-webkit-box', WebkitLineClamp: 3,
              WebkitBoxOrient: 'vertical', overflow: 'hidden',
            }}>{it.content}</div>
          )}
        </div>
      ))}
    </div>
  )
}

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

function ItemModal({ form, onClose, onSave }) {
  const [title, setTitle] = useState(form.title || '')
  const [content, setContent] = useState(form.content || '')
  const [saving, setSaving] = useState(false)
  const isLatex = form.item_type === 'latex'

  function insertTemplate() {
    if (content.trim() && !confirm('插入模板会覆盖当前内容，继续？')) return
    setContent(TEX_TEMPLATE)
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ width: 820 }} onClick={e => e.stopPropagation()}>
        <h2>{form.id ? '编辑' : '新建'}{TYPE_LABEL[form.item_type] || '条目'}</h2>
        <div className="form-row"><label>标题</label>
          <input value={title} onChange={e => setTitle(e.target.value)} autoFocus /></div>
        <div className="form-row">
          <div className="row spread">
            <label>{isLatex ? 'LaTeX 源码（xelatex 编译，支持中文；推荐 ctexart 文档类）' : '内容（支持 Markdown）'}</label>
            {isLatex && <button type="button" className="btn sm" onClick={insertTemplate}>插入中文模板</button>}
          </div>
          <textarea rows={isLatex ? 18 : 10} value={content}
            style={{ width: '100%', fontFamily: 'monospace', fontSize: 13.5 }}
            onChange={e => setContent(e.target.value)} />
          {isLatex && <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>保存后点列表里的「▶ 编译」生成 PDF。</div>}
        </div>
        <div className="row">
          <button className="btn primary" disabled={saving}
            onClick={async () => { setSaving(true); await onSave({ ...form, title, content }) }}>
            {saving ? '保存中…' : '保存'}
          </button>
          <button className="btn" onClick={onClose}>取消</button>
        </div>
      </div>
    </div>
  )
}
