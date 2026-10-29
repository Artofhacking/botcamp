/**
 * BotCamp Library — host half. Derived from @s1lencewill/dsh-markdown-reader
 * (BSD-3-Clause); the read routes are library-gated and read-only.
 * routes (/md-reader/read, /md-reader/stat, /md-reader/raw) plus the vendored-asset route
 * (/md-reader/assets/*, KaTeX + optional Mermaid drop-in) on the shared
 * webserver, and an agent announcement through the system-prompt section
 * mechanism. The browser half (exports "./client") is served by
 * client-modules from the same package's dsh.client declaration.
 *
 * Security model (mirrors dsh-aionui-panel's workspace gate): every fs route
 * canonicalizes the requested project root with realpath and requires it to
 * be a registered workspace (or a directory inside one); the resolved file
 * is realpathed again and prefix-checked, so `..` and symlink escapes are
 * rejected. The reader is strictly read-only: there is no write route.
 *
 * Zero build, zero runtime dependencies: pure Node ESM.
 * @module @botcamp/dsh-library
 */

import { createReadStream } from 'node:fs'
import { mkdir, open, readdir, realpath, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Required services: the route registry and the prompt band. */
export const inject = ['webServer', 'systemPrompt']

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 220

/** Model-facing announcement: plugin presence, capabilities, and limits. */
export const MARKDOWN_READER_GUIDANCE = '本机已安装 BotCamp 文档库插件（BotCamp Library）：库根目录下的 .md 终稿可在 Notion 式阅读页中打开，支持 GFM（表格/任务列表/删除线）、大纲、阅读进度、相对路径图片、视频（range 播放）、代码复制与表格滚动。库根默认 ~/BotCamp/library，只读、不做版本管理；入口是 BotCamp 客户端里的「文档库」，也可以用 Ctrl+Shift+M 打开。用户提到「文档库 / 阅读 / 打开某篇终稿」时即指本插件。'

// ---------------------------------------------------------------------------
// Error envelope (PanelError-shaped so clients can share the same decoding).
// ---------------------------------------------------------------------------

/** One structured error. */
const FAIL = (code, message) => ({ ok: false, error: { code, message } })

/** Write one JSON envelope response. */
function json(res, envelope, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(envelope))
}

/** Read a JSON request body into an unknown value; null when unparseable. */
async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const buffer = chunk
    chunks.push(buffer)
    total += buffer.length
    if (total > 1 << 20) return null
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text === '') return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Extract the required string field from a JSON object payload. */
function strField(payload, key) {
  if (typeof payload !== 'object' || payload === null) return null
  const value = payload[key]
  return typeof value === 'string' && value !== '' ? value : null
}

// ---------------------------------------------------------------------------
// Workspace gate (same canonicalization contract as dsh-aionui-panel).
// ---------------------------------------------------------------------------

/** Normalize a path for prefix comparison (separators + trailing slash; case on win32). */
function normalizeForPrefix(value) {
  const normalized = value.replaceAll('\\', '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** Whether `child` lives inside (or equals) `root`. */
function isPathInside(root, child) {
  if (root === '' || child === '') return false
  const normRoot = normalizeForPrefix(root)
  const normChild = normalizeForPrefix(child)
  if (normChild === normRoot) return true
  return normChild.startsWith(`${normRoot}/`)
}

/**
 * Gate every request to one fixed BotCamp library root.
 *
 * The client still sends `root` for upstream compatibility, but this fork
 * deliberately ignores it: the library is a first-class root, not a workspace,
 * so a stale or hostile `root` parameter cannot widen the read scope.
 *
 * @param {string} root - absolute library root.
 * @returns a gate function: {ok:true, canonical} or {ok:false, error}.
 */
function createLibraryGate(root) {
  return async () => {
    let canonical
    try {
      canonical = await realpath(root)
    } catch {
      return { ok: false, error: { code: 'library-missing', message: 'library root does not resolve on disk' } }
    }
    return { ok: true, canonical }
  }
}

// ---------------------------------------------------------------------------
// Limits and mime maps.
// ---------------------------------------------------------------------------

/** Default library root: per-device, outside any code workspace. */
const DEFAULT_LIBRARY_ROOT = join(homedir(), 'BotCamp', 'library')

/** Resolve the library root from the environment (BotCamp sets it on first run). */
function resolveLibraryRoot() {
  const configured = process.env.BOTCAMP_LIBRARY_ROOT
  return typeof configured === 'string' && configured.trim() !== '' ? configured.trim() : DEFAULT_LIBRARY_ROOT
}

/** Cap for /md-reader/read (larger files are truncated with a flag). */
const MAX_READ_BYTES = 4 * 1024 * 1024
/** Hard cap for /md-reader/raw; range streaming keeps memory flat for video. */
const MAX_RAW_BYTES = 4 * 1024 * 1024 * 1024

/** Markdown extensions the reader accepts. */
const MD_EXT = new Set(['.md', '.markdown', '.mdown', '.mdx'])

/** Mime map for raw file serving (images, video, audio, and other assets). */
const RAW_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/opus',
  '.pdf': 'application/pdf',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.css': 'text/css; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
}

/** Mime map for vendored assets. */
const ASSET_MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
}

/** The vendored asset directory (package root/vendor). */
const ASSET_DIR = fileURLToPath(new URL('../vendor/', import.meta.url))

/** The standalone library page (same client, no DSH shell) served at /library/. */
const STANDALONE_DIR = fileURLToPath(new URL('../standalone/', import.meta.url))

// ---------------------------------------------------------------------------
// Route handlers.
// ---------------------------------------------------------------------------

/**
 * Resolve a client-supplied relative path against a gated canonical root and
 * verify containment on the REAL path (defeats `..` and symlink escapes).
 * @returns {ok:true, abs, real} or {ok:false, error, status}.
 */
async function resolveInside(gate, root, relPath) {
  const gated = await gate(root)
  if (!gated.ok) return { ok: false, error: gated.error, status: 400 }
  const joined = join(gated.canonical, relPath)
  if (!isPathInside(gated.canonical, joined)) {
    return { ok: false, error: { code: 'path-outside-root', message: 'path escapes the project root' }, status: 403 }
  }
  let real
  try {
    real = await realpath(joined)
  } catch {
    return { ok: false, error: { code: 'not-found', message: 'file does not exist' }, status: 404 }
  }
  if (!isPathInside(gated.canonical, real)) {
    return { ok: false, error: { code: 'path-outside-root', message: 'path resolves outside the project root' }, status: 403 }
  }
  return { ok: true, real }
}

/**
 * Parse one HTTP Range header against a known file size.
 * Only the single-range form (`bytes=a-b`) is supported; that is what
 * Chromium's <video> element sends for seeking.
 */
function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim())
  if (match === null) return null
  const hasStart = match[1] !== ''
  const hasEnd = match[2] !== ''
  if (!hasStart && !hasEnd) return null
  let start
  let end
  if (!hasStart) {
    const suffix = Number(match[2])
    if (!Number.isFinite(suffix) || suffix <= 0) return null
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(match[1])
    end = hasEnd ? Number(match[2]) : size - 1
    if (end >= size) end = size - 1
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  if (start < 0 || start >= size || end < start) return null
  return { start, end }
}

/**
 * GET/HEAD /md-reader/raw: stream one library file (images, video, audio).
 * Media responses advertise byte ranges so <video> can seek through the
 * reverse tunnel; images keep the simple buffered path.
 */
async function serveRaw(gate, req, url, res) {
  const path = url.searchParams.get('path')
  if (path === null || path === '') {
    json(res, FAIL('malformed-request', 'missing path'), 400)
    return
  }
  const resolved = await resolveInside(gate, '', path.replaceAll('\\', '/'))
  if (!resolved.ok) {
    json(res, FAIL(resolved.error.code, resolved.error.message), resolved.status)
    return
  }
  let info
  try {
    info = await stat(resolved.real)
  } catch {
    json(res, FAIL('not-found', 'file does not exist'), 404)
    return
  }
  if (!info.isFile()) {
    json(res, FAIL('is-directory', 'target is a directory'), 403)
    return
  }
  if (info.size > MAX_RAW_BYTES) {
    json(res, FAIL('too-large', 'file exceeds the raw serving limit'), 413)
    return
  }

  const mime = RAW_MIME[extname(resolved.real).toLowerCase()] ?? 'application/octet-stream'
  const rangeHeader = req.headers?.range
  const range = typeof rangeHeader === 'string' && rangeHeader !== '' ? parseRange(rangeHeader, info.size) : null
  if (typeof rangeHeader === 'string' && rangeHeader !== '' && range === null) {
    res.writeHead(416, { 'accept-ranges': 'bytes', 'content-range': `bytes */${info.size}` })
    res.end()
    return
  }

  const streamable = range !== null || mime.startsWith('video/') || mime.startsWith('audio/')
  const start = range !== null ? range.start : 0
  const end = range !== null ? range.end : Math.max(0, info.size - 1)
  const length = info.size === 0 ? 0 : end - start + 1
  const headers = {
    'content-type': mime,
    'content-length': length,
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
    'accept-ranges': 'bytes',
    'content-disposition': 'inline',
  }
  if (range !== null) headers['content-range'] = `bytes ${start}-${end}/${info.size}`
  if (mime === 'image/svg+xml') {
    headers['content-security-policy'] = "default-src 'none'; style-src 'unsafe-inline'; sandbox"
  }

  try {
    res.writeHead(range !== null ? 206 : 200, headers)
    if (req.method === 'HEAD' || info.size === 0) {
      res.end()
      return
    }
    if (!streamable) {
      res.end(await readFile(resolved.real))
      return
    }
    const stream = createReadStream(resolved.real, { start, end })
    stream.on('error', () => {
      try {
        res.destroy?.()
      } catch {
        /* connection already gone */
      }
    })
    stream.pipe(res)
  } catch {
    if (!res.headersSent) json(res, FAIL('not-found', 'file could not be read'), 404)
  }
}

/**
 * GET/HEAD /md-reader/assets/*: serve one vendored asset (KaTeX JS/CSS/fonts,
 * optional Mermaid drop-in) from the plugin package's vendor/ directory.
 * HEAD answers with the headers only so the client can probe for the optional
 * Mermaid drop-in without printing a 404 (or downloading it twice).
 */
async function serveAsset(url, res, headOnly) {
  await serveVendorAsset(url, res, headOnly, '/md-reader/assets/', '')
}

/**
 * Serve one file from a vendor subdirectory, for an arbitrary URL prefix.
 * Shared by /md-reader/assets/* and the aionui-panel compat routes.
 */
async function serveVendorAsset(url, res, headOnly, prefix, subdir) {
  const rel = url.pathname.slice(prefix.length)
  if (rel === '' || !/^[a-zA-Z0-9@._/+-]+$/.test(rel) || rel.includes('..')) {
    res.writeHead(404)
    res.end()
    return
  }
  const base = join(ASSET_DIR, subdir)
  const resolved = join(base, rel)
  if (!isPathInside(base, resolved)) {
    res.writeHead(404)
    res.end()
    return
  }
  try {
    const info = await stat(resolved)
    if (!info.isFile()) throw new Error('not a file')
    const headers = {
      'content-type': ASSET_MIME[extname(resolved).toLowerCase()] ?? 'application/octet-stream',
      'content-length': info.size,
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    }
    res.writeHead(200, headers)
    if (headOnly) {
      res.end()
      return
    }
    res.end(await readFile(resolved))
  } catch {
    res.writeHead(404)
    res.end()
  }
}

/**
 * GET/HEAD /aionui-panel/katex/* and /aionui-panel/hljs/* compat routes.
 * Registered under LONGER prefixes than the aionui-panel bundle's own
 * `/aionui-panel` prefix, so longest-prefix-wins routes these asset requests
 * here. Reason: after an in-place config hot-reload (skin switch) the panel's
 * in-memory host code can end up in a hybrid broken state (405 on its asset
 * subroutes); serving the same vendored assets from here keeps panel math
 * and highlighting alive without touching the panel package.
 */
async function serveCompatAsset(url, res, headOnly) {
  if (url.pathname.startsWith('/aionui-panel/katex/')) {
    await serveVendorAsset(url, res, headOnly, '/aionui-panel/katex/', 'katex')
    return
  }
  if (url.pathname.startsWith('/aionui-panel/hljs/')) {
    await serveVendorAsset(url, res, headOnly, '/aionui-panel/hljs/', 'hljs')
    return
  }
  res.writeHead(404)
  res.end()
}

/**
 * POST /md-reader/read: read one workspace markdown file (gated, capped).
 * Returns {content, mtime, size, truncated}.
 */
async function handleRead(gate, payload, res) {
  const root = strField(payload, 'root') ?? ''
  const path = strField(payload, 'path')
  if (path === null) {
    json(res, FAIL('malformed-request', 'missing path'), 400)
    return
  }
  const rel = path.replaceAll('\\', '/').replace(/^\/+/, '')
  const resolved = await resolveInside(gate, root, rel)
  if (!resolved.ok) {
    json(res, FAIL(resolved.error.code, resolved.error.message), resolved.status)
    return
  }
  const ext = extname(resolved.real).toLowerCase()
  if (!MD_EXT.has(ext)) {
    json(res, FAIL('unsupported-type', 'not a markdown file'), 415)
    return
  }
  let info
  try {
    info = await stat(resolved.real)
  } catch {
    json(res, FAIL('not-found', 'file does not exist'), 404)
    return
  }
  if (!info.isFile()) {
    json(res, FAIL('is-directory', 'target is a directory'), 403)
    return
  }
  const truncated = info.size > MAX_READ_BYTES
  try {
    // Open + partial read: a 200MB file only costs the capped buffer, not a
    // full readFile into memory.
    const fh = await open(resolved.real, 'r')
    try {
      const buffer = Buffer.alloc(Math.min(info.size, MAX_READ_BYTES))
      const { bytesRead } = await fh.read(buffer, 0, buffer.length, 0)
      json(res, {
        ok: true,
        value: {
          content: buffer.subarray(0, bytesRead).toString('utf8'),
          mtime: info.mtimeMs,
          size: info.size,
          truncated,
        },
      })
    } finally {
      await fh.close().catch(() => {})
    }
  } catch {
    json(res, FAIL('not-found', 'file could not be read'), 404)
  }
}

/**
 * POST /md-reader/stat: return lightweight file metadata for change polling.
 * It intentionally shares the same workspace/type gate as /read and never
 * returns file content.
 */
async function handleStat(gate, payload, res) {
  const root = strField(payload, 'root') ?? ''
  const path = strField(payload, 'path')
  if (path === null) {
    json(res, FAIL('malformed-request', 'missing path'), 400)
    return
  }
  const rel = path.replaceAll('\\', '/').replace(/^\/+/, '')
  const resolved = await resolveInside(gate, root, rel)
  if (!resolved.ok) {
    json(res, FAIL(resolved.error.code, resolved.error.message), resolved.status)
    return
  }
  if (!MD_EXT.has(extname(resolved.real).toLowerCase())) {
    json(res, FAIL('unsupported-type', 'not a markdown file'), 415)
    return
  }
  try {
    const info = await stat(resolved.real)
    if (!info.isFile()) {
      json(res, FAIL('is-directory', 'target is a directory'), 403)
      return
    }
    json(res, { ok: true, value: { mtime: info.mtimeMs, size: info.size } })
  } catch {
    json(res, FAIL('not-found', 'file does not exist'), 404)
  }
}

// ---------------------------------------------------------------------------
// Library index (frontmatter + first H1 + cover discovery).
// ---------------------------------------------------------------------------

/** Parse the tiny YAML subset the library needs: string / inline array. */
function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (match === null) return { data: {}, body: text }
  const data = {}
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (kv === null) continue
    let value = kv[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value
        .slice(1, -1)
        .split(',')
        .map((item) => item.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean)
    }
    data[kv[1]] = value
  }
  return { data, body: text.slice(match[0].length) }
}

/** First readable paragraph, used as the card description when frontmatter has none. */
function firstParagraph(body) {
  for (const line of body.split(/\r?\n/)) {
    const text = line.trim()
    if (text === '') continue
    if (/^(?:#{1,6}\s|!\[|>|```|\||<)/.test(text)) continue
    return text.replace(/[*_~`]/g, '').slice(0, 160)
  }
  return ''
}

/** Resolve a cover path against the document folder, and keep it inside the library. */
async function resolveCover(root, docAbs, configured) {
  if (typeof configured === 'string' && /^https?:/i.test(configured)) return configured
  const candidates = []
  if (typeof configured === 'string' && configured !== '') candidates.push(join(dirname(docAbs), configured))
  for (const name of ['cover.jpg', 'cover.png', 'cover.webp', 'cover.avif']) candidates.push(join(dirname(docAbs), name))
  for (const candidate of candidates) {
    try {
      const real = await realpath(candidate)
      if (!isPathInside(root, real)) continue
      const info = await stat(real)
      if (info.isFile()) return relative(root, real).replaceAll('\\', '/')
    } catch {
      /* try the next candidate */
    }
  }
  return null
}

/** Walk `docs/` and return the library cards, newest first. */
async function collectDocs(root) {
  const docsDir = join(root, 'docs')
  const items = []
  const walk = async (dir, depth) => {
    if (depth > 6 || items.length >= 500) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const absolute = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(absolute, depth + 1)
        continue
      }
      if (!entry.isFile() || !MD_EXT.has(extname(entry.name).toLowerCase())) continue
      if (items.length >= 500) return
      let info
      try {
        info = await stat(absolute)
      } catch {
        continue
      }
      const head = await readFile(absolute, 'utf8').catch(() => '')
      const { data, body } = parseFrontmatter(head.slice(0, 64 * 1024))
      const h1 = /^#\s+(.+)$/m.exec(body)
      const fallbackTitle = basename(entry.name, extname(entry.name))
      const title =
        (typeof data.title === 'string' && data.title.trim() !== '' ? data.title.trim() : '') ||
        (h1 !== null ? h1[1].replace(/[*_`~]/g, '').trim() : '') ||
        fallbackTitle
      const description =
        (typeof data.description === 'string' && data.description.trim() !== '' ? data.description.trim() : '') ||
        firstParagraph(body)
      const tags = Array.isArray(data.tags)
        ? data.tags
        : typeof data.tags === 'string' && data.tags !== ''
          ? [data.tags]
          : []
      items.push({
        path: relative(root, absolute).replaceAll('\\', '/'),
        title,
        description,
        icon: typeof data.icon === 'string' && data.icon !== '' ? data.icon : '📄',
        cover: await resolveCover(root, absolute, data.cover),
        tags,
        updated:
          typeof data.updated === 'string' && data.updated !== ''
            ? data.updated
            : info.mtime.toISOString().slice(0, 10),
        mtime: info.mtimeMs,
        size: info.size,
      })
    }
  }
  await walk(docsDir, 0)
  return items.sort((a, b) => String(b.updated).localeCompare(String(a.updated)) || b.mtime - a.mtime)
}

/** GET /md-reader/config: the fixed root and the library identity. */
function handleConfig(root, res) {
  json(res, {
    ok: true,
    value: {
      root,
      title: 'BotCamp 文档库',
      readonly: true,
      version: 1,
    },
  })
}

/** GET /md-reader/list: cards for the library home. */
async function handleList(gate, root, res) {
  await mkdir(join(root, 'docs'), { recursive: true }).catch(() => {})
  await mkdir(join(root, 'media'), { recursive: true }).catch(() => {})
  const gated = await gate('')
  if (!gated.ok) {
    json(res, FAIL(gated.error.code, gated.error.message), 500)
    return
  }
  const items = await collectDocs(gated.canonical)
  json(res, { ok: true, value: { root: gated.canonical, items } })
}

/**
 * GET /library/*: the standalone library page used by mobile/WebViews.
 * It loads the same client bundle with React UMD and mocks the tiny DSH
 * session surface, so the reading experience is identical to the desktop
 * overlay without depending on the DSH shell.
 */
async function serveStandalone(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405)
    res.end()
    return
  }
  const url = new URL(req.url ?? '/', 'http://x')
  if (url.pathname === '/library') {
    res.writeHead(308, { location: '/library/' })
    res.end()
    return
  }
  const rel = url.pathname.replace(/^\/library\/?/, '') || 'index.html'
  if (rel !== 'index.html' && rel !== 'client.js' && rel !== 'react.js' && rel !== 'react-dom.js') {
    res.writeHead(404)
    res.end()
    return
  }
  const file = rel === 'client.js'
    ? fileURLToPath(new URL('../lib/client.cjs', import.meta.url))
    : join(STANDALONE_DIR, rel)
  try {
    const body = await readFile(file)
    const mime = rel.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8'
    res.writeHead(200, {
      'content-type': mime,
      'content-length': body.length,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    if (req.method === 'HEAD') res.end()
    else res.end(body)
  } catch {
    res.writeHead(404)
    res.end()
  }
}

/**
 * Register the /md-reader route prefix.
 * @returns the route disposer.
 */
function registerRoutes(ctx, gate, libraryRoot) {
  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (url.pathname.startsWith('/md-reader/assets/')) {
        await serveAsset(url, res, req.method === 'HEAD')
        return
      }
      if (req.method === 'GET' && url.pathname === '/md-reader/config') {
        handleConfig(libraryRoot, res)
        return
      }
      if (req.method === 'GET' && url.pathname === '/md-reader/list') {
        await handleList(gate, libraryRoot, res)
        return
      }
      if (url.pathname === '/md-reader/raw') {
        await serveRaw(gate, req, url, res)
        return
      }
      res.writeHead(405)
      res.end()
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405)
      res.end()
      return
    }
    // Require an explicit JSON content-type: cross-site simple requests (no
    // preflight) cannot set application/json, so this blocks form-based CSRF
    // from driving the read routes.
    const contentType = req.headers['content-type'] ?? ''
    if (!contentType.toLowerCase().startsWith('application/json')) {
      json(res, FAIL('malformed-request', 'expected application/json'), 415)
      return
    }
    const payload = await readJsonBody(req)
    if (payload === null) {
      json(res, FAIL('malformed-request', 'malformed request'), 400)
      return
    }
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    if (pathname === '/md-reader/read') {
      await handleRead(gate, payload, res)
      return
    }
    if (pathname === '/md-reader/stat') {
      await handleStat(gate, payload, res)
      return
    }
    res.writeHead(404)
    res.end()
  }

  const standaloneHandler = async (req, res) => {
    await serveStandalone(req, res)
  }

  // aionui-panel asset compat routes (shadow the panel's broken subroutes
  // via longest-prefix-wins; see serveCompatAsset).
  const compatHandler = async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405)
      res.end()
      return
    }
    const url = new URL(req.url ?? '/', 'http://x')
    await serveCompatAsset(url, res, req.method === 'HEAD')
  }

  const disposers = [
    ctx.webServer.register({ kind: 'prefix', path: '/md-reader', handler }),
    ctx.webServer.register({ kind: 'prefix', path: '/library', handler: standaloneHandler }),
    ctx.webServer.register({ kind: 'prefix', path: '/aionui-panel/katex', handler: compatHandler }),
    ctx.webServer.register({ kind: 'prefix', path: '/aionui-panel/hljs', handler: compatHandler }),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}

/**
 * Mount the read routes and the agent announcement.
 * @param ctx - context carrying webServer and systemPrompt.
 */
export function apply(ctx) {
  const libraryRoot = resolveLibraryRoot()
  const gate = createLibraryGate(libraryRoot)
  ctx.effect(() => registerRoutes(ctx, gate, libraryRoot), 'botcamp-library: /md-reader routes')
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'plugin:botcamp-library',
    order: SECTION_ORDER,
    text: MARKDOWN_READER_GUIDANCE,
  }), 'botcamp-library: prompt section')
}
