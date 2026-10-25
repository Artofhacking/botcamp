// Each account owns one stable directory. The kernel is single-tenant, so file,
// folder, and workspace operations are served from that directory and are not
// forwarded. A path that resolves outside the directory is refused first.

import { lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const PATH_MESSAGE = '路径必须留在你自己的工作区里。'
export const WORKSPACE_MESSAGE = '无权查看或操作其他用户的工作区。'

export const WORKSPACE_ENDPOINTS = new Set([
  'workspace-list',
  'workspaces',
  'workspace-open',
  'team-workspace',
  'folder-pick',
  'folder-list',
  'folders',
  'file-text',
  'file-write',
])

const PATH_KEYS = new Set(['path', 'file', 'folder', 'cwd', 'dir', 'workspacePath'])
const LIST_LIMIT = 200
const TEXT_LIMIT = 200_000
const WRITE_LIMIT = 1_000_000

export function safeKernelKey(kernelKey) {
  return typeof kernelKey === 'string' && /^u_[A-Za-z0-9_-]{8,64}$/.test(kernelKey)
}

export function workspaceDir(dataDir, kernelKey) {
  if (!safeKernelKey(kernelKey)) {
    const error = new Error('invalid workspace')
    error.code = 'WORKSPACE'
    throw error
  }
  const parent = path.resolve(dataDir, 'workspaces')
  const root = path.resolve(parent, kernelKey)
  if (isOutside(path.relative(parent, root))) {
    const error = new Error('invalid workspace')
    error.code = 'WORKSPACE'
    throw error
  }
  return root
}

export async function ensureWorkspace(dataDir, kernelKey) {
  const root = workspaceDir(dataDir, kernelKey)
  await mkdir(root, { recursive: true, mode: 0o700 })
  return root
}

function isOutside(rel) {
  return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)
}

export function pathEscapes(root, requested) {
  if (typeof requested !== 'string') return true
  if (requested.length > 4096 || requested.includes('\0')) return true
  if (requested === '' || requested === '.') return false
  const base = path.resolve(root)
  const target = path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(base, requested)
  return isOutside(path.relative(base, target))
}

export function collectPaths(payload, out = []) {
  if (!payload || typeof payload !== 'object') return out
  if (Array.isArray(payload)) {
    for (const item of payload) collectPaths(item, out)
    return out
  }
  for (const [key, value] of Object.entries(payload)) {
    if (PATH_KEYS.has(key) && typeof value === 'string') out.push(value)
    else if (value && typeof value === 'object') collectPaths(value, out)
  }
  return out
}

export async function resolveInside(root, requested) {
  if (typeof requested !== 'string') return null
  if (requested.includes('\0') || pathEscapes(root, requested)) return null
  let base
  try { base = await realpath(root) } catch { return null }
  const logicalRoot = path.resolve(root)
  const logical = requested === '' || requested === '.'
    ? logicalRoot
    : (path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(logicalRoot, requested))
  const rel = path.relative(logicalRoot, logical)
  if (isOutside(rel)) return null
  const parts = rel === '' ? [] : rel.split(path.sep).filter(part => part !== '')
  let current = base
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]
    if (part === '.' || part === '..') return null
    const next = path.join(current, part)
    let st
    try {
      st = await lstat(next)
    } catch (error) {
      if (error?.code !== 'ENOENT') return null
      const rest = parts.slice(index)
      if (rest.some(item => item === '.' || item === '..')) return null
      const candidate = path.join(current, ...rest)
      if (isOutside(path.relative(base, candidate))) return null
      return candidate
    }
    if (st.isSymbolicLink()) {
      let real
      try { real = await realpath(next) } catch { return null }
      if (isOutside(path.relative(base, real))) return null
      current = real
      continue
    }
    current = next
  }
  if (isOutside(path.relative(base, current))) return null
  return current
}

export async function pathsStayInside(root, payload) {
  for (const requested of collectPaths(payload)) {
    if (await resolveInside(root, requested) == null) return false
  }
  return true
}

export function stripPathFields(value) {
  if (Array.isArray(value)) return value.map(stripPathFields)
  if (!value || typeof value !== 'object') return value
  const next = {}
  for (const [key, child] of Object.entries(value)) {
    if (key === 'workspaceId' || PATH_KEYS.has(key)) continue
    next[key] = child && typeof child === 'object' ? stripPathFields(child) : child
  }
  return next
}

function refuse(message) {
  return { ok: false, error: { code: 'bot/refused', message } }
}

async function readSettings(root) {
  const file = await resolveInside(root, 'settings.json')
  if (!file) return {}
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    return {}
  }
}

export async function writeSettings(root, patch) {
  const file = await resolveInside(root, 'settings.json')
  if (!file) throw new Error('settings path')
  const next = { ...(await readSettings(root)), ...patch }
  await writeFile(file, JSON.stringify(next), { mode: 0o600 })
  return next
}

export async function writeManifest(root, manifest) {
  const file = await resolveInside(root, 'owned.json')
  if (!file) throw new Error('manifest path')
  await writeFile(file, JSON.stringify(manifest), { mode: 0o600 })
}

function crumbsFor(rel) {
  const crumbs = [{ path: '.', name: '工作区' }]
  let acc = ''
  for (const part of String(rel || '').split('/').filter(Boolean)) {
    acc = acc ? `${acc}/${part}` : part
    crumbs.push({ path: acc, name: part })
  }
  return crumbs
}

async function listDirectories(root, rel) {
  const abs = await resolveInside(root, rel || '')
  if (!abs) return null
  let entries
  try {
    entries = await readdir(abs, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      return { path: rel || '.', entries: [], crumbs: crumbsFor(rel), truncated: false }
    }
    throw error
  }
  const shown = []
  let truncated = false
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'settings.json' || entry.name === 'owned.json') continue
    if (!entry.isDirectory()) continue
    if (shown.length >= LIST_LIMIT) {
      truncated = true
      break
    }
    const child = rel ? `${String(rel).replace(/\/$/, '')}/${entry.name}` : entry.name
    shown.push({ name: entry.name, path: child, hidden: false })
  }
  return { path: rel || '.', entries: shown, crumbs: crumbsFor(rel), truncated }
}

export async function materializeFolder(root, rel) {
  if (typeof rel !== 'string' || rel === '' || rel === '.') return true
  const abs = await resolveInside(root, rel)
  if (!abs) return false
  await mkdir(abs, { recursive: true })
  return true
}

export async function runWorkspace({ root, workspaceId, endpoint, payload }) {
  if (endpoint === 'workspace-list' || endpoint === 'workspaces') {
    const listing = await listDirectories(root, '')
    const entry = { id: workspaceId, workspaceId, name: '我的工作区', sessionIds: [] }
    return {
      ok: true,
      value: {
        workspaces: [entry],
        // DSH host workspaces.list reads `.items` (workspaceId + sessionIds).
        items: [entry],
        folders: (listing?.entries ?? []).map(folder => ({ path: folder.path, title: folder.name })),
      },
    }
  }
  if (endpoint === 'workspace-open') {
    const id = payload?.workspaceId ?? payload?.id
    if (typeof id !== 'string' || id !== workspaceId) return refuse(WORKSPACE_MESSAGE)
    const listing = await listDirectories(root, '')
    return {
      ok: true,
      value: {
        workspaceId,
        entries: listing?.entries ?? [],
      },
    }
  }
  if (endpoint === 'folders') {
    const settings = await readSettings(root)
    const listing = await listDirectories(root, '')
    return {
      ok: true,
      value: {
        team: typeof settings.teamWorkspace === 'string' ? settings.teamWorkspace : '',
        picker: 'browse',
        folders: (listing?.entries ?? []).map(entry => ({ path: entry.path, title: entry.name })),
      },
    }
  }
  if (endpoint === 'folder-list') {
    const rel = typeof payload?.path === 'string' ? payload.path : ''
    const listing = await listDirectories(root, rel)
    if (!listing) return refuse(PATH_MESSAGE)
    return { ok: true, value: listing }
  }
  if (endpoint === 'folder-pick') return { ok: true, value: '' }
  if (endpoint === 'file-text') {
    const rel = payload?.file
    if (typeof rel !== 'string' || rel === '') return refuse(PATH_MESSAGE)
    const abs = await resolveInside(root, rel)
    if (!abs) return refuse(PATH_MESSAGE)
    let st
    try { st = await lstat(abs) } catch (error) {
      if (error?.code === 'ENOENT') return refuse('工作区里没有这个文件。')
      throw error
    }
    if (st.isSymbolicLink() || !st.isFile()) return refuse(PATH_MESSAGE)
    if (st.size > WRITE_LIMIT) return refuse('文件太大。')
    const text = await readFile(abs, 'utf8')
    return { ok: true, value: { text: text.slice(0, TEXT_LIMIT), truncated: text.length > TEXT_LIMIT } }
  }
  if (endpoint === 'file-write') {
    const rel = payload?.file
    if (typeof rel !== 'string' || rel === '' || typeof payload?.text !== 'string') return refuse(PATH_MESSAGE)
    if (payload.text.length > WRITE_LIMIT) return refuse('文件太大。')
    const abs = await resolveInside(root, rel)
    if (!abs) return refuse(PATH_MESSAGE)
    const base = await realpath(root)
    const parent = path.dirname(abs)
    if (isOutside(path.relative(base, parent))) return refuse(PATH_MESSAGE)
    await mkdir(parent, { recursive: true })
    let existing
    try { existing = await lstat(abs) } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    if (existing?.isSymbolicLink()) return refuse(PATH_MESSAGE)
    await writeFile(abs, payload.text, { mode: 0o600 })
    return { ok: true, value: { file: rel } }
  }
  if (endpoint === 'team-workspace') {
    const rel = payload?.path
    if (typeof rel !== 'string') return refuse(PATH_MESSAGE)
    if (rel !== '' && rel !== '.') {
      const abs = await resolveInside(root, rel)
      if (!abs) return refuse(PATH_MESSAGE)
      await mkdir(abs, { recursive: true })
    }
    const settings = await writeSettings(root, { teamWorkspace: rel === '.' ? '' : rel })
    return { ok: true, value: { path: settings.teamWorkspace } }
  }
  return refuse('无效的请求。')
}
