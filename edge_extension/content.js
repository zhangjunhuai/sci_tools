// 选词捕获 + 翻译气泡（内容脚本）
// 定位策略：气泡用 position:fixed，锚定「当前选区」的视口坐标——不受页面滚动/绝对定位干扰。

let bubbleEl = null
let lastSelRect = null // 选区的视口坐标 {left, right, top, bottom}
let lastSelection = ''

function showBubble(text, loading = false) {
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

  // 锚点：选区右下角（视口坐标）；没有选区信息时用视口中心
  const pad = 10
  const vw = window.innerWidth
  const vh = window.innerHeight
  const rect = bubbleEl.getBoundingClientRect()
  const anchor = lastSelRect || { right: vw / 2, bottom: vh / 2 }
  let left = anchor.right + pad
  let top = anchor.bottom + pad
  // 超出视口就翻转/收拢：右侧放不下放选区左侧，下方放不下放上方
  if (left + rect.width > vw - 8) left = Math.max(8, anchor.left - rect.width - pad)
  if (left + rect.width > vw - 8) left = Math.max(8, vw - rect.width - 8)
  if (top + rect.height > vh - 8) top = Math.max(8, anchor.top - rect.height - pad)
  bubbleEl.style.left = `${left}px`
  bubbleEl.style.top = `${top}px`
}

function hideBubble() {
  bubbleEl?.remove()
  bubbleEl = null
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'kw-ping') { sendResponse({ ok: true }); return }
  if (msg.type === 'kw-show-translation') {
    // 坐标由本脚本自己维护的选区决定，忽略 background 传来的 x/y
    showBubble(msg.error ? `翻译失败：${msg.error}` : msg.text, false)
  }
})

// —— 划词：mouseup 采集选区与视口坐标，选区旁显示「译」浮动按钮 ——

let btnEl = null

function hideButton() {
  btnEl?.remove()
  btnEl = null
}

function captureSelection() {
  const sel = window.getSelection()
  const text = sel ? sel.toString().trim() : ''
  if (!text || text.length > 4000 || !sel.rangeCount) { lastSelRect = null; lastSelection = ''; return }
  const rect = sel.getRangeAt(0).getBoundingClientRect()
  if (!rect.width && !rect.height) { lastSelRect = null; return }
  lastSelRect = { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
  lastSelection = text
}

document.addEventListener('mouseup', (e) => {
  if (e.target.closest?.('.kw-translate-bubble, .kw-translate-btn')) return
  setTimeout(() => {
    captureSelection()
    hideButton()
    if (!lastSelection) return
    const rect = lastSelRect
    btnEl = document.createElement('div')
    btnEl.className = 'kw-translate-btn'
    btnEl.textContent = '译'
    btnEl.title = 'AI 翻译（也可右键 → 科研划词翻译）'
    // 「译」按钮也用 fixed，贴选区右上角外侧
    btnEl.style.left = `${Math.min(window.innerWidth - 36, rect.right + 6)}px`
    btnEl.style.top = `${Math.max(4, rect.top - 32)}px`
    btnEl.onclick = (ev) => {
      ev.stopPropagation()
      showBubble('', true)
      chrome.runtime.sendMessage({ type: 'kw-translate', text: lastSelection })
      hideButton()
    }
    document.documentElement.appendChild(btnEl)
  }, 10)
})

// 右键菜单路径：右键时选区仍在，更新一次锚点
document.addEventListener('contextmenu', () => {
  setTimeout(captureSelection, 0)
})

// ESC 或滚动时收起气泡（fixed 定位不随页面滚动，滚走了就该关掉）
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { hideBubble(); hideButton() }
})
window.addEventListener('scroll', hideBubble, { passive: true })
