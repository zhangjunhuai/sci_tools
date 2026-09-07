import { forwardRef, useMemo, useRef } from 'react'

/* 轻量 LaTeX 语法高亮：正则分词 → HTML。支持注释/命令/参数/数学/花括号。 */
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }
const esc = s => s.replace(/[&<>]/g, c => ESC[c])

function highlightLatex(src) {
  if (!src) return ''
  const out = []
  let i = 0
  const n = src.length
  while (i < n) {
    const ch = src[i]
    // 注释到行尾（\% 转义不算）
    if (ch === '%' && src[i - 1] !== '\\') {
      const end = src.indexOf('\n', i)
      const stop = end === -1 ? n : end
      out.push(`<span class="tk-cm">${esc(src.slice(i, stop))}</span>`)
      i = stop
      continue
    }
    // 数学环境 $$...$$、\[...\]
    const two = src.slice(i, i + 2)
    if (two === '$$' || two === '\\[') {
      const close = two === '$$' ? '$$' : '\\]'
      const end = src.indexOf(close, i + 2)
      const stop = end === -1 ? n : end + close.length
      out.push(`<span class="tk-math">${esc(src.slice(i, stop))}</span>`)
      i = stop
      continue
    }
    // 行内数学 $...$、\(...\)
    if (ch === '$' || two === '\\(') {
      const close = ch === '$' ? '$' : '\\)'
      const end = src.indexOf(close, i + close.length)
      const stop = end === -1 ? n : end + close.length
      out.push(`<span class="tk-math">${esc(src.slice(i, stop))}</span>`)
      i = stop
      continue
    }
    // 命令 \name（含 \begin{env} 环境名单独上色由参数规则处理）
    if (ch === '\\' && /[a-zA-Z]/.test(src[i + 1] || '')) {
      let j = i + 1
      while (j < n && /[a-zA-Z*]/.test(src[j])) j++
      out.push(`<span class="tk-cmd">${esc(src.slice(i, j))}</span>`)
      i = j
      continue
    }
    // 花括号参数 {…}（单个嵌套层级内普通文本）
    if (ch === '{') {
      let depth = 1, j = i + 1
      while (j < n && depth > 0) {
        if (src[j] === '{') depth++
        else if (src[j] === '}') depth--
        else if (src[j] === '%') { j = src.indexOf('\n', j); if (j === -1) { j = n; break } }
        j++
      }
      out.push(`<span class="tk-br">${esc('{')}</span><span class="tk-arg">${esc(src.slice(i + 1, j - 1))}</span>${j > i ? `<span class="tk-br">${esc('}')}</span>` : ''}`)
      i = j
      continue
    }
    // 普通文本（吃到下一个特殊字符）
    let j = i + 1
    while (j < n && !'{}$%\\'.includes(src[j])) j++
    out.push(esc(src.slice(i, j)))
    i = j
  }
  return out.join('')
}

/**
 * 带语法高亮的源码编辑区：透明 textarea 叠在高亮 pre 上。
 * 字体/行高/内边距必须完全一致；滚动与选区由 textarea 承担。
 */
const CodeArea = forwardRef(function CodeArea({ value, onChange, placeholder, className = '', onSelect }, ref) {
  const preRef = useRef(null)
  const html = useMemo(() => highlightLatex(value) + '\n', [value])

  function syncScroll(e) {
    if (preRef.current) {
      preRef.current.scrollTop = e.target.scrollTop
      preRef.current.scrollLeft = e.target.scrollLeft
    }
  }

  return (
    <div className={`codearea ${className}`}>
      <pre ref={preRef} className="codearea-hl" aria-hidden="true" dangerouslySetInnerHTML={{ __html: html }} />
      <textarea
        ref={ref} value={value} placeholder={placeholder}
        className="codearea-ta" spellCheck={false}
        onChange={onChange} onScroll={syncScroll} onSelect={onSelect}
      />
    </div>
  )
})

export default CodeArea
