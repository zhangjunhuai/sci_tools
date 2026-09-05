import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, displayTitle } from '../api'
import Tip from '../components/Tip'
import JournalBadge from '../components/JournalBadge'
import ProjectAiPanel from '../components/ProjectAiPanel'

const TYPE_LABEL = { note: '📝 笔记', result: '🧪 实验记录' }

export default function ProjectDetail() {
  const { id } = useParams()
  const nav = useNavigate()
  const [proj, setProj] = useState(null)
  const [error, setError] = useState('')
  const [editingMeta, setEditingMeta] = useState(false)
  const [metaForm, setMetaForm] = useState(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [itemModal, setItemModal] = useState(null) // {item_type, id?, title, content}

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

  if (error) return <div className="err-msg">{error} <Link to="/projects">返回项目列表</Link></div>
  if (!proj) return <div className="loading">加载中…</div>

  const notes = proj.items.filter(i => i.item_type === 'note')
  const results = proj.items.filter(i => i.item_type === 'result')
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

function ItemSection({ title, tip, items, onAdd, onEdit, onDelete }) {
  return (
    <div className="card mb16">
      <div className="row spread mb8">
        <strong>{title}（{items.length}）<Tip text={tip} /></strong>
        <button className="btn sm primary" onClick={onAdd}>＋ 新建</button>
      </div>
      {items.length === 0 && <div className="muted">还没有内容。</div>}
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
          {it.content && (
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

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ width: 720 }} onClick={e => e.stopPropagation()}>
        <h2>{form.id ? '编辑' : '新建'}{TYPE_LABEL[form.item_type] || '条目'}</h2>
        <div className="form-row"><label>标题</label>
          <input value={title} onChange={e => setTitle(e.target.value)} autoFocus /></div>
        <div className="form-row"><label>内容（支持 Markdown）</label>
          <textarea rows={12} value={content} style={{ width: '100%', fontFamily: 'monospace', fontSize: 13.5 }}
            onChange={e => setContent(e.target.value)} /></div>
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
