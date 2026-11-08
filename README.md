# dsh-free-models

把**免密钥**的免费模型和**自带 Key** 的免费渠道接进 DeepSeek Harness。

## 装完就能用

内置一个真的不需要注册、不需要 Key 的渠道：

| 渠道 | 模型 | 说明 |
| --- | --- | --- |
| Pollinations | `pollinations/openai-fast`、`pollinations/openai` | 公开端点，无 Key，有限流 |

模型选择器里会出现对应条目，直接选即可。自检：

```bash
curl http://127.0.0.1:<dsh 端口>/api/free-models/models
```

## 加更多渠道（填 Key 即可）

在 profile 的 `cordis.patch.yml` 里覆盖 `free-models` 的 `config`：

```yaml
- id: free-models
  name: dsh-free-models
  config:
    providers:
      - id: groq
        name: Groq
        baseUrl: https://api.groq.com/openai/v1
        apiKey: gsk_xxx
        models:
          - id: llama-3.3-70b-versatile
            name: Llama 3.3 70B (Groq)
            contextWindow: 128000
            maxOutputTokens: 8192

      - id: siliconflow
        name: 硅基流动
        baseUrl: https://api.siliconflow.cn/v1
        apiKey: sk-xxx
        models:
          - id: Qwen/Qwen3-8B
            name: Qwen3 8B (硅基流动)
            contextWindow: 32768
```

只要对方是 **OpenAI Chat Completions 兼容**端点，就能这样接。常见的免费额度渠道：

- Groq — `https://api.groq.com/openai/v1`（免费额度，速度极快）
- Cerebras — `https://api.cerebras.ai/v1`
- Google Gemini — `https://generativelanguage.googleapis.com/v1beta/openai`
- 硅基流动 SiliconFlow — `https://api.siliconflow.cn/v1`（部分模型免费）
- 魔搭 ModelScope — `https://api-inference.modelscope.cn/v1`
- 本地 Ollama — `http://127.0.0.1:11434/v1`（apiKey 随便填）
- OpenRouter — `https://openrouter.ai/api/v1`（`:free` 后缀模型）

## 已知限制

- 只支持**文本**：免费端点普遍不支持图片输入，适配器只声明 `text`。
- 不做工具调用的特殊适配：请求会原样带上 `tools`，能否用取决于上游。
- 上游限流/额度错误会原样抛出（带 HTTP 状态与响应片段），不做无限重试，最多补发一次。
- 免密钥端点（Pollinations）是公开共享资源，速度与稳定性不受控，别用于重要任务。
