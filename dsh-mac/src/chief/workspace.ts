/** List and read a folder the person picked inside this Desktop app. */

import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

const ROOT_FILE = 'chief-workspace.txt'
const SKIP = new Set(['node_modules', '.git'])
const MAX_FILES = 200
const MAX_DEPTH = 4
const MAX_BYTES = 1_000_000

function rootFile(userDataDir: string): string {
  return join(userDataDir, ROOT_FILE)
}

/** Remember one absolute directory. The path stays on this computer. */
export function rememberWorkspace(userDataDir: string, root: string): string {
  if (typeof root !== 'string' || root.includes('\0') || !isAbsolute(root)) {
    throw new Error('工作区路径无效。')
  }
  if (!statSync(root).isDirectory()) throw new Error('工作区需要是一个文件夹。')
  const real = realpathSync(root)
  mkdirSync(userDataDir, { recursive: true })
  writeFileSync(rootFile(userDataDir), real, { encoding: 'utf8', mode: 0o600 })
  return real
}

/** @returns the chosen folder, or null when none has been chosen. */
export function readWorkspaceRoot(userDataDir: string): string | null {
  try {
    const text = readFileSync(rootFile(userDataDir), 'utf8').trim()
    if (!text || text.includes('\0') || !isAbsolute(text) || !statSync(text).isDirectory()) return null
    return realpathSync(text)
  } catch {
    return null
  }
}

/** Resolve a relative file and refuse anything outside the chosen folder. */
export function resolveInside(root: string, relPath: string): string {
  if (typeof relPath !== 'string') throw new Error('没有这份文件。')
  const rel = relPath.trim().replaceAll('\\', '/')
  const parts = rel.split('/')
  if (!rel || rel.startsWith('/') || parts.some(part => part === '' || part === '.' || part === '..')) {
    throw new Error('没有这份文件。')
  }
  const rootReal = realpathSync(root)
  const full = resolve(rootReal, ...parts)
  let real = full
  try { real = realpathSync(full) } catch { throw new Error('没有这份文件。') }
  const diff = relative(rootReal, real)
  if (diff === '' || diff.startsWith('..') || isAbsolute(diff)) throw new Error('没有这份文件。')
  return real
}

/** Relative paths under the chosen folder, one per line. */
export function listWorkspace(userDataDir: string): string {
  const root = readWorkspaceRoot(userDataDir)
  if (!root) return '还没有选择这台电脑上的工作区。'
  const files: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (files.length >= MAX_FILES || depth > MAX_DEPTH) return
    let entries: ReturnType<typeof readdirSync>
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (files.length >= MAX_FILES || SKIP.has(entry.name)) continue
      const full = join(dir, entry.name)
      let info: ReturnType<typeof lstatSync>
      try { info = lstatSync(full) } catch { continue }
      if (info.isSymbolicLink()) continue
      if (info.isDirectory()) walk(full, depth + 1)
      else if (info.isFile()) files.push(relative(root, full).split(sep).join('/'))
    }
  }
  walk(root, 0)
  files.sort()
  if (files.length === 0) return '这个工作区里没有读到文件。'
  return files.join('\n')
}

/** UTF-8 text of one relative file, clipped. Missing and escaping paths do not throw past the caller. */
export function readWorkspace(userDataDir: string, relPath: string): string {
  const root = readWorkspaceRoot(userDataDir)
  if (!root) return '还没有选择这台电脑上的工作区。'
  let full: string
  try { full = resolveInside(root, relPath) } catch (error) {
    return error instanceof Error ? error.message : '没有这份文件。'
  }
  let info: ReturnType<typeof statSync>
  try { info = statSync(full) } catch { return '没有这份文件。' }
  if (!info.isFile() || info.size > MAX_BYTES) return '这份文件太大或不是文本。'
  return readFileSync(full, 'utf8').slice(0, 8000)
}
