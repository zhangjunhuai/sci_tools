// 选词捕获 + 翻译气泡（内容脚本）

// —— 翻译气泡：接收 background 的结果并展示 ——
let bubbleEl = null

function showBubble(x, y, text, loading = false) {
  hideBubble()
  bubbleEl = document.createElement('div')
  bubbleEl.className = 'kw-translate-bubble'
  const head = document.createElement('div')
  head.className = 'kw-bubble-head'
  const title = document.createElement('span')
  title.textContent = '科研划词翻译'
  const copy = document.createElement('button')
  copy.textContent = '复制'
  copy.className = 'kw-bubble-copy'
  copy.onclick = () => {
    const body = bubbleEl.querySelector('.kw-bubble-body')
    navigator.clipboard.writeText(body.textContent).then(() => {
      copy.textContent = '已复制'
      setTimeout(() => (copy.textContent = '复制'), 1200)
    })
  }
  const close = document.createElement('span')
  close.textContent = '✕'
  close.className = 'kw-bubble-close'
  close.onclick = hideBubble
  head.append(title, copy, close)

  const body = document.createElement('div')
  body.className = 'kw-bubble-body'
  body.textContent = loading ? '翻译中…' : text

  bubbleEl.append(head, body)
  document.documentElement.appendChild(bubbleEl)

  // 位置：贴着鼠标，超出视口就往回收
  const pad = 12
  const rect = bubbleEl.getBoundingClientRect()
  let left = Math.min(x + pad, window.innerWidth - rect.width - 8)
  let top = Math.min(y + pad, window.innerHeight - rect.height - 8)
  bubbleEl.style.left = `${Math.max(8, left)}px`
  bubbleEl.style.top = `${Math.max(8, top)}px`
}

function hideBubble() {
  bubbleEl?.remove()
  bubbleEl = null
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'kw-show-translation') {
    const { x, y, text, error } = msg
    showBubble(x, y, error ? `翻译失败：${error}` : text, false)
  }
})

// —— 划词：mouseup 采集选区，选区旁显示「译」浮动按钮 ——
let btnEl = null
let lastSelection = ''

function hideButton() {
  btnEl?.remove()
  btnEl = null
}

document.addEventListener('mouseup', (e) => {
  // 点在自己的 UI 上不处理
  if (e.target.closest?.('.kw-translate-bubble, .kw-translate-btn')) return
  setTimeout(() => {
    const sel = window.getSelection()
    const text = sel ? sel.toString().trim() : ''
    hideButton()
    if (!text || text.length < 1 || text.length > 4000) return
    const range = sel.getRangeAt(0)
    const rect = range.getBoundingClientRect()
    if (!rect.width && !rect.height) return
    lastSelection = text
    btnEl = document.createElement('div')
    btnEl.className = 'kw-translate-btn'
    btnEl.textContent = '译'
    btnEl.title = 'AI 翻译（也可右键 → 科研划词翻译）'
    btnEl.style.left = `${Math.min(window.innerWidth - 40, rect.right + window.scrollX + 6)}px`
    btnEl.style.top = `${Math.max(window.scrollY + rect.top - 34, window.scrollY + 4)}px`
    btnEl.onclick = (ev) => {
      ev.stopPropagation()
      const bx = rect.right + window.scrollX
      const by = rect.bottom + window.scrollY
      showBubble(bx, by, '', true)
      chrome.runtime.sendMessage({ type: 'kw-translate', text: lastSelection, x: bx, y: by })
      hideButton()
    }
    document.documentElement.appendChild(btnEl)
  }, 10)
})

// ESC 或点击别处收起
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { hideBubble(); hideButton() }
})
