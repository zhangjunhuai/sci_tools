const input = document.getElementById('apiBase')
const msg = document.getElementById('msg')

chrome.storage.sync.get({ apiBase: 'http://127.0.0.1:8210' }, ({ apiBase }) => {
  input.value = apiBase
})

document.getElementById('save').onclick = async () => {
  const base = input.value.trim().replace(/\/+$/, '') || 'http://127.0.0.1:8210'
  await chrome.storage.sync.set({ apiBase: base })
  // 顺手测一下连通性
  try {
    const r = await fetch(`${base}/api/health`)
    msg.textContent = r.ok ? '已保存，连接正常 ✓' : `已保存，但健康检查返回 ${r.status}`
    msg.style.color = r.ok ? '#16a34a' : '#dc2626'
  } catch (e) {
    msg.textContent = `已保存，但连不上：${e.message}`
    msg.style.color = '#dc2626'
  }
  setTimeout(() => (msg.textContent = ''), 3000)
}
