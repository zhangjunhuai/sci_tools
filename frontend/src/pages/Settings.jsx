import { useEffect, useState } from 'react'
import { api } from '../api'
import Tip from '../components/Tip'
import Icon from '../components/Icon'

const FIELDS = [
  ['api_base_url', 'API 地址（OpenAI 兼容）', 'https://api.openai.com/v1'],
  ['api_key', 'API Key', ''],
  ['chat_model', '对话模型', 'gpt-4o-mini'],
]

// 书签脚本：在期刊页/PDF 页点击，用浏览器自身登录态抓 PDF 传给本地文献库
const BOOKMARKLET_SRC = `(function(){
var BASE='http://127.0.0.1:8210';
function m(n){var e=document.querySelector('meta[name="'+n+'"]');return e?e.content:null;}
var pdfUrl=m('citation_pdf_url');
var isPdf=document.contentType==='application/pdf'||/\\.pdf($|[?#])/.test(location.href);
var doi=m('citation_doi')||m('DC.doi')||m('doi')||(location.href.match(/10\\.\\d{4,9}\\/[\\w.()\\/-]+/)||[''])[0];
var title=(document.title||'').replace(/\\[[^\\]]*\\]\\s*/,'').trim();
function metaOnly(){
if(!doi){alert('文献中心：未找到 PDF 链接或 DOI，无法入库');return;}
fetch(BASE+'/api/papers/add_by_id',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({identifier:doi})})
.then(function(r){return r.json()})
.then(function(d){alert(d.duplicate?'文献中心：该文献已在库中':'文献中心：已入库（未找到可下载的 PDF）');})
.catch(function(){alert('文献中心：请确认本地服务已启动（127.0.0.1:8210）');});
}
if(!pdfUrl&&!isPdf){metaOnly();return;}
var url=isPdf?location.href:pdfUrl;
fetch(url,{credentials:'include'})
.then(function(r){return r.ok?r.blob():Promise.reject('HTTP '+r.status)})
.then(function(b){return b.slice(0,5).text().then(function(t){return t.indexOf('%PDF')===0?b:Promise.reject('返回的不是 PDF（可能无权限）')})})
.then(function(b){
var name=((doi||title||'article').replace(/[^\\w.-]+/g,'_').slice(0,80))+'.pdf';
var fd=new FormData();fd.append('file',b,name);
if(doi)fd.append('doi',doi);
return fetch(BASE+'/api/papers/upload',{method:'POST',body:fd}).then(function(r){return r.json()});
})
.then(function(d){alert('文献中心：已入库「'+(d.title||'')+'」');})
.catch(function(e){if(e==='not pdf'||String(e).indexOf('PDF')>=0){metaOnly();}else{alert('文献中心：请确认本地服务已启动（127.0.0.1:8210）');}});
})();`

export default function Settings() {
  const [form, setForm] = useState(null)
  const [memRefreshing, setMemRefreshing] = useState(false)
  const [saved, setSaved] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null)

  useEffect(() => { api.get('/settings').then(setForm) }, [])

  if (!form) return <div className="loading">加载中…</div>

  function set(k, v) { setForm(f => ({ ...f, [k]: v })); setSaved(false) }

  async function save() {
    const body = { ...form }
    if (!body.api_key || body.api_key === '••••••••') body.api_key = undefined
    await api.patch('/settings', body)
    setSaved(true)
    const fresh = await api.get('/settings')
    setForm(fresh)
  }

  async function test() {
    setTesting(true); setTestResult(null)
    try {
      const r = await api.post('/settings/test')
      setTestResult(r.ok ? `✅ 连通正常：${r.reply}` : `❌ ${r.error}`)
    } catch (e) {
      setTestResult(`❌ ${e.message}`)
    } finally {
      setTesting(false)
    }
  }

  return (
    <div style={{ maxWidth: 720 }}>
      <div className="page-head"><h1>设置</h1></div>

      <div className="card mb16">
        <strong className="mb16">
          AI 接口（OpenAI 兼容格式）
          <Tip text="支持 OpenAI / DeepSeek / 各类 OpenAI 兼容中转。Anthropic 原生接口不兼容此格式，请用兼容网关或其他服务商。配置后点「测试连通」验证。" />
        </strong>
        {FIELDS.map(([key, label]) => (
          <div className="form-row" key={key}>
            <label>{label}</label>
            <input
              type={key === 'api_key' ? 'password' : 'text'}
              value={form[key] || ''}
              placeholder={key === 'api_key' && form.api_key_set ? '已配置（输入可覆盖）' : ''}
              onChange={e => set(key, e.target.value)}
            />
          </div>
        ))}
        <div className="form-row">
          <label>
            推理深度（思考类模型提速）
            <Tip text="深度思考模型（如 GLM、o 系列）回答前会先「思考」，划词翻译会明显变慢。设为 low 是思考模型的最快档；非思考模型会自动忽略此参数，不影响使用。" />
          </label>
          <select value={form.reasoning_effort ?? 'low'} onChange={e => set('reasoning_effort', e.target.value)}>
            <option value="low">low（推荐：思考模型最快档）</option>
            <option value="minimal">minimal</option>
            <option value="medium">medium</option>
            <option value="high">high（质量最好、最慢）</option>
            <option value="">不设置（跟随服务商默认）</option>
          </select>
        </div>
        <div className="row">
          <button className="btn primary" onClick={save}>{saved ? '已保存 ✓' : '保存'}</button>
          <button className="btn" onClick={test} disabled={testing}>{testing ? '测试中…' : '测试连通'}</button>
          {testResult && <span className="muted">{testResult}</span>}
        </div>
      </div>

      <div className="card mb16">
        <strong className="mb16">
          研究方向
          <Tip text="AI 自动打标签、生成摘要、订阅打分都以这段描述为准，请保持具体（如列出关注的细胞类型和算法）。" />
        </strong>
        <div className="form-row">
          <textarea rows={3} value={form.research_interests || ''} onChange={e => set('research_interests', e.target.value)} />
        </div>
        <div className="form-row">
          <label>
            标签体系（逗号分隔）
            <Tip text="AI 自动打标签时优先从中选，留空则自由拟定。建议放固定研究方向词，如：网格细胞, 位置细胞, SNN, SLAM。" />
          </label>
          <input type="text" value={form.tag_preset || ''} onChange={e => set('tag_preset', e.target.value)} />
        </div>
      </div>

      <div className="card mb16">
        <strong className="mb16">arXiv 抓取配置</strong>
        <div className="form-row">
          <label>关注分类（逗号分隔）</label>
          <input type="text" value={form.arxiv_categories || ''} onChange={e => set('arxiv_categories', e.target.value)} />
        </div>
        <div className="form-row">
          <label>
            关键词（逗号分隔）
            <Tip text="标题或摘要命中任一关键词即保留；留空则只按分类抓最新。抓取与关键词在 arXiv 全字段取交集搜索。" />
          </label>
          <input type="text" value={form.arxiv_keywords || ''} onChange={e => set('arxiv_keywords', e.target.value)} />
        </div>
        <div className="form-row">
          <label>每次抓取条数上限</label>
          <input type="number" value={form.arxiv_max_results || ''} onChange={e => set('arxiv_max_results', e.target.value)} />
        </div>
        <button className="btn primary" onClick={save}>{saved ? '已保存 ✓' : '保存'}</button>
      </div>

      <div className="card mb16">
        <strong className="mb16">
          浏览器一键入库（订阅期刊 PDF）
          <Tip text="把按钮拖到浏览器书签栏。在期刊文章页或 PDF 页点击，会用浏览器当前登录态（校园网订阅）抓 PDF 入库；识别不到 PDF 时按 DOI 只存元数据。" />
        </strong>
        <div className="row" style={{ flexWrap: 'wrap', margin: '10px 0' }}>
          <a
            href={`javascript:${encodeURIComponent(BOOKMARKLET_SRC)}`}
            onClick={e => e.preventDefault()}
            className="btn primary"
            style={{ cursor: 'move' }}
            title="按住拖到浏览器书签栏"
          >
            📥 存入文献中心
          </a>
          <button className="btn" onClick={() => { navigator.clipboard.writeText(BOOKMARKLET_SRC); alert('脚本代码已复制，可手动新建书签粘贴到网址栏'); }}>
            复制脚本代码
          </button>
        </div>
        <p className="muted">
          用法：① 打开有权限下载的期刊文章页 → ② 点书签「存入文献中心」→ ③ 弹窗提示已入库，PDF 与元数据一并保存。
          如果点完提示"未找到 PDF"，说明该站没暴露标准 PDF 链接——先手动点进 PDF 页再点一次书签即可。
        </p>
      </div>

      <div className="card mb16">
        <div className="row spread mb8">
          <strong className="row" style={{ gap: 5 }}>
            研究记忆摘要
            <Tip text="AI 每周自动根据你的文献库、项目和 AI 问答历史更新这份摘要；打分与 AI 问答会参考它提供个性化回答。可以直接手动编辑，修改后下次自动刷新会以其为基础修订。" />
          </strong>
          <div className="row">
            {form?.memory_updated_at && <span className="muted" style={{ fontSize: 12.5 }}>更新于 {form.memory_updated_at}</span>}
            <button className="btn sm" disabled={memRefreshing}
              onClick={async () => {
                setMemRefreshing(true)
                try {
                  await api.post('/memory/refresh')
                  setTimeout(async () => {
                    setForm(await api.get('/settings'))
                    setMemRefreshing(false)
                  }, 20000)
                } catch { setMemRefreshing(false) }
              }}>
              <Icon name="refresh" size={13} /> {memRefreshing ? '刷新中…' : '立即刷新'}
            </button>
          </div>
        </div>
        {form?.memory_summary ? (
          <textarea rows={9} style={{ width: '100%', fontSize: 13.5, lineHeight: 1.7 }}
            value={form.memory_summary}
            onChange={e => { set('memory_summary', e.target.value) }} />
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            尚未生成。配置 API Key 后，AI 会在每次启动检查（超过 7 天未更新时自动刷新），
            或点右上角「立即刷新」现在生成。刷新依据：文献库（标签/新入库）、项目、最近 AI 问答。
          </p>
        )}
      </div>

      <div className="card">
        <strong className="mb16">
          数据说明
          <Tip text="所有数据存放在 backend/data/ 目录（SQLite 数据库 + PDF 文件），完全本地；备份该目录即备份全部数据。" />
        </strong>
      </div>
    </div>
  )
}
