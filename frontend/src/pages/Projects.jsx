import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import Tip from '../components/Tip'

export default function Projects() {
  const [projects, setProjects] = useState(null)
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')

  async function load() {
    try {
      const d = await api.get('/projects')
      setProjects(d.items)
      setError('')
    } catch (e) {
      setError(e.message)
    }
  }

  useEffect(() => { load() }, [])

  async function create() {
    if (!name.trim() || creating) return
    setCreating(true)
    try {
      await api.post('/projects', { name: name.trim(), description: desc.trim() })
      setName(''); setDesc('')
      load()
    } catch (e) {
      setError(e.message)
    } finally {
      setCreating(false)
    }
  }

  return (
    <div>
      <div className="page-head">
        <h1>项目 <span className="muted">{projects ? `（${projects.length} 个）` : ''}</span>
          <Tip text="按研究方向组织工作台：每个项目可收纳文献、随手笔记和实验记录。文献库里也能按项目筛选。" />
        </h1>
      </div>

      <div className="card mb16">
        <strong className="mb8">新建项目</strong>
        <div className="toolbar" style={{ marginBottom: 0 }}>
          <input type="text" placeholder="项目名称，如：网格细胞建模" value={name}
            onChange={e => setName(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
          <input type="text" placeholder="一句话描述（可选）" value={desc}
            onChange={e => setDesc(e.target.value)} style={{ flex: 2, minWidth: 240 }} />
          <button className="btn primary" disabled={creating || !name.trim()} onClick={create}>
            {creating ? '创建中…' : '＋ 创建'}
          </button>
        </div>
      </div>

      {error && <div className="err-msg">{error}</div>}

      {!projects ? <div className="loading">加载中…</div> : projects.length === 0 ? (
        <div className="empty">还没有项目。在上面建一个，把相关文献、想法和实验结果集中管理。</div>
      ) : (
        <div className="proj-grid">
          {projects.map(p => (
            <Link to={`/projects/${p.id}`} key={p.id} style={{ textDecoration: 'none', color: 'inherit' }}>
              <div className="card proj-card">
                <div className="p-title">📁 {p.name}</div>
                {p.description && <div className="muted" style={{ margin: '6px 0' }}>{p.description}</div>}
                <div className="p-meta" style={{ marginBottom: 0 }}>
                  📄 {p.paper_count} 篇文献 · 📝 {p.note_count} 条笔记/实验
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
