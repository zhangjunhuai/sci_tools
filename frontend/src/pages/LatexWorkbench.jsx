import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, displayTitle } from '../api'
import Icon from '../components/Icon'
import CodeArea from '../components/CodeArea'

/* 行级 LCS diff：[{t:' '|'+'|'-', s:line}] */
function lineDiff(a, b) {
  const A = a.split('\n'), B = b.split('\n')
  const m = A.length, n = B.length
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out = []
  let i = 0, j = 0
  while (i < m && j < n) {
    if (A[i] === B[j]) { out.push({ t: ' ', s: A[i] }); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: '-', s: A[i] }); i++ }
    else { out.push({ t: '+', s: B[j] }); j++ }
  }
  while (i < m) out.push({ t: '-', s: A[i++] })
  while (j < n) out.push({ t: '+', s: B[j++] })
  return out
}

/* 拖拽分隔条：拖动时回调新的宽度比例（0~1） */
function DragBar({ onDrag }) {
  const start = useCallback(e => {
    e.preventDefault()
    const move = ev => onDrag(ev.clientX)
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up) }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
  }, [onDrag])
  return <div className="lx-dragbar" onMouseDown={start} />
}

export default function LatexWorkbench() {
  const { pid, iid } = useParams()
  const [item, setItem] = useState(null)
  const [files, setFiles] = useState(null)          // 压缩包文件清单（无归档为 []）
  const [content, setContent] = useState('')        // 编辑中的源码
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [latexState, setLatexState] = useState({})  // {status, error?, compiledAt?}
  // 三栏宽度（百分比，左/中/右）
  const [cols, setCols] = useState(() => {
    const saved = JSON.parse(localStorage.getItem('lx_cols') || 'null')
    return saved || [17, 44, 39]
  })
  const wrapRef = useRef(null)

  // 聊天式 AI 修正
  const [msgs, setMsgs] = useState([])              // {role:'user'|'ai', text} | {role:'diff', before, after}
  const [input, setInput] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  const [selText, setSelText] = useState('')
  const taRef = useRef(null)
  const chatBoxRef = useRef(null)

  const load = useCallback(async () => {
    const proj = await api.get(`/projects/${pid}`)
    const it = proj.items.find(x => x.id === Number(iid))
    if (!it) return
    setItem(it)
    setContent(it.content || '')
    const f = await api.get(`/projects/${pid}/items/${iid}/files`)
    setFiles(f.files || [])
  }, [pid, iid])
  useEffect(() => { load() }, [load])

  useEffect(() => { localStorage.setItem('lx_cols', JSON.stringify(cols)) }, [cols])
  useEffect(() => { chatBoxRef.current?.scrollTo(0, 1e9) }, [msgs])

  async function save() {
    setSaving(true)
    try {
      await api.patch(`/projects/${pid}/items/${iid}`, { title: item.title, content })
      setDirty(false); setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    } finally {
      setSaving(false)
    }
  }

  async function compile() {
    if (latexState.status === 'compiling') return
    if (dirty) await save()
    setLatexState({ status: 'compiling' })
    try {
      const r = await api.post(`/projects/${pid}/items/${iid}/compile`)
      setLatexState({ status: 'ok', compiledAt: r.compiled_at })
    } catch (e) {
      setLatexState({ status: 'error', error: e.message })
    }
  }

  function captureSel(e) {
    const ta = e.target
    setSelText(ta.value.slice(ta.selectionStart, ta.selectionEnd))
  }

  async function send() {
    const q = input.trim()
    if (!q || aiBusy) return
    setInput('')
    setMsgs(m => [...m, { role: 'user', text: q }])
    setAiBusy(true)
    try {
      // 多轮上下文：历史里 assistant 消息用「当时的修改结果」
      const history = []
      for (const m of msgs) {
        if (m.role === 'user') history.push({ role: 'user', content: m.text })
        else if (m.role === 'ai') history.push({ role: 'assistant', content: m.text })
      }
      const r = await api.post(`/projects/${pid}/items/${iid}/ai_fix`, {
        source: content,
        selection: selText || null,
        instruction: q,
        history,
      })
      if (!r.changed) {
        setMsgs(m => [...m, { role: 'ai', text: '当前内容已符合要求，无需修改。' }])
      } else {
        setMsgs(m => [...m, { role: 'diff', before: content, after: r.fixed }])
      }
    } catch (e) {
      setMsgs(m => [...m, { role: 'ai', text: `出错：${e.message}` }])
    } finally {
      setAiBusy(false)
    }
  }

  function acceptDiff(idx) {
    const m = msgs[idx]
    setContent(m.after)
    setDirty(true)
    setMsgs(prev => prev.map((x, i) => i === idx ? { ...m, accepted: true } : x))
  }

  function dismissDiff(idx) {
    setMsgs(prev => prev.filter((_, i) => i !== idx))
  }

  // 三栏拖拽：左右两条分隔条
  function dragLeft(clientX) {
    const rect = wrapRef.current.getBoundingClientRect()
    const p = Math.min(40, Math.max(10, (clientX - rect.left) / rect.width * 100))
    setCols(([l, c, r]) => [p, 100 - p - r, r])
  }
  function dragRight(clientX) {
    const rect = wrapRef.current.getBoundingClientRect()
    const p = Math.min(60, Math.max(20, (rect.right - clientX) / rect.width * 100))
    setCols(([l, c, r]) => [l, 100 - l - p, p])
  }

  if (!item) return <div className="loading">加载中…</div>
  const st = latexState
  const pdfReady = st.status === 'ok' || item.pdf_ready
  const pdfUrl = `/api/projects/${pid}/items/${iid}/pdf?t=${st.compiledAt || item.compiled_at || ''}`
  const [lw, cw, rw] = cols

  return (
    <div className="lx-workbench">
      <div className="lx-head">
        <Link to={`/projects/${pid}`} className="proj-back">← 项目</Link>
        <strong className="lx-title" title={item.title}>{displayTitle(item.title) || '未命名文档'}</strong>
        {dirty && <span className="muted" style={{ fontSize: 12 }}>（未保存）</span>}
        {saved && <span className="muted" style={{ fontSize: 12 }}>已保存 ✓</span>}
        <div className="row" style={{ marginLeft: 'auto' }}>
          {st.status === 'error' && (
            <span className="lx-err-chip" title={st.error}>编译失败，悬停查看</span>
          )}
          {pdfReady && <span className="muted" style={{ fontSize: 12.5 }}>编译于 {st.compiledAt || item.compiled_at}</span>}
          <button className="btn sm" disabled={saving || !dirty} onClick={save}>
            <Icon name="save" size={13} /> {saving ? '保存中…' : saved ? '已保存 ✓' : '保存'}
          </button>
          <button className="btn sm primary" disabled={st.status === 'compiling'} onClick={compile}>
            <Icon name="play" size={13} /> {st.status === 'compiling' ? '编译中…' : '编译'}
          </button>
        </div>
      </div>

      <div className="lx-cols" ref={wrapRef}>
        {/* 左：文件树 */}
        <div className="lx-pane lx-files" style={{ width: `${lw}%` }}>
          <div className="lx-pane-title">文件 {files?.length ? `(${files.length})` : ''}</div>
          <div className="lx-file-list">
            {files && files.length === 0 && (
              <div className="muted" style={{ padding: '0 10px', fontSize: 12.5 }}>
                手写源码模式：没有附属文件。把 LaTeX 项目压缩包拖到项目页可导入完整项目。
              </div>
            )}
            {(files || []).map(f => (
              <div key={f.path} className={`lx-file ${f.is_tex ? 'is-tex' : ''}`}
                title={`${f.path}（${f.size} B）`}>
                <Icon name={f.is_tex ? 'fileCode' : 'file'} size={13} /> {f.path}
              </div>
            ))}
          </div>
        </div>
        <DragBar onDrag={dragLeft} />

        {/* 中：源码 + 对话框 */}
        <div className="lx-pane lx-center" style={{ width: `${cw}%` }}>
          <div className="lx-pane-title">源码 {selText && <span className="muted">（已选中 {selText.length} 字，AI 只改选中部分）</span>}</div>
          <CodeArea ref={taRef} className="lx-src" value={content}
            placeholder="LaTeX 源码…"
            onSelect={captureSel}
            onChange={e => { setContent(e.target.value); setDirty(true) }} />

          <div className="lx-chat">
            <div className="lx-msgs" ref={chatBoxRef}>
              {msgs.length === 0 && (
                <div className="muted" style={{ fontSize: 12.5, padding: '4px 2px' }}>
                  对 AI 说点什么来修改源码：可先在上方选中片段（只改选中部分），
                  例：「修复这段公式的语法」「把表格改为三线表」「润色 Introduction 的英文」。
                </div>
              )}
              {msgs.map((m, i) => m.role === 'diff' ? (
                <div key={i} className={`lx-diff ${m.accepted ? 'accepted' : ''}`}>
                  <div className="row spread" style={{ marginBottom: 6 }}>
                    <strong style={{ fontSize: 12.5 }}>修改建议</strong>
                    {!m.accepted && (
                      <div className="row">
                        <button className="btn sm primary" onClick={() => acceptDiff(i)}>接受</button>
                        <button className="btn sm" onClick={() => dismissDiff(i)}>放弃</button>
                      </div>
                    )}
                    {m.accepted && <span className="muted" style={{ fontSize: 12 }}>已接受（记得保存并编译）</span>}
                  </div>
                  <pre className="diff-view">
                    {lineDiff(m.before, m.after).map((l, j) => (
                      <div key={j} className={l.t === '+' ? 'd-add' : l.t === '-' ? 'd-del' : 'd-ctx'}>
                        {l.t === ' ' ? '' : l.t + ' '}{l.s}
                      </div>
                    ))}
                  </pre>
                </div>
              ) : (
                <div key={i} className={`lx-msg ${m.role}`}>{m.text}</div>
              ))}
              {aiBusy && <div className="lx-msg ai muted">AI 处理中…</div>}
            </div>
            <div className="lx-input">
              <input className="flex1" value={input} placeholder="向 AI 描述要做的修改，回车发送…"
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }} />
              <button className="btn sm primary" disabled={aiBusy || !input.trim()} onClick={send}>
                <Icon name="zap" size={13} /> 发送
              </button>
            </div>
          </div>
        </div>
        <DragBar onDrag={dragRight} />

        {/* 右：PDF 预览 */}
        <div className="lx-pane lx-right" style={{ width: `${rw}%` }}>
          <div className="lx-pane-title">预览</div>
          {pdfReady ? (
            <iframe key={st.compiledAt || item.compiled_at || 'pdf'} src={pdfUrl} title="PDF 预览" />
          ) : (
            <div className="lx-right-empty">
              {st.status === 'compiling' ? '编译中…' : '保存并点「编译」生成 PDF'}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
