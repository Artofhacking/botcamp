import { dshComputer } from './host.js'

function listingText(value) {
  if (typeof value === 'string') return value.trim().slice(0, 8000)
  const entries = Array.isArray(value?.entries)
    ? value.entries
    : Array.isArray(value?.files)
      ? value.files
      : Array.isArray(value)
        ? value
        : []
  const lines = []
  for (const entry of entries) {
    if (typeof entry === 'string' && entry.trim()) lines.push(entry.trim())
    else if (typeof entry?.path === 'string' && entry.path.trim()) lines.push(entry.path.trim())
    else if (typeof entry?.name === 'string' && entry.name.trim()) lines.push(entry.name.trim())
  }
  if (lines.length === 0) return '这台电脑的工作区里还没有可以列出的文件。'
  return lines.join('\n').slice(0, 8000)
}

function readText(value) {
  if (typeof value === 'string') return value
  if (typeof value?.text === 'string') return value.text
  return ''
}

/**
 * File tools for 主编. DSH Desktop's own computer API wins. Otherwise the
 * workspace this window's host already serves (the machine, when that host is DSH).
 * @param {object} bridge
 * @param {(endpoint: string, payload?: object) => Promise<any>} call
 */
export function withComputer(bridge, call) {
  if (!bridge) return null
  const computer = dshComputer()
  const list = async () => {
    if (typeof bridge.workspaceList === 'function') return listingText(await bridge.workspaceList())
    if (typeof computer?.list === 'function') return listingText(await computer.list())
    if (typeof call !== 'function') return '这台电脑的工作区还打不开。'
    try {
      return listingText(await call('folder-list', { path: '' }))
    } catch {
      return '这台电脑的工作区还打不开。'
    }
  }
  const read = async (filePath) => {
    const key = String(filePath || '').replaceAll('\\', '/').replace(/^\/+/, '')
    if (!key || key.split('/').includes('..')) return '路径不在本机工作区里。'
    if (typeof bridge.workspaceRead === 'function') {
      const text = readText(await bridge.workspaceRead(key)).slice(0, 8000)
      return text || '工作区里没有这个文件。'
    }
    if (typeof computer?.read === 'function') {
      const text = readText(await computer.read(key)).slice(0, 8000)
      return text || '工作区里没有这个文件。'
    }
    if (typeof call !== 'function') return '工作区里没有这个文件。'
    try {
      const file = await call('file-text', { file: key })
      const text = readText(file).slice(0, 8000)
      return text || '工作区里没有这个文件。'
    } catch {
      return '工作区里没有这个文件。'
    }
  }
  return {
    get views() { return bridge.views },
    acquire: (key) => bridge.acquire?.(key),
    release: (lease) => bridge.release?.(lease),
    onOpenRequested: (lease, listener) => bridge.onOpenRequested?.(lease, listener),
    forget: (key) => bridge.forget?.(key),
    importSources: typeof bridge.importSources === 'function' ? () => bridge.importSources() : undefined,
    importPick: typeof bridge.importPick === 'function' ? (...args) => bridge.importPick(...args) : undefined,
    importLive: typeof bridge.importLive === 'function' ? (...args) => bridge.importLive(...args) : undefined,
    importApply: typeof bridge.importApply === 'function' ? (...args) => bridge.importApply(...args) : undefined,
    importCancel: typeof bridge.importCancel === 'function' ? (...args) => bridge.importCancel(...args) : undefined,
    subscribe: typeof bridge.subscribe === 'function' ? (listener) => bridge.subscribe(listener) : undefined,
    workspaceList: list,
    workspaceRead: read,
  }
}
