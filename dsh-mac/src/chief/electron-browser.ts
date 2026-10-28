/** Electron window owned by DSH Desktop. Site cookies stay in this app's session. */

import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron'
import { hostAllowed, pageBrief } from './policy.ts'
import type { ChiefBrowser } from './service.ts'

const PAGE_SCRIPT = `({ title: document.title || '', url: location.href, text: (document.body && document.body.innerText || '').slice(0, 5000) })`

async function readPage(win: BrowserWindow): Promise<string> {
  try {
    const page: unknown = await win.webContents.executeJavaScript(PAGE_SCRIPT, true)
    return pageBrief(page)
  } catch {
    return '页面没有读到。'
  }
}

/** Open and read pages in a Desktop window, not in an external browser. */
export function createElectronChiefBrowser(options: {
  BrowserWindow: new (options: BrowserWindowConstructorOptions) => BrowserWindow
}): ChiefBrowser {
  let window: BrowserWindow | undefined
  let hosts: readonly string[] = []

  const current = (): BrowserWindow | undefined => (
    window !== undefined && !window.isDestroyed() ? window : undefined
  )

  const ensure = (): BrowserWindow => {
    const existing = current()
    if (existing) return existing
    const created = new options.BrowserWindow({
      width: 960,
      height: 720,
      title: '主编浏览器',
      show: false,
      autoHideMenuBar: true,
      backgroundColor: '#202124',
      webPreferences: {
        partition: 'persist:dsh-chief-browser',
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
      },
    })
    created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    const guard = (event: { preventDefault(): void }, target: string): void => {
      if (!hostAllowed(target, hosts)) event.preventDefault()
    }
    created.webContents.on('will-navigate', guard)
    created.webContents.on('will-redirect', guard)
    window = created
    return created
  }

  return {
    async open(url: string, nextHosts: readonly string[]): Promise<string> {
      hosts = nextHosts
      if (!hostAllowed(url, hosts)) return '没有打开。这个地址不属于当前用户自己的账号站点。'
      const win = ensure()
      win.setTitle('主编浏览器')
      try {
        await win.loadURL(url)
      } catch {
        return '页面没有打开。'
      }
      win.show()
      return readPage(win)
    },
    async read(): Promise<string> {
      const win = current()
      if (!win) return '这台电脑上还没有打开的页面。'
      return readPage(win)
    },
    close(): void {
      const win = current()
      window = undefined
      if (win) win.destroy()
    },
  }
}
