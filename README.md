# dsh-free-models

把**免密钥**的免费模型和**自带 Key** 的免费渠道接进 DeepSeek Harness。

## 装完就能用

**设置 → 免费模型** 里就是全部操作界面，不用改 YAML：

1. 点某渠道的「去申请」→ 自动打开系统浏览器到申请 Key 的网页
2. 在网页登录、创建 Key、复制
3. 粘回这一行的输入框，点「保存并启用」

保存后 Host 会把密钥写进 `$DSH_HOME/free-models/keys.json`（只在本机、不进浏览器响应、
不进 `cordis.patch.yml`），并**立即重新注册渠道**——模型选择器里马上出现，不用重启。

内置一个真的不需要注册、不需要 Key 的渠道：

| 渠道 | 模型 | 说明 |
| --- | --- | --- |
| Pollinations | `openai-fast`、`openai` | 公开端点，无 Key，有限流 |

模型选择器里会出现对应条目，直接选即可。自检：

```bash
curl http://127.0.0.1:<dsh 端口>/api/free-models/models
```

## 内置 7 个免费渠道模板（设置页一键登录）

不用改代码、不用手写 baseUrl，**设置页点「去申请」打开网页拿 Key，粘回来保存即生效**：

| id | 渠道 | 免费说明 | 申请 Key |
| --- | --- | --- | --- |
| `groq` | Groq | 免费额度，速度极快 | console.groq.com/keys |
| `cerebras` | Cerebras | 免费额度，推理极快 | cloud.cerebras.ai |
| `gemini` | Google Gemini | 每日免费额度 | aistudio.google.com/apikey |
| `siliconflow` | 硅基流动 | 部分模型永久免费、国内直连 | cloud.siliconflow.cn/account/ak |
| `modelscope` | 魔搭 | 每日 2000 次免费 | modelscope.cn/my/myaccesstoken |
| `openrouter` | OpenRouter | `:free` 后缀模型免费 | openrouter.ai/keys |
| `ollama` | 本地 Ollama | 完全免费、不联网 | 装好 Ollama，key 随便填 |

## 高级：也可用配置直接写

设置页是推荐方式（密钥落到 `$DSH_HOME/free-models/keys.json`，不进配置文件）。
如果你更习惯写配置，也能在 `cordis.patch.yml` 里覆盖 `config.providers`：

```yaml
- id: free-models
  name: dsh-free-models
  config:
    providers:
      - { id: groq,        apiKey: gsk_xxxxxxxx }
      - { id: siliconflow, apiKey: sk_xxxxxxxx }
      - { id: ollama,      apiKey: ollama }
```

> 注意：`groq` / `cerebras` 等是预置模板 id，别写成自定义名，
> 那样就需要自己提供 `baseUrl` 和 `models`。

**没填 key 的渠道不会注册**——避免选择器里塞满一按就 401 的死条目。
填了 key 的渠道，baseUrl 和模型列表由插件自动补全。

查看当前可开启哪些：

```bash
curl http://127.0.0.1:<dsh 端口>/api/free-models/models
# { active: [...已启用的], available: [...可填 key 开启的，含申请地址] }
```

## 自定义端点

只要是 **OpenAI Chat Completions 兼容**端点，都能这样接：

```yaml
    providers:
      - id: my-provider
        name: 我的渠道
        baseUrl: https://example.com/v1
        apiKey: sk_xxx            # 免密钥就留空
        models:
          - id: some-model
            name: Some Model
            contextWindow: 128000
            maxOutputTokens: 8192
```

## 实测记录（2026-11-08，国内直连）

| 端点 | 结果 |
| --- | --- |
| `text.pollinations.ai/openai` | ✅ 免密钥可用，已内置 |
| `api.airforce` | ❌ 401 需订阅（模型列表 790 个） |
| `api.chatanywhere.tech` | ❌ 401 需 Key |
| `api.llm7.io` | ❌ 连接超时 |
| `api.openai-hk.com` | ❌ 502 |
| `api.binjie.fun` / `api.nagaai.com` / `api.gpt-load.com` | ❌ 已失效 |

所以**真正免密钥、开箱即用的只有 pollinations**；其它免费额度都得自己申请一个 key。

## 已知限制

- 只支持**文本**：免费端点普遍不支持图片输入，适配器只声明 `text`。
- 不做工具调用的特殊适配：请求会原样带上 `tools`，能否用取决于上游。
- 上游限流/额度错误会原样抛出（带 HTTP 状态与响应片段），不做无限重试，最多补发一次。
- 免密钥端点（Pollinations）是公开共享资源，速度与稳定性不受控，别用于重要任务。
