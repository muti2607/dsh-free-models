/**
 * dsh-free-models —— 免密钥 / 自带 Key 的免费模型接入。
 *
 * 设计取舍：
 *   · 不复制 OFM 的 76 家登记表，只做「任意 OpenAI 兼容端点」这一件事；
 *   · 默认预置一个**真的免密钥可用**的端点（pollinations），装完即可选；
 *   · 其它免费渠道（Groq / Cerebras / Gemini / 硅基流动 / Ollama 等）
 *     通过 config.providers 填 baseUrl + apiKey 即可接入，无需改代码。
 *
 * 所有上游都按 OpenAI Chat Completions 协议（SSE 流式）。
 */

const LOG_PREFIX = '[free-models]'

/**
 * 预置渠道目录。
 *
 * `keyless: true` 的会直接注册（实测可用）；其余只作为「填 key 即开」的模板，
 * 不注册成渠道——免得选择器里塞满一按就 401 的死条目。
 * 实测（2026-11-08，国内直连）：只有 pollinations 真正免密钥；
 * airforce / chatanywhere 返回 401，llm7 / freegpt / aicode 连接超时，
 * binjie / naga / gpt-load 已失效，openai-hk 502。
 */
const BUILTIN_PROVIDERS = [
  {
    id: 'pollinations',
    name: 'Pollinations (免密钥)',
    baseUrl: 'https://text.pollinations.ai/openai',
    apiKey: '',
    keyless: true,
    website: 'https://text.pollinations.ai',
    models: [
      { id: 'openai-fast', name: 'OpenAI Fast (Pollinations)', contextWindow: 128000, maxOutputTokens: 8192 },
      { id: 'openai', name: 'OpenAI (Pollinations)', contextWindow: 128000, maxOutputTokens: 8192 },
    ],
  },
]

/** 需要用户自己填 Key 的免费额度渠道（只做模板，不注册）。 */
const PRESET_TEMPLATES = [
  {
    id: 'groq', name: 'Groq (免费额度)',
    baseUrl: 'https://api.groq.com/openai/v1',
    website: 'https://console.groq.com/keys',
    models: [
      { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B (Groq)', contextWindow: 128000, maxOutputTokens: 32768 },
      { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B (Groq)', contextWindow: 128000, maxOutputTokens: 8192 },
    ],
  },
  {
    id: 'cerebras', name: 'Cerebras (免费额度)',
    baseUrl: 'https://api.cerebras.ai/v1',
    website: 'https://cloud.cerebras.ai',
    models: [
      { id: 'llama-3.3-70b', name: 'Llama 3.3 70B (Cerebras)', contextWindow: 128000, maxOutputTokens: 32768 },
      { id: 'qwen-3-32b', name: 'Qwen 3 32B (Cerebras)', contextWindow: 128000, maxOutputTokens: 16384 },
    ],
  },
  {
    id: 'gemini', name: 'Google Gemini (免费额度)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    website: 'https://aistudio.google.com/apikey',
    models: [
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', contextWindow: 1000000, maxOutputTokens: 65536 },
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', contextWindow: 1000000, maxOutputTokens: 65536 },
    ],
  },
  {
    id: 'siliconflow', name: '硅基流动 (部分模型免费)',
    baseUrl: 'https://api.siliconflow.cn/v1',
    website: 'https://cloud.siliconflow.cn/account/ak',
    models: [
      { id: 'Qwen/Qwen3-8B', name: 'Qwen3 8B (免费)', contextWindow: 32768, maxOutputTokens: 8192 },
      { id: 'THUDM/glm-4-9b-chat', name: 'GLM-4-9B (免费)', contextWindow: 32768, maxOutputTokens: 8192 },
    ],
  },
  {
    id: 'modelscope', name: '魔搭 ModelScope (每日免费)',
    baseUrl: 'https://api-inference.modelscope.cn/v1',
    website: 'https://modelscope.cn/my/myaccesstoken',
    models: [
      { id: 'Qwen/Qwen3-8B', name: 'Qwen3 8B (ModelScope)', contextWindow: 32768, maxOutputTokens: 8192 },
    ],
  },
  {
    id: 'openrouter', name: 'OpenRouter (:free 模型免费)',
    baseUrl: 'https://openrouter.ai/api/v1',
    website: 'https://openrouter.ai/keys',
    models: [
      { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Llama 3.3 70B free', contextWindow: 128000, maxOutputTokens: 16384 },
      { id: 'google/gemini-2.0-flash-exp:free', name: 'Gemini 2.0 Flash free', contextWindow: 1000000, maxOutputTokens: 8192 },
    ],
  },
  {
    id: 'ollama', name: '本地 Ollama (完全免费)',
    baseUrl: 'http://127.0.0.1:11434/v1',
    website: 'https://ollama.com',
    models: [
      { id: 'qwen3:8b', name: 'Qwen3 8B (本地)', contextWindow: 32768, maxOutputTokens: 8192 },
    ],
  },
]

/**
 * 合并渠道：
 *  · 免密钥的预置渠道直接注册；
 *  · 配置里给了 apiKey 的模板渠道也注册（预置模板自动补全 baseUrl / models）；
 *  · 配置项还可以是全新的自定义端点。
 */
function resolveProviders(cfg) {
  const custom = Array.isArray(cfg.providers) ? cfg.providers : []
  const byId = new Map()
  for (const p of BUILTIN_PROVIDERS) byId.set(p.id, { ...p, builtin: true, active: true })
  for (const raw of custom) {
    if (!raw || typeof raw !== 'object' || !raw.id) continue
    const id = String(raw.id)
    const preset = PRESET_TEMPLATES.find((t) => t.id === id)
    const key = String(raw.apiKey || '').trim()
    // 预置模板没给 key 就跳过，避免选择器里出现一按就 401 的死条目
    if (preset && !key) continue
    const baseUrl = String(raw.baseUrl || (preset && preset.baseUrl) || '').replace(/\/+$/, '')
    if (!baseUrl) continue
    const existing = byId.get(id)
    byId.set(id, {
      id,
      name: String(raw.name || (preset && preset.name) || (existing && existing.name) || id),
      baseUrl,
      apiKey: key,
      models: Array.isArray(raw.models) && raw.models.length
        ? raw.models.filter((m) => m && m.id)
        : (preset ? preset.models : (existing ? existing.models : [])),
      website: String((preset && preset.website) || (existing && existing.website) || ''),
      builtin: !!existing,
      active: true,
    })
  }
  return [...byId.values()].filter((p) => p.active)
}

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * 读 OpenAI 风格 SSE，产出 Harness 的 StreamChunk 序列。
 * 与 dsh-codebuddy 的 consumeSse 同构，但去掉了工具调用块的特殊处理之外的多余分支。
 */
async function* readSse(response, signal) {
  if (!response.body) throw new Error('free-models: 空响应体')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let index = 0
  let prose = null
  let usage = null
  let finishReason = ''

  const closeProse = () => {
    if (!prose) return null
    const block = prose
    prose = null
    return { type: 'block-end', index: block.index, block: { type: block.type, text: block.text } }
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl = buffer.indexOf('\n')
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        nl = buffer.indexOf('\n')
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        let chunk
        try { chunk = JSON.parse(payload) } catch { continue }

        if (chunk.usage && typeof chunk.usage === 'object') usage = chunk.usage
        const choice = chunk.choices && chunk.choices[0]
        if (!choice) continue
        const delta = choice.delta || {}
        if (choice.finish_reason) finishReason = String(choice.finish_reason)

        const text = delta.content
        if (typeof text === 'string' && text.length > 0) {
          if (!prose || prose.type !== 'text') {
            const closed = closeProse()
            if (closed) yield closed
            prose = { type: 'text', index: index++, text: '' }
            yield { type: 'block-start', index: prose.index, blockType: 'text' }
          }
          prose.text += text
          yield { type: 'text-delta', index: prose.index, text }
        }
      }
    }
  } finally {
    try { reader.releaseLock() } catch { /* ignore */ }
  }

  const closed = closeProse()
  if (closed) yield closed

  if (usage) {
    const input = num(usage.prompt_tokens)
    const output = num(usage.completion_tokens)
    const cacheRead = num(usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens)
    yield {
      type: 'usage',
      usage: {
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: 0,
        ...(num(usage.completion_tokens_details && usage.completion_tokens_details.reasoning_tokens)
          ? { reasoningTokens: num(usage.completion_tokens_details.reasoning_tokens) } : {}),
      },
    }
  }
  yield { type: 'finish', finish: finishReason === 'length' ? { kind: 'max-tokens' } : { kind: 'stop' } }
}

/** 把 DSH 消息折成 OpenAI 线格式（纯文本；免费端点普遍不支持图片）。 */
function serializeMessages(messages) {
  const wire = []
  for (const message of messages || []) {
    if (!message || typeof message !== 'object') continue
    const blocks = Array.isArray(message.content) ? message.content : []
    const text = blocks.filter((b) => b && b.type === 'text').map((b) => String(b.text || '')).join('')
    const toolCalls = blocks.filter((b) => b && b.type === 'tool-call')
    if (message.role === 'assistant') {
      if (toolCalls.length > 0) {
        wire.push({
          role: 'assistant',
          content: text || null,
          tool_calls: toolCalls.map((b) => ({
            id: String(b.id || ''),
            type: 'function',
            function: { name: String(b.name || ''), arguments: typeof b.arguments === 'string' ? b.arguments : JSON.stringify(b.arguments || {}) },
          })),
        })
      } else if (text) wire.push({ role: 'assistant', content: text })
      continue
    }
    if (message.role === 'tool') {
      for (const b of blocks) {
        if (!b || b.type !== 'tool-result') continue
        const inner = Array.isArray(b.content) ? b.content.filter((x) => x && x.type === 'text').map((x) => String(x.text || '')).join('') : ''
        wire.push({ role: 'tool', tool_call_id: String(b.toolCallId || message.toolCallId || ''), content: inner })
      }
      continue
    }
    if (text) wire.push({ role: message.role === 'system' ? 'system' : 'user', content: text })
  }
  return wire
}

export function apply(ctx, config) {
  const cfg = config && typeof config === 'object' ? config : {}
  const providers = resolveProviders(cfg)
  const logger = ctx.logger || console

  if (providers.length === 0) {
    logger.warn?.(LOG_PREFIX + ' 没有可用渠道')
    return () => {}
  }

  const adapter = {
    providerInfo(provider) {
      const found = providers.find((p) => p.id === provider)
      return { id: provider || providers[0].id, name: found ? found.name : 'Free Models' }
    },

    // 失败补发一次即可：免费端点多是限流/超时，重试太多次只会放大调用量
    providerRetryPolicy() {
      return Object.freeze({
        mode: 'normal',
        maxRetries: 1,
        retryableCodes: Object.freeze(['EMPTY_RESPONSE', 'SERVER', 'TIMEOUT', 'TRANSPORT']),
        initialDelayMs: 800,
        maxDelayMs: 6000,
        jitterRatio: 0.2,
      })
    },

    imageRequestPricing() { return undefined },
    imageRequestTarget(_provider, _model, image) {
      return { width: image?.width ?? 0, height: image?.height ?? 0, maxBytes: image?.bytes ?? 0 }
    },

    async listModels(provider) {
      const list = provider ? providers.filter((p) => p.id === provider) : providers
      const out = []
      for (const p of list) {
        for (const m of p.models) {
          out.push({ provider: p.id, id: m.id, name: m.name || m.id, inputModalities: ['text'] })
        }
      }
      return out
    },

    async resolveModel(provider, model) {
      const p = providers.find((x) => x.id === provider) || providers[0]
      // 模型 id 用裸名（`openai-fast`），渠道由 provider 字段承载，
      // 否则界面上会显示成 `pollinations/pollinations/openai-fast`。
      const id = String(model || '').replace(new RegExp('^' + p.id + '/'), '')
      const m = p.models.find((x) => x.id === id) || p.models[0]
      const out = { provider: p.id, id: m ? m.id : id, name: (m && m.name) || id, inputModalities: ['text'] }
      if (m && num(m.contextWindow)) out.context = { contextWindow: num(m.contextWindow) }
      if (m && num(m.maxOutputTokens)) out.defaultMaxTokens = num(m.maxOutputTokens)
      return out
    },

    async prepareCall(provider, model) {
      const resolved = await this.resolveModel(provider, model)
      return { model: resolved, stream: (options) => streamCall(provider, resolved.id, options) }
    },

    async *stream(options) {
      const raw = String((options && options.model) || '')
      // 先按裸 id 找渠道；兼容调用方传 `provider/model` 的旧写法
      let pid = providers.find((p) => p.models.some((m) => m.id === raw))?.id
      if (!pid) pid = providers.find((p) => raw.startsWith(p.id + '/'))?.id
      yield* streamCall(pid || providers[0].id, raw, options)
    },
  }

  async function* streamCall(providerId, modelId, options) {
    const p = providers.find((x) => x.id === providerId) || providers[0]
    const bare = String(modelId || '').replace(new RegExp('^' + p.id + '/'), '')
    const header = { 'Content-Type': 'application/json', 'User-Agent': 'dsh-free-models/1.0' }
    if (p.apiKey) header.Authorization = 'Bearer ' + p.apiKey

    const body = {
      model: bare,
      messages: serializeMessages(options.messages),
      stream: true,
    }
    if (Array.isArray(options.tools) && options.tools.length > 0) {
      body.tools = options.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
    }
    const maxTokens = num(options.maxTokens)
    if (maxTokens) body.max_tokens = maxTokens

    const response = await fetch(p.baseUrl + '/chat/completions', {
      method: 'POST', headers: header, body: JSON.stringify(body), signal: options.signal,
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`free-models: ${p.id} HTTP ${response.status} ${text.slice(0, 200)}`)
    }
    yield* readSse(response, options.signal)
  }

  let dispose = () => {}
  ctx.inject(['llm'], (scoped) => {
    const llm = scoped && scoped.llm ? scoped.llm : ctx.get('llm')
    if (!llm || typeof llm.registerAdapter !== 'function') return () => {}
    const handle = llm.registerAdapter(providers.map((p) => p.id), adapter)
    dispose = () => { try { handle && handle.dispose && handle.dispose() } catch { /* ignore */ } }
    return dispose
  })

  // 自检路由：GET /api/free-models/models —— 确认渠道与模型确实挂上了
  ctx.inject(['webServer'], (scoped) => {
    const server = scoped && scoped.webServer ? scoped.webServer
      : (typeof ctx.get === 'function' ? ctx.get('webServer') : null)
    if (!server || typeof server.register !== 'function') return () => {}
    return server.register({
      kind: 'exact',
      path: '/api/free-models/models',
      handler: (_req, res) => {
        const body = {
          ok: true,
          active: providers.map((p) => ({
            id: p.id,
            name: p.name,
            baseUrl: p.baseUrl,
            needsKey: !!p.apiKey,
            builtin: !!p.builtin,
            models: p.models.map((m) => ({ id: m.id, provider: p.id, name: m.name || m.id, contextWindow: num(m.contextWindow) })),
          })),
          // 可一键开启的免费渠道：在 config.providers 里填 apiKey 即会激活
          available: PRESET_TEMPLATES.filter((t) => !providers.some((p) => p.id === t.id))
            .map((t) => ({ id: t.id, name: t.name, website: t.website, baseUrl: t.baseUrl, modelCount: t.models.length })),
        }
        const text = JSON.stringify(body)
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(text)
      },
    })
  })

  return () => { try { dispose() } catch { /* ignore */ } }
}
