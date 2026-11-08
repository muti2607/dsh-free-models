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

/** 预置渠道：pollinations 的 OpenAI 兼容端点，无需 Key。 */
const BUILTIN_PROVIDERS = [
  {
    id: 'pollinations',
    name: 'Pollinations (免密钥)',
    baseUrl: 'https://text.pollinations.ai/openai',
    apiKey: '',
    models: [
      { id: 'openai-fast', name: 'OpenAI Fast (Pollinations)', contextWindow: 128000, maxOutputTokens: 8192 },
      { id: 'openai', name: 'OpenAI (Pollinations)', contextWindow: 128000, maxOutputTokens: 8192 },
    ],
  },
]

/** 把配置里的渠道与预置渠道合并（同名以配置为准）。 */
function resolveProviders(cfg) {
  const custom = Array.isArray(cfg.providers) ? cfg.providers : []
  const byId = new Map()
  for (const p of BUILTIN_PROVIDERS) byId.set(p.id, { ...p, builtin: true })
  for (const raw of custom) {
    if (!raw || typeof raw !== 'object' || !raw.id || !raw.baseUrl) continue
    byId.set(String(raw.id), {
      id: String(raw.id),
      name: String(raw.name || raw.id),
      baseUrl: String(raw.baseUrl).replace(/\/+$/, ''),
      apiKey: String(raw.apiKey || ''),
      models: Array.isArray(raw.models) ? raw.models.filter((m) => m && m.id) : [],
      builtin: false,
    })
  }
  return [...byId.values()]
}

/** 模型 id 在 picker 里的全局唯一形态：`<provider>/<model>`。 */
function modelKey(providerId, modelId) {
  return providerId + '/' + modelId
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
          out.push({ provider: p.id, id: modelKey(p.id, m.id), name: m.name || m.id, inputModalities: ['text'] })
        }
      }
      return out
    },

    async resolveModel(provider, model) {
      const p = providers.find((x) => x.id === provider) || providers[0]
      const key = modelKey(p.id, String(model || '').replace(new RegExp('^' + p.id + '/'), ''))
      const m = p.models.find((x) => modelKey(p.id, x.id) === key) || p.models[0]
      const out = { provider: p.id, id: key, name: (m && m.name) || key, inputModalities: ['text'] }
      if (m && num(m.contextWindow)) out.context = { contextWindow: num(m.contextWindow) }
      if (m && num(m.maxOutputTokens)) out.defaultMaxTokens = num(m.maxOutputTokens)
      return out
    },

    async prepareCall(provider, model) {
      const resolved = await this.resolveModel(provider, model)
      return { model: resolved, stream: (options) => streamCall(provider, model, options) }
    },

    async *stream(options) {
      // 模型 id 形如 `<provider>/<model>`，据此路由到对应渠道
      const raw = String((options && options.model) || '')
      const hit = providers.find((p) => raw.startsWith(p.id + '/'))
      yield* streamCall(hit ? hit.id : providers[0].id, raw, options)
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
    const server = scoped && scoped.webServer ? scoped.webServer : ctx.get('webServer')
    if (!server || typeof server.register !== 'function') return () => {}
    return server.register({
      kind: 'exact',
      path: '/api/free-models/models',
      handler: (_req, res) => {
        const body = {
          ok: true,
          providers: providers.map((p) => ({
            id: p.id,
            name: p.name,
            baseUrl: p.baseUrl,
            needsKey: !!p.apiKey,
            builtin: !!p.builtin,
            models: p.models.map((m) => ({ id: modelKey(p.id, m.id), name: m.name || m.id, contextWindow: num(m.contextWindow) })),
          })),
        }
        const text = JSON.stringify(body)
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(text)
      },
    })
  })

  return () => { try { dispose() } catch { /* ignore */ } }
}
