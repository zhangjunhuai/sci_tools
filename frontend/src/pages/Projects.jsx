import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import Tip from '../components/Tip'
import Icon from '../components/Icon'

const PROJECT_ICONS = ['📁', '🤖', '🧠', '🧪', '📊', '🧩', '🧭', '🔬', '💡', '🚀', '🌐', '⚙️']
// 活动类型 → 图标与配色
const ACT_STYLE = {
  result: { icon: 'flask', cls: 'green' },
  note: { icon: 'pen', cls: 'yellow' },
  latex: { icon: 'fileCode', cls: 'purple' },
  paper: { icon: 'fileText', cls: 'blue' },
  update: { icon: 'pen', cls: 'gray' },
  project: { icon: 'folder', cls: 'orange' },
}

function relTime(s) {
  if (!s) return ''
  const d = new Date(String(s).replace(' ', 'T'))
  const now = new Date()
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (d >= startToday) return `今天 ${hm}`
  if (d >= new Date(startToday - 86400000)) return `昨天 ${hm}`
  const days = Math.floor((startToday - d) / 86400000)
  if (days < 30) return `${days} 天前`
  return String(s).slice(0, 10)
}

export default function Projects() {
  const [projects, setProjects] = useState(null)
  const [activities, setActivities] = useState([])
  const [showAllAct, setShowAllAct] = useState(false)
  const [q, setQ] = useState('')
  const [modal, setModal] = useState(null) // {mode: create|edit, ...initial}
  const [error, setError] = useState('')
  const searchRef = useRef(null)

  async function load() {
    try {
      const [p, a] = await Promise.all([api.get('/projects'), api.get('/projects/activity')])
      setProjects(p.items)
      setActivities(a.items)
      setError('')
    } catch (e) {
      setError(e.message)
    }
  }

  useEffect(() => { load() }, [])

  // ⌘K / Ctrl+K 聚焦搜索
  useEffect(() => {
    function onKey(e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const filtered = useMemo(() => {
    if (!projects) return []
    const kw = q.trim().toLowerCase()
    if (!kw) return projects
    return projects.filter(p =>
      p.name.toLowerCase().includes(kw) ||
      (p.description || '').toLowerCase().includes(kw))
  }, [projects, q])

  async function deleteProject(p) {
    if (!confirm(`确定删除项目「${p.name}」？项目下的笔记/实验记录会一并删除；文献本身不会被删除（仅移出本项目）。`)) return
    await api.del(`/projects/${p.id}`)
    load()
  }

  return (
    <div>
      <div className="page-head projpage-head">
        <h1>项目</h1>
        <div className="row">
          <div className="proj-search">
            <span className="proj-search-ico"><Icon name="search" size={14} /></span>
            <input ref={searchRef} placeholder="搜索项目名称、描述或关键词…"
              value={q} onChange={e => setQ(e.target.value)} />
            <span className="proj-search-kbd">⌘ K</span>
          </div>
          <button className="btn primary" onClick={() => setModal({ mode: 'create' })}><Icon name="plus" /> 新建项目</button>
        </div>
      </div>

      {error && <div className="err-msg">{error}</div>}

      <div className="proj-section-title">
        <h2>我的项目</h2>
        <div className="muted">管理你的研究主题、文献和实验记录</div>
      </div>

      <div className="proj-cards">
        {projects && filtered.map(p => <ProjectCard key={p.id} p={p} onEdit={() => setModal({ mode: 'edit', ...p })} onDelete={deleteProject} />)}
        {projects && filtered.length === 0 && q && (
          <div className="empty" style={{ gridColumn: '1 / -1' }}>没有匹配「{q}」的项目。</div>
        )}
        <button className="proj-newcard" onClick={() => setModal({ mode: 'create' })}>
          <div className="proj-newcircle">＋</div>
          <div className="proj-newtitle">新建研究项目</div>
          <div className="muted">创建一个新的研究项目，开始管理你的文献、笔记和实验记录</div>
        </button>
      </div>

      {activities.length > 0 && (
        <div className="card proj-activity">
          <div className="row spread mb8">
            <h2 style={{ margin: 0, fontSize: 17 }}>最近活动</h2>
            {activities.length > 6 && (
              <button className="btn sm" onClick={() => setShowAllAct(v => !v)}>
                {showAllAct ? '收起' : '查看全部 →'}
              </button>
            )}
          </div>
          {(showAllAct ? activities : activities.slice(0, 6)).map((e, i) => {
            const st = ACT_STYLE[e.kind] || ACT_STYLE.update
            return (
              <div key={i} className="pact-row">
                <div className={`pact-icon ${st.cls}`}><Icon name={st.icon} size={16} /></div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14 }}>
                    <strong>{e.project_name}</strong>
                    <span className="muted"> · {e.action}</span>
                  </div>
                  {e.detail && <div className="muted" style={{ fontSize: 13 }}>{e.detail}</div>}
                </div>
                <div className="muted" style={{ fontSize: 12.5, flexShrink: 0 }}>{relTime(e.time)}</div>
              </div>
            )
          })}
        </div>
      )}

      {modal && (
        <ProjectModal
          initial={modal}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); load() }}
        />
      )}
    </div>
  )
}

function ProjectCard({ p, onEdit, onDelete }) {
  const [menuOpen, setMenuOpen] = useState(false)
  return (
    <div className="proj-card2">
      {menuOpen && <div style={{ position: 'fixed', inset: 0, zIndex: 4 }} onClick={() => setMenuOpen(false)} />}
      <div className="row spread">
        <div className="proj-avatar">{p.icon || '📁'}</div>
        <div className="proj-menu">
          <button className="btn sm" onClick={() => setMenuOpen(v => !v)} title="更多操作"><Icon name="ellipsis" /></button>
          {menuOpen && (
            <div className="proj-menu-pop">
              <button onClick={() => { setMenuOpen(false); onEdit() }}><Icon name="pen" size={13} /> 编辑信息</button>
              <button className="danger" onClick={() => { setMenuOpen(false); onDelete(p) }}><Icon name="trash" size={13} /> 删除项目</button>
            </div>
          )}
        </div>
      </div>
      <div className="proj-card-title" title={p.name}>{p.name}</div>
      <div className="muted proj-card-desc">{p.description || '（无描述）'}</div>
      <div className="proj-card-counts">
        <span className="row" style={{ gap: 5 }}><Icon name="fileText" size={14} /> {p.paper_count} 篇文献</span>
        <span className="row" style={{ gap: 5 }}><Icon name="pen" size={14} /> {p.note_count} 条笔记 / 实验</span>
      </div>
      <div className="row spread" style={{ marginTop: 'auto', paddingTop: 12 }}>
        <span className="muted row" style={{ fontSize: 12.5, gap: 4 }}><Icon name="clock" size={13} /> 最近更新 {relTime(p.last_activity || p.created_at)}</span>
        <Link to={`/projects/${p.id}`} className="btn sm proj-enter">进入项目 <Icon name="arrowRight" size={13} /></Link>
      </div>
    </div>
  )
}

function ProjectModal({ initial, onClose, onSaved }) {
  const isEdit = initial.mode === 'edit'
  const [name, setName] = useState(initial.name || '')
  const [desc, setDesc] = useState(initial.description || '')
  const [icon, setIcon] = useState(initial.icon || '📁')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  async function save() {
    if (!name.trim() || saving) return
    setSaving(true)
    try {
      if (isEdit) {
        await api.patch(`/projects/${initial.id}`, { name: name.trim(), description: desc.trim(), icon })
      } else {
        await api.post('/projects', { name: name.trim(), description: desc.trim(), icon })
      }
      onSaved()
    } catch (e) {
      setErr(e.message)
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ width: 560 }} onClick={e => e.stopPropagation()}>
        <h2>{isEdit ? '编辑项目' : '新建研究项目'}</h2>
        <div className="form-row"><label>项目图标</label>
          <div className="proj-icon-row">
            {PROJECT_ICONS.map(ic => (
              <button key={ic} type="button"
                className={`proj-icon-opt ${icon === ic ? 'active' : ''}`}
                onClick={() => setIcon(ic)}>{ic}</button>
            ))}
          </div>
        </div>
        <div className="form-row"><label>项目名称</label>
          <input value={name} autoFocus placeholder="如：网格细胞建模"
            onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') save() }} /></div>
        <div className="form-row"><label>一句话描述（可选）</label>
          <input value={desc} placeholder="这个项目在研究什么"
            onChange={e => setDesc(e.target.value)} /></div>
        {err && <div className="err-msg">{err}</div>}
        <div className="row">
          <button className="btn primary" disabled={saving || !name.trim()} onClick={save}>
            {saving ? '保存中…' : isEdit ? '保存' : '创建'}
          </button>
          <button className="btn" onClick={onClose}>取消</button>
        </div>
      </div>
    </div>
  )
}
