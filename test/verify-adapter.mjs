/**
 * 离线测试：适配器契约 + SSE 解析 + 自定义渠道。
 * Run: node test/verify-adapter.mjs
 */
import { apply } from '../index.js'

const fail = (m) => { console.error('FAIL: ' + m); process.exitCode = 1 }

let registered = null
const fake = {
  logger: { info: () => {}, warn: () => {} },
  llm: {
    registerAdapter(providers, adapter) {
      registered = { providers, adapter }
      return { dispose() { registered = null } }
    },
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

if (!registered) fail('未注册适配器')
else {
  const a = registered.adapter
  if (!registered.providers.includes('pollinations')) fail('应包含内置 pollinations 渠道')
  if (!registered.providers.includes('groq')) fail('应包含配置里的 groq 渠道')

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

console.log(JSON.stringify({ ok: !process.exitCode }, null, 2))
