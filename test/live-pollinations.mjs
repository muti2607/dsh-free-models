// 真机验证：直接走适配器调用 pollinations
import { apply } from '../index.js'

let reg = null
const fake = {
  logger: { info: () => {}, warn: console.warn },
  llm: { registerAdapter(p, a) { reg = a; return { dispose() {} } } },
  inject(d, cb) { cb(fake); return () => {} },
  get(n) { return fake[n] },
}
apply(fake, {})
const chunks = []
for await (const c of reg.stream({ model: 'openai-fast', messages: [{ role: 'user', content: [{ type: 'text', text: '用一句中文打个招呼' }] }] })) {
  chunks.push(c)
}
const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
const finish = chunks.find((c) => c.type === 'finish')
console.log('回复:', JSON.stringify(text))
console.log('finish:', JSON.stringify(finish))
console.log(text ? '真实调用成功 ✅' : '没有拿到内容 ❌')
