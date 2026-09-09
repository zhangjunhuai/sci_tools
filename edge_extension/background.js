// 后台：右键菜单 + 调文献库后端 /api/ai/translate（服务端持有 API Key，扩展不存密钥）
const DEFAULT_BASE = 'http://127.0.0.1:8210'

async function getBase() {
  const { apiBase } = await chrome.storage.sync.get({ apiBase: DEFAULT_BASE })
  return (apiBase || DEFAULT_BASE).replace(/\/+$/, '')
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'kw-translate',
    title: '科研划词翻译「%s」',
    contexts: ['selection'],
  })
})

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'kw-translate' || !tab?.id) return
  const text = (info.selectionText || '').trim()
  if (!text) return
  // 右键路径没有 content script 传来的坐标，用视口中心兜底
  const x = Math.round((tab.width || 800) / 2)
  const y = Math.round((tab.height || 600) / 2)
  chrome.tabs.sendMessage(tab.id, { type: 'kw-show-translation', x, y, text: '翻译中…' })
  const r = await translate(text)
  chrome.tabs.sendMessage(tab.id, { type: 'kw-show-translation', x, y, ...r })
})

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'kw-translate') return
  translate(msg.text).then((r) => {
    chrome.tabs.sendMessage(sender.tab.id, { type: 'kw-show-translation', x: msg.x, y: msg.y, ...r })
  })
  return true // 异步 sendResponse
})

async function translate(text) {
  try {
    const base = await getBase()
    const resp = await fetch(`${base}/api/ai/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    const data = await resp.json().catch(() => ({}))
    if (!resp.ok) return { error: data.detail || `HTTP ${resp.status}` }
    return { text: data.translation ?? data.answer ?? '(空)' }
  } catch (e) {
    return { error: `连不上文献库后端：${e.message}` }
  }
}
