import { useEffect, useState } from 'react'
import { api, displayTitle } from '../api'
import Tip from './Tip'
import Icon from './Icon'

const COLS = [
  ['method', '方法'],
  ['datasets', '数据集'],
  ['findings', '核心结论'],
  ['limitations', '局限'],
]

export default function CompareModal({ ids, onClose }) {
  const [rows, setRows] = useState(null)
  const [overall, setOverall] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError('')
    setCopied(false)
    api.post('/ai/compare', { paper_ids: ids })
      .then(d => {
        if (!alive) return
        setRows(d.rows)
        setOverall(d.overall || '')
        if (d.skipped?.length) setError(`已跳过 ${d.skipped.length} 篇（未就绪或无全文）：${d.skipped.join('、')}`)
      })
      .catch(e => { if (alive) setError(e.message) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [ids, nonce])

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  function toMarkdown() {
    const esc = s => (s || '').replace(/\|/g, '\\|').replace(/\s*\n+\s*/g, ' ')
    const lines = [
      `| 论文 | ${COLS.map(c => c[1]).join(' | ')} |`,
      `| ${['---', ...COLS.map(() => '---')].join(' | ')} |`,
      ...rows.map(r =>
        `| ${esc(displayTitle(r.title))} | ${COLS.map(([k]) => esc(r[k])).join(' | ')} |`),
    ]
    let md = lines.join('\n')
    if (overall) md += `\n\n**整体对比**：${overall}`
    navigator.clipboard.writeText(md).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal compare-modal" onClick={e => e.stopPropagation()}>
        <div className="row spread mb8">
          <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Icon name="scale" size={17} /> AI 跨文献对比
            <Tip text="AI 逐篇提取方法 / 数据集 / 核心结论 / 局限并汇总成表；表格下方有整体对比评述。" />
          </h2>
          <div className="row">
            {rows && (
              <button className="btn sm" onClick={toMarkdown}><><Icon name={copied ? "save" : "copy"} size={13} /> {copied ? '已复制' : '复制 Markdown'}</></button>
            )}
            <button className="btn sm" disabled={loading} onClick={() => setNonce(n => n + 1)}>重新生成</button>
            <button className="btn sm" onClick={onClose}><Icon name="x" size={13} /> 关闭</button>
          </div>
        </div>

        {loading && (
          <div className="loading" style={{ padding: '40px 0' }}>
            ⏳ AI 正在对比 {ids.length} 篇文献，可能需要一到两分钟…
          </div>
        )}

        {error && !loading && <div className="err-msg" style={{ marginBottom: 12 }}>{error}</div>}

        {rows && !loading && (
          <>
            <div className="cmp-table-wrap">
              <table className="cmp-table">
                <thead>
                  <tr>
                    <th>论文</th>
                    {COLS.map(([k, label]) => <th key={k}>{label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.paper_id}>
                      <th scope="row">{displayTitle(r.title)}</th>
                      {COLS.map(([k]) => <td key={k}>{r[k]}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {overall && (
              <div className="cmp-overall">
                <strong>整体对比</strong>
                <p>{overall}</p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
