import { useMemo } from 'react'
import { marked } from 'marked'
import katex from 'katex'
import { api } from '../api'

// 公式/代码占位符：$$...$$、$...$、\[...\]、\(...\)、``` 代码块，渲染前摘出，避免被 marked 破坏
function extractMath(src) {
  const stash = []
  const put = (s) => { stash.push(s); return `\u0000M${stash.length - 1}\u0000` }
  const out = src
    // 代码块/行内代码最先保护（里面的 $ 不算公式）
    .replace(/```[\s\S]*?```|`[^`\n]+`/g, m => put(m))
    .replace(/\$\$[\s\S]+?\$\$/g, m => put(m))          // $$...$$ 块级
    .replace(/\\\[[\s\S]+?\\\]/g, m => put(m))          // \[...\] 块级
    .replace(/\\\([\s\S]+?\\\)/g, m => put(m))          // \(...\) 行内
    .replace(/\$[^\$\n]+?\$/g, m => put(m))             // $...$ 行内
    // [[双链]] 也摘出，避免被 marked 当普通文本吃掉
    .replace(/\[\[([^\]\n]+)\]\]/g, m => put(m))
  return { out, stash }
}

function restoreMath(html, stash) {
  // 把渲染后 HTML 里的占位符替换回真实节点（占位符可能被 marked 拆进文本节点）
  const frag = document.createElement('div')
  frag.innerHTML = html
  const walker = document.createTreeWalker(frag, NodeFilter.SHOW_TEXT)
  const textNodes = []
  while (walker.nextNode()) textNodes.push(walker.currentNode)
  for (const node of textNodes) {
    if (!node.textContent.includes('\u0000M')) continue
    const span = document.createElement('span')
    for (const seg of node.textContent.split(/(\u0000M\d+\u0000)/)) {
      const m = seg.match(/^\u0000M(\d+)\u0000$/)
      if (!m) { span.append(document.createTextNode(seg)); continue }
      const raw = stash[Number(m[1])]
      const el = document.createElement('span')
      const wikilink = raw.match(/^\[\[(.+)\]\]$/)
      try {
        if (wikilink) {
          el.className = 'note-link'
          el.dataset.wikilink = wikilink[1]
          el.textContent = wikilink[1]
        } else if (raw.startsWith('$$') || raw.startsWith('\\[')) {
          const body = raw.slice(2, raw.length - 2)
          el.innerHTML = katex.renderToString(body, { displayMode: true, throwOnError: false })
        } else {
          const body = raw.startsWith('\\(') ? raw.slice(2, -2) : raw.slice(1, -1)
          el.innerHTML = katex.renderToString(body, { displayMode: false, throwOnError: false })
        }
      } catch {
        el.textContent = raw
      }
      span.append(el)
    }
    node.replaceWith(span)
  }
  return frag.innerHTML
}

/**
 * Markdown 渲染：marked + KaTeX 公式 + [[双链]]。
 * 项目笔记/实验记录与文献笔记共用；存储与编辑的始终是 Markdown 源文本。
 */
export default function MarkdownView({ text }) {
  const html = useMemo(() => {
    if (!text) return ''
    try {
      const { out, stash } = extractMath(text)
      marked.setOptions({ breaks: true, gfm: true })
      return restoreMath(marked.parse(out), stash)
    } catch {
      return `<pre>${text.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</pre>`
    }
  }, [text])

  function onClick(e) {
    const t = e.target.closest('.note-link')
    if (!t) return
    const title = t.dataset.wikilink
    api.get(`/papers?q=${encodeURIComponent(title)}&limit=5`).then(d => {
      const hit = d.items.find(p => p.title === title) || (d.items.length === 1 ? d.items[0] : null)
      if (hit) window.location.assign(`/papers/${hit.id}`)
      else alert('库里没有完全匹配的论文')
    }).catch(() => {})
  }

  return <div className="md-view" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
}
