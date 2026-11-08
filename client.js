/**
 * dsh-free-models — Client half (Web).
 *
 * 在设置里加一页「免费模型渠道」：
 *   · 每个免费渠道一行，点「去申请」会用系统浏览器打开申请页（Host 侧 /open-external）
 *   · 把拿到的 Key 粘进输入框点保存，Host 落盘并立即重注册渠道，模型选择器里立刻出现
 *   · 密钥只发往本机同源 API，状态响应里永远不含密钥本体
 */
window.__ModuleLoader__.load({
  id: 'dsh-free-models',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const useState = React.useState
    const useEffect = React.useEffect
    const NS = 'dsh-free-models'

    const DICT = {
      zh: {
        'nav': '免费模型',
        'meta.title': '免费模型渠道',
        'meta.description': '接入免密钥与免费额度的模型渠道，在设置里登录/填 Key 后立即生效。',
        'title': '免费模型渠道',
        'sub': '点「去申请」打开网页拿 Key，粘回来保存即生效，不用改配置、不用重启。',
        'open': '去申请',
        'opened': '已打开浏览器；如果没弹出，请点这里',
        'keyPlaceholder': '粘贴 API Key（留空保存 = 移除）',
        'save': '保存并启用',
        'saving': '保存中…',
        'enabled': '已启用',
        'disabled': '未启用',
        'keyless': '免密钥',
        'models': '个模型',
        'saved': '已保存，渠道已生效',
        'remove': '移除',
        'error': '操作失败',
        'loading': '读取中…',
        'reloadHint': '保存后如选择器未刷新，切换一次模型即可。',
        'loginStep': '① 在网页登录并创建 Key → ② 复制 → ③ 粘贴到下面保存',
      },
      en: {
        'nav': 'Free Models',
        'meta.title': 'Free model providers',
        'meta.description': 'Keyless and free-tier model providers. Sign in and paste a key in Settings to enable instantly.',
        'title': 'Free model providers',
        'sub': 'Open the provider page, copy your key, paste it here and save — no config edits, no restart.',
        'open': 'Get a key',
        'opened': 'Browser opened; if not, use this link',
        'keyPlaceholder': 'Paste API key (save empty to remove)',
        'save': 'Save & enable',
        'saving': 'Saving…',
        'enabled': 'Enabled',
        'disabled': 'Not enabled',
        'keyless': 'Keyless',
        'models': ' models',
        'saved': 'Saved and enabled',
        'remove': 'Remove',
        'error': 'Failed',
        'loading': 'Loading…',
        'reloadHint': 'If the picker does not refresh, switch models once.',
        'loginStep': '① Sign in and create a key → ② Copy → ③ Paste below and save',
      },
    }

    const API = (() => {
      try { return new URL('api/free-models', document.baseURI).pathname } catch { return '/api/free-models' }
    })()

    async function api(path, options) {
      const { timeout = 10000, ...rest } = options || {}
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeout)
      try {
        const r = await fetch(`${API}${path}`, { ...rest, signal: ctrl.signal, redirect: 'error' })
        const text = await r.text()
        let body
        try { body = text ? JSON.parse(text) : {} } catch { body = { error: text.slice(0, 200) } }
        if (!r.ok) throw new Error(body.error || ('HTTP ' + r.status))
        return body
      } finally { clearTimeout(timer) }
    }

    const post = (path, body) => api(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    })

    function SettingsPage(props) {
      const t = (key) => props && props.t ? props.t(key) : key
      const [state, setState] = useState(null)
      const [error, setError] = useState('')
      const [drafts, setDrafts] = useState({})
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState('')

      const load = () => api('/status').then((data) => { setState(data); setError('') }).catch((e) => setError(String(e.message || e)))
      useEffect(() => { load() }, [])

      async function openPage(entry) {
        setBusy('open:' + entry.id)
        setError('')
        try {
          const r = await post('/open-external', { id: entry.id, url: entry.website })
          setNotice(r.opened ? t('opened') : entry.website)
        } catch (e) { setError(t('error') + ': ' + String(e.message || e)) }
        finally { setBusy('') }
      }

      async function save(entry) {
        setBusy('save:' + entry.id)
        setError('')
        try {
          const r = await post('/keys', { id: entry.id, apiKey: String(drafts[entry.id] || '') })
          setState(r)
          setDrafts((prev) => ({ ...prev, [entry.id]: '' }))
          setNotice(t('saved'))
        } catch (e) { setError(t('error') + ': ' + String(e.message || e)) }
        finally { setBusy('') }
      }

      const rows = (state && state.available) || []
      return h('div', { className: 'fm-root' },
        h('style', null, `
.fm-root{font:inherit;color:var(--dsw-alias-label-primary, inherit)}
.fm-head{margin-bottom:16px}
.fm-title{margin:0;font-size:17px;font-weight:600}
.fm-sub{margin:5px 0 0;font-size:12px;opacity:.72;line-height:1.6}
.fm-step{font-size:12px;opacity:.8;margin:10px 0;padding:8px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.1))}
.fm-row{border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));border-radius:10px;padding:12px 14px;margin-bottom:10px}
.fm-row-top{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.fm-name{font-weight:600;font-size:13px}
.fm-badge{font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));opacity:.85}
.fm-badge-on{color:#1a9c6a;border-color:#1a9c6a;opacity:1}
.fm-meta{font-size:11px;opacity:.65;margin-top:3px}
.fm-actions{display:flex;align-items:center;gap:8px;margin-top:10px;flex-wrap:wrap}
.fm-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.4));background:var(--dsw-alias-bg-layer-1,transparent);color:inherit;border-radius:7px;padding:5px 12px;font-size:12px;cursor:pointer;font-family:inherit}
.fm-btn:hover:not(:disabled){border-color:#4C8DFF;color:#4C8DFF}
.fm-btn:disabled{opacity:.55;cursor:default}
.fm-btn-primary{border-color:#4C8DFF;color:#4C8DFF}
.fm-input{flex:1 1 220px;min-width:180px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.4));background:var(--dsw-alias-bg-layer-1,transparent);color:inherit;border-radius:7px;padding:5px 10px;font-size:12px;font-family:inherit}
.fm-link{font-size:11px;opacity:.75;word-break:break-all}
.fm-note{font-size:12px;margin-top:12px;opacity:.75}
.fm-error{color:#e05555;font-size:12px;margin:8px 0}
.fm-ok{color:#1a9c6a;font-size:12px;margin:8px 0}
`),
        h('div', { className: 'fm-head' },
          h('h1', { className: 'fm-title' }, t('title')),
          h('p', { className: 'fm-sub' }, t('sub'))),
        h('div', { className: 'fm-step' }, t('loginStep')),
        error ? h('div', { className: 'fm-error' }, error) : null,
        notice ? h('div', { className: 'fm-ok' }, notice) : null,
        !state ? h('div', { className: 'fm-note' }, t('loading')) : null,
        rows.map((entry) => h('div', { className: 'fm-row', key: entry.id },
          h('div', { className: 'fm-row-top' },
            h('span', { className: 'fm-name' }, entry.name),
            h('span', { className: 'fm-badge' + (entry.enabled ? ' fm-badge-on' : '') },
              entry.enabled ? t('enabled') : t('disabled')),
            h('span', { className: 'fm-meta' }, entry.modelCount + t('models'))),
          h('div', { className: 'fm-actions' },
            h('button', {
              className: 'fm-btn', disabled: busy === 'open:' + entry.id,
              onClick: () => openPage(entry),
            }, busy === 'open:' + entry.id ? t('saving') : t('open')),
            h('input', {
              className: 'fm-input', type: 'password',
              placeholder: t('keyPlaceholder'),
              value: drafts[entry.id] || '',
              onChange: (e) => setDrafts((prev) => ({ ...prev, [entry.id]: e.target.value })),
            }),
            h('button', {
              className: 'fm-btn fm-btn-primary', disabled: busy === 'save:' + entry.id,
              onClick: () => save(entry),
            }, busy === 'save:' + entry.id ? t('saving') : t('save')),
            entry.hasSavedKey ? h('button', {
              className: 'fm-btn', disabled: busy === 'save:' + entry.id,
              onClick: () => { setDrafts((prev) => ({ ...prev, [entry.id]: '' })); save({ id: entry.id }) },
            }, t('remove')) : null),
          h('div', { className: 'fm-link' }, entry.website))),
        h('div', { className: 'fm-note' }, t('reloadHint')))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const unregisterLocale = ctx.locale.register(NS, DICT)
        const unregisterSection = ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'dsh-free-models',
          order: 40,
          label: () => DICT.zh.nav,
          locale: NS,
        }, (props) => h(SettingsPage, props)))
        return () => {
          try { unregisterSection && unregisterSection() } catch { /* ignore */ }
          try { unregisterLocale && unregisterLocale() } catch { /* ignore */ }
        }
      },
    }
  },
})
