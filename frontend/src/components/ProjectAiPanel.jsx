import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import Tip from './Tip'
import Icon from './Icon'

const CAT_LABEL = { papers: '文献', notes: '笔记', results: '实验记录' }

export default function ProjectAiPanel({ project }) {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  // 访问权限：三类资料开关
  const [perm, setPerm] = useState({ papers: true, notes: true, results: true })
  // 范围：勾选的文献（空 = 项目全部）
  const [paperScope, setPaperScope] = useState(new Set())
  const [scopeOpen, setScopeOpen] = useState(false)
  const [usage, setUsage] = useState(null)   // 最近一次请求的实际用量
  const [window_, setWindow] = useState(32768)
  const boxRef = useRef(null)

  useEffect(() => {
    setMessages([]); setUsage(null); setPaperScope(new Set())
  }, [project.id])

  useEffect(() => {
    api.get('/settings').then(d => {
      const w = parseInt(d.context_window)
      if (!isNaN(w) && w > 0) setWindow(w)
    }).catch(() => {})
  }, [project.id])

  useEffect(() => { boxRef.current?.scrollTo(0, 1e9) }, [messages])

  // 前端预估：项目资料的字符量/2（与后端估算口径一致）
  const estTokens = (() => {
    let chars = 0
    if (perm.papers) {
      const list = paperScope.size
        ? project.papers.filter(p => paperScope.has(p.id))
        : project.papers
      for (const p of list) chars += ((p.abstract || '').length + (p.ai_summary || '').length + (p.title || '').length + 30)
    }
    for (const it of project.items) {
      if (it.item_type === 'note' && perm.notes) chars += (it.content || '').length + 40
      if (it.item_type === 'result' && perm.results) chars += (it.content || '').length + 40
    }
    return Math.round(chars / 2)
  })()
  const estTotal = estTokens + 4000
  const estPct = Math.min(100, Math.round((estTotal / window_) * 100))
  const overBudget = estTotal > window_

  async function ask(question) {
    setBusy(true)
    setMessages(m => [...m, { role: 'user', text: question }])
    try {
      const r = await api.post(`/projects/${project.id}/ai_ask`, {
        question,
        include_papers: perm.papers,
        include_notes: perm.notes,
        include_results: perm.results,
        paper_ids: [...paperScope],
      })
      setUsage(r.usage)
      setMessages(m => [...m, { role: 'bot', text: r.answer, sources: r.sources, truncated: r.truncated }])
    } catch (e) {
      setMessages(m => [...m, { role: 'bot', text: `❌ ${e.message}` }])
    } finally {
      setBusy(false)
    }
  }

  const scopeList = paperScope.size
    ? project.papers.filter(p => paperScope.has(p.id)).map(p => p.title)
    : null

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="row spread mb8">
        <strong><Icon name="bot" size={15} /> 项目 AI 助手
          <Tip text="基于本项目收录的文献摘要、笔记和实验记录回答问题。可通过下方开关控制 AI 能看到哪些资料、勾选具体文献缩小范围。" />
        </strong>
        <button className="btn sm" disabled={busy || estTokens === 0} onClick={() => ask('总结一下这个项目目前的进展：研究主题、已读文献要点、笔记想法和实验结果。')}>
          <Icon name="zap" size={13} /> 项目进展总结
        </button>
      </div>

      {/* 访问权限 */}
      <div className="row mb8" style={{ flexWrap: 'wrap', gap: 10, fontSize: 13.5, alignItems: 'center' }}>
        <span className="muted">AI 可访问：</span>
        {[['papers', `文献（${project.papers.length}）`], ['notes', `笔记（${project.items.filter(i => i.item_type === 'note').length}）`], ['results', `实验记录（${project.items.filter(i => i.item_type === 'result').length}）`]].map(([k, label]) => (
          <label key={k} className="row" style={{ gap: 4, cursor: 'pointer' }}>
            <input type="checkbox" checked={perm[k]} onChange={() => setPerm(p => ({ ...p, [k]: !p[k] }))} />
            {label}
          </label>
        ))}
        {perm.papers && project.papers.length > 0 && (
          <button className="btn sm" onClick={() => setScopeOpen(o => !o)}>
            🎯 选择文献范围{paperScope.size ? `（已选 ${paperScope.size}）` : '（全部）'}
          </button>
        )}
      </div>

      {/* 文献范围勾选 */}
      {scopeOpen && perm.papers && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', marginBottom: 8, maxHeight: 180, overflow: 'auto' }}>
          <div className="row mb8" style={{ gap: 6 }}>
            <button className="btn sm" onClick={() => setPaperScope(new Set(project.papers.map(p => p.id)))}>全选</button>
            <button className="btn sm" onClick={() => setPaperScope(new Set())}>清空（=全部）</button>
          </div>
          {project.papers.map(p => (
            <label key={p.id} className="fopt">
              <input type="checkbox" checked={paperScope.has(p.id)}
                onChange={() => setPaperScope(prev => {
                  const next = new Set(prev)
                  if (next.has(p.id)) next.delete(p.id); else next.add(p.id)
                  return next
                })} />
              <span className="fopt-label" style={{ whiteSpace: 'normal' }}>{p.title}</span>
            </label>
          ))}
        </div>
      )}

      {/* 上下文用量 */}
      <div className="ctx-meter mb8" title={`估算口径：约 2 字符 / token；其中预留 4000 tokens 给系统提示、问题和回答。上限可在「设置」中修改。`}>
        <div className="row spread" style={{ fontSize: 12.5 }}>
          <span className="muted">上下文预估 {estTokens.toLocaleString()} + 预留 4,000 ≈ {estTotal.toLocaleString()} / {window_.toLocaleString()} tokens</span>
          {usage && <span className="muted">上次实际注入 {usage.total.toLocaleString()}</span>}
        </div>
        <div className="ctx-bar">
          <div className={`ctx-fill ${overBudget ? 'over' : estPct > 70 ? 'warn' : ''}`} style={{ width: `${estPct}%` }} />
        </div>
        {usage && (
          <div className="muted" style={{ fontSize: 12 }}>
            注入构成：文献 {usage.papers.toLocaleString()} · 笔记 {usage.notes.toLocaleString()} · 实验记录 {usage.results.toLocaleString()}
          </div>
        )}
        {overBudget && <div className="err-msg" style={{ marginTop: 4 }}>预估超出上下文窗口，发送时会自动截断部分资料，建议缩小范围</div>}
      </div>

      {/* 对话区 */}
      <div ref={boxRef} style={{ maxHeight: 340, overflow: 'auto', minHeight: 80 }}>
        {messages.length === 0 && <div className="muted">针对本项目提问，如「这两篇论文的方法有什么区别？」。</div>}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            {m.text}
            {m.truncated && <div className="muted" style={{ fontSize: 12 }}>⚠ 资料较多，部分内容因上下文预算被截断</div>}
            {m.sources?.length > 0 && (
              <div className="src">📎 依据：{m.sources.map(s => `${CAT_LABEL[s.category] || s.category}「${s.title.slice(0, 22)}」`).join('、')}</div>
            )}
          </div>
        ))}
        {busy && <div className="msg bot">思考中…</div>}
      </div>

      <form className="row" onSubmit={e => { e.preventDefault(); if (input.trim() && !busy) { ask(input.trim()); setInput('') } }}>
        <input type="text" className="flex1" placeholder="针对本项目提问…" value={input}
          onChange={e => setInput(e.target.value)} />
        <button className="btn primary" disabled={busy || !input.trim() || estTokens === 0}
          title={estTokens === 0 ? '当前权限下没有可注入的资料' : ''}>发送</button>
      </form>
      {scopeList && (
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          范围限定：{scopeList.slice(0, 3).map(t => `《${t.slice(0, 18)}…》`).join('')}{scopeList.length > 3 ? ` 等 ${scopeList.length} 篇` : ''}
        </div>
      )}
    </div>
  )
}
