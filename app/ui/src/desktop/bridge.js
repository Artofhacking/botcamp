import { cookiePreview, cookiesForHosts, parseCookieExport } from './cookies.js'

const FILE_LIMIT = 1_000_000
const TEXT_LIMIT = 64_000

function invoke(cmd, args) {
  const internals = globalThis.__TAURI_INTERNALS__
  if (typeof internals?.invoke !== 'function') throw new Error('桌面客户端没有连上本机。')
  return internals.invoke(cmd, args ?? {})
}

function pickFiles({ directory }) {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    if (directory) input.webkitdirectory = true
    else input.accept = '.txt,.json'
    input.onchange = () => resolve([...input.files || []])
    input.click()
  })
}

/**
 * The desktop bridge DS Bot already understands (`dsBotApp.browser`).
 * Chrome runs on this computer, one profile per Bot. Nothing here is a shared server browser.
 */
export function createDesktopBridge({ hosts = () => [] } = {}) {
  const tabs = new Map()
  const pending = new Map()
  let serial = 0
  /** @type {Map<string, string>} relative path -> text, chosen on this computer */
  const workspace = new Map()
  const listeners = new Set()

  const emit = (change) => { for (const listener of listeners) listener(change) }

  const remember = (botId, tabId, patch) => {
    const current = tabs.get(tabId) || { botId, tabId, url: '', title: '', loading: false, canGoBack: false, canGoForward: false }
    const next = { ...current, ...patch, botId, tabId }
    tabs.set(tabId, next)
    emit({ type: 'updated', ...next })
    return next
  }

  return {
    async readAfterOpen() { return null },
    workspaceList() {
      if (workspace.size === 0) return '这台电脑还没有选工作区。在客户端左下角点「本机」，选一个文件夹。'
      return [...workspace.keys()].sort().join('\n')
    },
    workspaceRead(path) {
      const key = String(path || '').replaceAll('\\', '/').replace(/^\/+/, '')
      if (!key || key.split('/').includes('..')) return '路径不在本机工作区里。'
      if (!workspace.has(key)) return '工作区里没有这个文件。'
      return workspace.get(key).slice(0, 8000)
    },
    async pickWorkspace() {
      const files = await pickFiles({ directory: true })
      workspace.clear()
      for (const file of files) {
        if (file.size > TEXT_LIMIT) continue
        if (!/\.(md|txt|json|csv|markdown)$/i.test(file.name)) continue
        const key = String(file.webkitRelativePath || file.name).replaceAll('\\', '/')
        workspace.set(key, await file.text())
      }
      return workspace.size
    },
    views: {
      async create(botId, tabId, url) {
        remember(botId, tabId, { url: url || '', loading: false })
      },
      async navigate(botId, tabId, url) {
        remember(botId, tabId, { url, loading: true, title: '' })
        const page = await invoke('desktop_browser_navigate', { botId, url })
        remember(botId, tabId, {
          url: page?.url || url,
          title: page?.title || '',
          loading: false,
          canGoBack: page?.canGoBack === true,
          canGoForward: page?.canGoForward === true,
        })
        return page
      },
      async read(_botId, _tabId, script) {
        return invoke('desktop_browser_eval', { botId: _botId, script })
      },
      async command(botId, tabId, name) {
        const page = await invoke('desktop_browser_command', { botId, name })
        if (page && typeof page === 'object') {
          remember(botId, tabId, {
            url: page.url || tabs.get(tabId)?.url || '',
            title: page.title || '',
            loading: false,
            canGoBack: page.canGoBack === true,
            canGoForward: page.canGoForward === true,
          })
        }
        return page
      },
      focus() {},
      place() {},
      async close(_botId, tabId) { tabs.delete(tabId) },
      async sync(botId) {
        return [...tabs.values()].filter((tab) => tab.botId === botId)
      },
      hold() {},
      subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    importSources() { return Promise.resolve([]) },
    async importPick() {
      const files = await pickFiles({ directory: false })
      const file = files[0]
      if (!file) return null
      if (file.size > FILE_LIMIT) return { error: 'too-large' }
      let text = ''
      try { text = await file.text() } catch { return { error: 'unreadable' } }
      const parsed = parseCookieExport(text)
      const id = `imp${Date.now().toString(36)}-${++serial}`
      pending.set(id, parsed.cookies)
      return { id, preview: cookiePreview(parsed, file.name) }
    },
    importLive() { return Promise.resolve({ error: 'unreadable' }) },
    async importApply(partition, id) {
      const botId = String(partition || '').replace(/^bot:/, '')
      const cookies = pending.get(id) || []
      const { kept, dropped } = cookiesForHosts(cookies, hosts())
      pending.delete(id)
      if (kept.length === 0) return { stored: 0, dropped, failed: [] }
      const report = await invoke('desktop_browser_cookies', { botId, cookies: kept })
      return {
        stored: report?.stored ?? 0,
        dropped: [...dropped, ...(report?.dropped || [])],
        failed: report?.failed || [],
      }
    },
    importCancel(id) { pending.delete(id); return Promise.resolve(null) },
  }
}

export function installDesktopBridge() {
  if (globalThis.dsBotApp?.browser) return globalThis.dsBotApp.browser
  if (typeof globalThis.__TAURI_INTERNALS__?.invoke !== 'function') return null
  const hosts = () => globalThis.__botcampAccountHosts || []
  const browser = createDesktopBridge({ hosts })
  globalThis.dsBotApp = { browser }
  return browser
}
