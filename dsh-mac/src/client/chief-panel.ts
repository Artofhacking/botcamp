/** 主编 inside DSH Desktop. The transcript is reloaded from the shared ledger. */

import { CHIEF_SESSION_ID, CHIEF_SESSION_KEY } from '../chief/contract.ts'
import type { LedgerResult } from '../chief/ledger.ts'
import {
  ChiefTurnError,
  sendChiefTurn,
  transcriptFromLedger,
  type ChiefLine,
  type ChiefTool,
} from '../chief/turn.ts'

interface DshChiefBridge {
  ledger(endpoint: string, payload: unknown, token: string): Promise<LedgerResult>
  browser: {
    open(url: string, hosts: readonly string[]): Promise<string>
    read(): Promise<string>
  }
  computer: {
    list(): Promise<string>
    read(path: string): Promise<string>
    choose(root: string): Promise<string>
  }
}

interface DirectoryPicker {
  pick(): Promise<string | null>
}

declare global {
  interface Window {
    dshChief?: DshChiefBridge
    __DSH_DIRECTORY_PICKER__?: DirectoryPicker
  }
}

export interface ChiefPanelOptions {
  /** Fill the window instead of floating over another client. */
  fill?: boolean
  /** Shown in the header, for example 2.0.19. */
  version?: string
}

const CSS = `
#dsh-chief-root { position: fixed; left: 16px; bottom: 16px; z-index: 2147483000; font: 14px/1.45 ui-sans-serif, system-ui, sans-serif; color: #f3f4f6; }
#dsh-chief-root * { box-sizing: border-box; }
#dsh-chief-open { border: 0; border-radius: 999px; padding: 8px 14px; background: #2563eb; color: white; cursor: pointer; }
#dsh-chief-panel { display: flex; flex-direction: column; width: min(420px, calc(100vw - 32px)); height: min(560px, calc(100vh - 88px)); margin-bottom: 8px; padding: 12px; background: #1c1e22; border: 1px solid #34383f; border-radius: 12px; box-shadow: 0 12px 40px rgba(0,0,0,.35); }
#dsh-chief-panel[hidden] { display: none; }
#dsh-chief-panel header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
#dsh-chief-panel header strong { font-size: 16px; }
#dsh-chief-log { flex: 1; overflow: auto; display: flex; flex-direction: column; gap: 8px; padding-right: 4px; }
.dsh-chief-line { max-width: 90%; padding: 8px 10px; border-radius: 10px; white-space: pre-wrap; word-break: break-word; }
.dsh-chief-line[data-kind="user"] { align-self: flex-end; background: #243044; }
.dsh-chief-line[data-kind="bot"] { align-self: flex-start; background: #2a2d33; }
#dsh-chief-panel form, #dsh-chief-login { display: flex; gap: 8px; margin-top: 8px; }
#dsh-chief-login { flex-direction: column; }
#dsh-chief-login[hidden] { display: none; }
#dsh-chief-panel input, #dsh-chief-panel textarea { width: 100%; border: 1px solid #3a3f47; border-radius: 8px; padding: 8px; background: #111317; color: inherit; }
#dsh-chief-panel textarea { min-height: 64px; resize: vertical; }
#dsh-chief-panel button { border: 0; border-radius: 8px; padding: 8px 10px; background: #2f343c; color: inherit; cursor: pointer; }
#dsh-chief-send { background: #2563eb; color: white; }
#dsh-chief-status { min-height: 1.2em; margin: 6px 0 0; color: #c5cad3; font-size: 12px; }
#dsh-chief-version { color: #c5cad3; font-size: 12px; }
`

const FILL_CSS = `
#dsh-chief-root { left: 0; right: 0; top: 0; bottom: 0; }
#dsh-chief-panel { width: 100%; height: 100%; margin: 0; border: 0; border-radius: 0; box-shadow: none; }
`

function readToken(): string {
  try { return localStorage.getItem(CHIEF_SESSION_KEY) ?? '' } catch { return '' }
}

function saveToken(token: string): void {
  localStorage.setItem(CHIEF_SESSION_KEY, token)
}

function el<K extends keyof HTMLElementTagNameMap>(
  name: K,
  attrs: Record<string, string> = {},
  text = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(name)
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value)
  if (text) node.textContent = text
  return node
}

/** Mount 主编. Reloading the window reads the ledger again and does not delete it. */
export function installChiefPanel(options: ChiefPanelOptions = {}): () => void {
  if (typeof document === 'undefined') return () => {}
  document.getElementById('dsh-chief-root')?.remove()
  document.getElementById('dsh-chief-style')?.remove()
  const style = el('style', { id: 'dsh-chief-style' })
  style.textContent = options.fill ? CSS + FILL_CSS : CSS
  document.head.appendChild(style)

  const root = el('div', { id: 'dsh-chief-root' })
  const panel = options.fill
    ? el('section', { id: 'dsh-chief-panel' })
    : el('section', { id: 'dsh-chief-panel', hidden: '' })
  panel.setAttribute('aria-label', '主编')
  const header = el('header')
  header.append(el('strong', {}, '主编'))
  if (options.version) header.append(el('span', { id: 'dsh-chief-version' }, `DSH Desktop ${options.version}`))
  header.append(el('button', { type: 'button', id: 'dsh-chief-refresh' }, '刷新'))
  const log = el('div', { id: 'dsh-chief-log' })
  const login = el('form', { id: 'dsh-chief-login', hidden: '' })
  const email = el('input', { type: 'email', name: 'email', autocomplete: 'username', placeholder: '邮箱' })
  const password = el('input', { type: 'password', name: 'password', autocomplete: 'current-password', placeholder: '密码' })
  login.append(email, password, el('button', { type: 'submit' }, '登录'))
  const composer = el('form', { id: 'dsh-chief-composer' })
  const input = el('textarea', { id: 'dsh-chief-input', placeholder: '发给主编' })
  const send = el('button', { type: 'submit', id: 'dsh-chief-send' }, '发送')
  composer.append(input, send)
  const tools = el('div')
  const choose = el('button', { type: 'button', id: 'dsh-chief-workspace' }, '选择工作区')
  tools.append(choose)
  const status = el('p', { id: 'dsh-chief-status' })
  panel.append(header, log, login, composer, tools, status)
  const open = el('button', { type: 'button', id: 'dsh-chief-open' }, '主编')
  root.append(panel)
  if (!options.fill) root.append(open)
  document.body.appendChild(root)
  if (options.version) document.title = `DSH Desktop ${options.version}`

  let lines: ChiefLine[] = []
  let busy = false

  const paint = (next: readonly ChiefLine[]): void => {
    lines = [...next]
    log.replaceChildren()
    if (lines.length === 0) {
      log.append(el('p', { class: 'dsh-chief-line', 'data-kind': 'bot' }, '对话会显示在这里。'))
      return
    }
    for (const line of lines) {
      const row = el('p', { class: 'dsh-chief-line', 'data-kind': line.kind })
      row.textContent = line.text
      log.append(row)
    }
    log.scrollTop = log.scrollHeight
  }

  const bridge = (): DshChiefBridge | null => window.dshChief ?? null

  const refresh = async (): Promise<void> => {
    const desktop = bridge()
    if (!desktop) {
      status.textContent = '主编需要从这个桌面窗口打开。'
      return
    }
    const result = await desktop.ledger('chat', { sessionId: CHIEF_SESSION_ID, botId: CHIEF_SESSION_ID }, readToken())
    if (result.status === 401) {
      login.hidden = false
      status.textContent = '登录后，这段对话记在共享账本上。'
      return
    }
    login.hidden = true
    if (!Array.isArray(result.data.value?.items)) return
    paint(transcriptFromLedger(lines, result))
  }

  const runTool = async (tool: ChiefTool): Promise<string> => {
    const desktop = bridge()
    if (!desktop) return '这个窗口没有本机浏览器。'
    if (tool.tool === 'browser_open') {
      status.textContent = '正在使用这个应用自己的浏览器…'
      return desktop.browser.open(tool.url, tool.hosts)
    }
    if (tool.tool === 'browser_read') {
      status.textContent = '正在读取这个应用打开的页面…'
      return desktop.browser.read()
    }
    if (tool.tool === 'computer_list') {
      status.textContent = '正在列出这台电脑上的工作区…'
      return desktop.computer.list()
    }
    if (tool.tool === 'computer_read') {
      status.textContent = '正在读取这台电脑上的文件…'
      return desktop.computer.read(tool.path)
    }
    return '没有这个本机工具。'
  }

  open.addEventListener('click', () => {
    panel.hidden = !panel.hidden
    if (!panel.hidden) void refresh().catch(() => { status.textContent = '账本暂时没有连上。' })
  })
  header.querySelector('#dsh-chief-refresh')?.addEventListener('click', () => {
    void refresh().catch(() => { status.textContent = '账本暂时没有连上。' })
  })
  login.addEventListener('submit', event => {
    event.preventDefault()
    const desktop = bridge()
    if (!desktop || busy) return
    busy = true
    void desktop.ledger('auth/login', { email: email.value, password: password.value }, '').then(result => {
      const token = result.data.token
      if (result.status === 200 && typeof token === 'string' && token.length >= 20) {
        saveToken(token)
        password.value = ''
        login.hidden = true
        status.textContent = '已登录。'
        return refresh()
      }
      status.textContent = '登录没有成功。'
      return undefined
    }).catch(() => { status.textContent = '账本暂时没有连上。' }).finally(() => { busy = false })
  })
  composer.addEventListener('submit', event => {
    event.preventDefault()
    const desktop = bridge()
    const text = input.value
    if (!desktop || busy || !text.trim()) return
    busy = true
    send.disabled = true
    void sendChiefTurn({
      text,
      ledger: payload => desktop.ledger('send', payload, readToken()),
      runTool,
    }).then(() => {
      input.value = ''
      status.textContent = ''
    }).catch((error: unknown) => {
      if (error instanceof ChiefTurnError && error.status !== 401 && error.reachedLedger) input.value = ''
      status.textContent = error instanceof Error ? error.message.slice(0, 200) : '没有发送。'
      if (error instanceof ChiefTurnError && error.status === 401) login.hidden = false
    }).finally(() => {
      busy = false
      send.disabled = false
      void refresh().catch(() => {})
    })
  })
  if (options.fill) void refresh().catch(() => { status.textContent = '账本暂时没有连上。' })

  choose.addEventListener('click', () => {
    const desktop = bridge()
    const picker = window.__DSH_DIRECTORY_PICKER__
    if (!desktop || !picker) {
      status.textContent = '这个窗口还不能选择文件夹。'
      return
    }
    void picker.pick().then(path => {
      if (!path) return undefined
      return desktop.computer.choose(path)
    }).then(chosen => {
      if (typeof chosen === 'string') status.textContent = '已选择工作区。'
    }).catch(() => { status.textContent = '工作区没有选上。' })
  })

  return () => {
    root.remove()
    style.remove()
  }
}
