/**
 * 离线测试：适配器契约 + SSE 解析 + 自定义渠道。
 * Run: node test/verify-adapter.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'

// 隔离 DSH_HOME：避免读到用户真实保存的渠道 key，保证离线测试可重复
const ISOLATED_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-test-'))
process.env.DSH_HOME = ISOLATED_HOME
process.on('exit', () => { try { fs.rmSync(ISOLATED_HOME, { recursive: true, force: true }) } catch { /* ignore */ } })

const fail = (m) => { console.error('FAIL: ' + m); process.exitCode = 1 }

let registered = null
const allRegistrations = []
const fake = {
  logger: { info: () => {}, warn: () => {} },
  llm: {
    // 插件会逐个渠道注册，收集全部；registered 保留第一个（主渠道）
    registerAdapter(providers, adapter) {
      if (!registered) registered = { providers, adapter }
      allRegistrations.push({ providers, adapter })
      return { dispose() {} }
    },
    registerConfigurableProviders() {},
  },
  inject(deps, cb) { cb(fake); return () => {} },
  get(name) { return fake[name] },
}

const dispose = apply(fake, {
  providers: [
    {
      id: 'groq',
      name: 'Groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: 'test-key',
      models: [{ id: 'llama-3.3-70b', name: 'Llama 3.3 (Groq)', contextWindow: 128000, maxOutputTokens: 8192 }],
    },
  ],
})

const allProviderIds = allRegistrations.flatMap((r) => r.providers)
if (!registered) fail('未注册适配器')
else {
  const a = registered.adapter
  if (!allProviderIds.includes('pollinations')) fail('应包含内置 pollinations 渠道')
  if (!allProviderIds.includes('groq')) fail('应包含配置里的 groq 渠道')

  const models = await a.listModels()
  if (models.length !== 3) fail('模型数应为 3（pollinations 2 + groq 1），实际 ' + models.length)
  const fast = models.find((m) => m.id === 'openai-fast')
  if (!fast) fail('缺少 openai-fast')
  if (!models.every((m) => Array.isArray(m.inputModalities))) fail('listModels 缺 inputModalities')

  const rm = await a.resolveModel('pollinations', 'openai-fast')
  if (!rm.context || rm.context.contextWindow !== 128000) fail('resolveModel context 不对: ' + JSON.stringify(rm.context))
  if (!rm.defaultMaxTokens) fail('resolveModel defaultMaxTokens 缺失')

  // 自定义渠道的 baseUrl / key 必须被用到
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization })
    const sse = [
      'data: {"choices":[{"delta":{"content":"你"}}]}',
      'data: {"choices":[{"delta":{"content":"好"},"finish_reason":"stop"}]}',
      'data: {"usage":{"prompt_tokens":10,"completion_tokens":2}}',
      'data: [DONE]',
      '',
    ].join('\n')
    return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }
  try {
    const chunks = []
    for await (const c of a.stream({ model: 'llama-3.3-70b', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })) {
      chunks.push(c)
    }
    const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
    if (text !== '你好') fail('文本增量不对: ' + JSON.stringify(text))
    if (!chunks.some((c) => c.type === 'block-start' && c.blockType === 'text')) fail('缺 block-start')
    if (!chunks.some((c) => c.type === 'block-end')) fail('缺 block-end')
    const usage = chunks.find((c) => c.type === 'usage')
    if (!usage || usage.usage.inputTokens !== 10) fail('usage 不对: ' + JSON.stringify(usage))
    if (!chunks.some((c) => c.type === 'finish')) fail('缺 finish')
    if (calls[0].url !== 'https://api.groq.com/openai/v1/chat/completions') fail('baseUrl 用错: ' + calls[0].url)
    if (calls[0].auth !== 'Bearer test-key') fail('apiKey 未生效: ' + calls[0].auth)

    // 请求体必须带上裸模型名（不带 provider 前缀）
    // eslint-disable-next-line no-undef
  } finally {
    globalThis.fetch = realFetch
  }
}

if (typeof dispose !== 'function') fail('apply 必须返回清理函数')
dispose()

// ---- 7. 预置模板：填了 key 才激活，没填不注册 ----
{
  const { apply: applyAgain } = await import('../index.js')
  const collect = (cfg) => {
    const ids = []
    const ctx2 = {
      logger: { info: () => {}, warn: () => {} },
      llm: {
        registerAdapter(p) { ids.push(...p); return { dispose() {} } },
        registerConfigurableProviders() {},
      },
      inject(d, cb) { cb(ctx2); return () => {} },
      get(n) { return ctx2[n] },
    }
    applyAgain(ctx2, cfg)()
    return ids
  }
  const withoutKey = collect({ providers: [{ id: 'groq', apiKey: '' }] })
  if (withoutKey.includes('groq')) fail('没填 key 的模板不该注册成渠道')
  const withKey = collect({ providers: [{ id: 'groq', apiKey: 'gsk_test' }] })
  if (!withKey.includes('groq')) fail('填了 key 的模板应激活')
  if (!withKey.includes('pollinations')) fail('免密钥渠道应始终存在')
  if (withKey.length !== 2) fail('应为 pollinations + groq 两个渠道，实际 ' + JSON.stringify(withKey))
}

// ---- 8. 设置页 API：保存 Key 落盘后立即重注册 ----
{
  const os = await import('node:os')
  const pathMod = await import('node:path')
  const fsMod = await import('node:fs')
  const home = fsMod.mkdtempSync(pathMod.join(os.tmpdir(), 'fm-keys-'))
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const { apply: applyAgain } = await import('../index.js')
    const registeredIds = []
    const routes = []
    const ctx3 = {
      logger: { info: () => {}, warn: () => {} },
      llm: {
        registerAdapter(p) { registeredIds.push(...p); return { dispose() {} } },
        registerConfigurableProviders() {},
      },
      webServer: { register(r) { routes.push(r); return () => {} } },
      inject(d, cb) { cb(ctx3); return () => {} },
      get(n) { return ctx3[n] },
    }
    applyAgain(ctx3, {})
    const route = routes.find((r) => r.path === '/api/free-models')
    if (!route) fail('设置页 API 路由未注册')

    const call = async (method, path, body) => {
      let status = 0, out = ''
      const req = {
        method, url: path,
        async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(JSON.stringify(body)) },
      }
      await route.handler(req, {
        writeHead(c) { status = c },
        end(text) { out = String(text) },
      })
      return { status, body: JSON.parse(out) }
    }

    const before = await call('GET', '/api/free-models/status')
    if (before.status !== 200 || !before.body.ok) fail('status 接口不对')
    if (!Array.isArray(before.body.available) || before.body.available.length < 7) fail('应列出 7 个可开启渠道')

    const saved = await call('POST', '/api/free-models/keys', { id: 'groq', apiKey: 'gsk_test_key' })
    if (saved.status !== 200 || !saved.body.ok) fail('保存 Key 失败: ' + JSON.stringify(saved.body))
    if (!registeredIds.includes('groq')) fail('保存后应立即重注册 groq 渠道')
    const groq = saved.body.active.find((p) => p.id === 'groq')
    if (!groq || !groq.configured) fail('保存后 groq 应显示为已配置')
    // 密钥绝不能出现在任何响应里
    if (JSON.stringify(saved.body).includes('gsk_test_key')) fail('响应里泄露了密钥')

    const keys = JSON.parse(fsMod.readFileSync(pathMod.join(home, 'free-models', 'keys.json'), 'utf8'))
    if (keys.groq !== 'gsk_test_key') fail('密钥未落盘')

    const removed = await call('POST', '/api/free-models/keys', { id: 'groq', apiKey: '' })
    if (removed.status !== 200 || removed.body.active.some((p) => p.id === 'groq')) fail('移除 Key 后应取消该渠道')
    if (JSON.parse(fsMod.readFileSync(pathMod.join(home, 'free-models', 'keys.json'), 'utf8')).groq) fail('密钥未删除')
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    fsMod.rmSync(home, { recursive: true, force: true })
  }
}

// ---- 9. 上游错误翻译：输入超长要给人话，不丢原始 JSON ----
{
  const { explainUpstreamError } = await import('../index.js')
  const raw = '{"code":20015,"message":"number of input tokens (341246) has exceeded max_prompt_tokens (131072) limit.","data":null}'
  const m = explainUpstreamError('siliconflow', 400, raw)
  if (!/输入超长/.test(m)) fail('应识别为输入超长，实际: ' + m)
  if (!m.includes('341,246')) fail('应带上实际 token 数，实际: ' + m)
  if (!m.includes('131,072')) fail('应带上模型上限，实际: ' + m)
  if (!/新会话|长上下文/.test(m)) fail('应给出可执行建议，实际: ' + m)
  if (!explainUpstreamError('groq', 400, '{"error":{"message":"context_length_exceeded"}}').includes('上下文上限')) {
    fail('通用超长文案也应识别')
  }
  const generic = explainUpstreamError('groq', 401, '{"error":{"message":"invalid api key"}}')
  if (!generic.includes('HTTP 401') || !generic.includes('invalid api key')) fail('普通错误应保留原文，实际: ' + generic)
}

console.log(JSON.stringify({ ok: !process.exitCode }, null, 2))
