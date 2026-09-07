import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import Tip from './Tip'

export default function AiPanel({ paper }) {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [summaryBusy, setSummaryBusy] = useState(false)
  const boxRef = useRef(null)

  useEffect(() => { setMessages([]) }, [paper.id])
  useEffect(() => { boxRef.current?.scrollTo(0, 1e9) }, [messages])

  async function summarize() {
    setSummaryBusy(true)
    try {
      const text = await buildSummary(paper)
      setMessages(m => [...m, { role: 'bot', text }])
    } catch (e) {
      setMessages(m => [...m, { role: 'bot', text: `❌ ${e.message}` }])
    } finally {
      setSummaryBusy(false)
    }
  }

  async function ask(question, paperIds) {
    setBusy(true)
    setMessages(m => [...m, { role: 'user', text: question }])
    try {
      const r = await api.post('/ai/ask', { question, paper_ids: paperIds || [] })
      setMessages(m => [...m, { role: 'bot', text: r.answer, sources: r.sources }])
    } catch (e) {
      setMessages(m => [...m, { role: 'bot', text: `❌ ${e.message}` }])
    } finally {
      setBusy(false)
    }
  }

  const quick = paper.id ? [
    { label: '这篇在讲什么？', q: '用三句话概括这篇论文的核心内容。' },
    { label: '方法细节', q: '这篇论文用了什么方法？关键步骤和参数是什么？' },
    { label: '局限性', q: '这篇论文的方法有哪些局限或潜在问题？' },
  ] : []

  return (
    <div className="card ai-panel flex1" style={{ display: 'flex', flexDirection: 'column', minHeight: 260 }}>
      <div className="row spread mb8">
        <strong>
          AI 助手
          <Tip text="对本文提问；在文献库搜索框选「智能」模式可做全库检索。首次使用需在「设置」配置 API Key。" />
        </strong>
        <button className="btn sm" onClick={summarize} disabled={summaryBusy}>
          {summaryBusy ? '生成中…' : '⚡ 生成结构化摘要'}
        </button>
      </div>
      <div ref={boxRef} style={{ flex: 1, overflow: 'auto', minHeight: 120, maxHeight: 380 }}>
        {messages.length === 0 && (
          <div className="muted">在下方输入框对本文提问。</div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            {m.text}
            {m.sources?.length > 0 && (
              <div className="src">📎 来源：{m.sources.map(s => `《${s.title?.slice(0, 25)}…》`).join(' ')}</div>
            )}
          </div>
        ))}
        {busy && <div className="msg bot">思考中…</div>}
      </div>
      <div className="row mb8" style={{ flexWrap: 'wrap' }}>
        {quick.map(x => (
          <button key={x.label} className="chip" disabled={busy} onClick={() => ask(x.q, [paper.id])}>{x.label}</button>
        ))}
      </div>
      <form className="row" onSubmit={e => { e.preventDefault(); if (input.trim() && !busy) { ask(input.trim(), [paper.id]); setInput('') } }}>
        <input type="text" className="flex1" placeholder="对本文提问…" value={input}
          onChange={e => setInput(e.target.value)} />
        <button className="btn primary" disabled={busy || !input.trim()}>发送</button>
      </form>
    </div>
  )
}

async function buildSummary(paper) {
  // 后端 ai_summary 已有就直接用；否则让 AI 现场生成
  if (paper.ai_summary) return paper.ai_summary
  const r = await api.post('/ai/ask', {
    question: '请给出这篇论文的结构化中文摘要，包含「研究问题」「方法」「核心发现」三部分。',
    paper_ids: [paper.id],
  })
  return r.answer
}
