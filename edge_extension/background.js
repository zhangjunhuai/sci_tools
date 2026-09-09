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
  // content script 可能未注入（扩展安装后未刷新的旧标签页）：先补注入
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'kw-ping' })
  } catch {
    try {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content.css'] })
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] })
    } catch (e) {
      // 注入也失败（如 chrome:// 页）：退化为复制译文到剪贴板
      const r = await translate(text)
      if (r.text) {
        // 剪贴板要在页面上下文写；后台不能直接写，提示用户
        chrome.action.setBadgeText({ text: '!' })
        chrome.action.setTitle({ title: `翻译失败：${r.error || '该页面无法注入脚本'}` })
      }
      return
    }
  }
  // 右键路径没有坐标，用视口中心兜底
  const x = Math.round((tab.width || 800) / 2)
  const y = Math.round((tab.height || 600) / 2)
  chrome.tabs.sendMessage(tab.id, { type: 'kw-show-translation', x, y, text: '翻译中…' })
  const r = await translate(text)
  chrome.tabs.sendMessage(tab.id, { type: 'kw-show-translation', x, y, ...r }).catch(() => {})
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
