/**
 * BotCamp Library — host half. Derived from @s1lencewill/dsh-markdown-reader
 * (BSD-3-Clause); every route is library-gated; the workspace adds atomic writes.
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
 * rejected. Read routes are read-only; write routes are limited to docs/ and use
 * temp-file + rename, and deletions go to the hidden .trash/ folder.
 *
 * Zero build, zero runtime dependencies: pure Node ESM.
 * @module @botcamp/dsh-library
 */

import { createReadStream } from 'node:fs'
import { mkdir, open, readdir, realpath, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Required services: the route registry and the prompt band. */
export const inject = ['webServer', 'systemPrompt']

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 220

/** Model-facing announcement: plugin presence, capabilities, and limits. */
export const MARKDOWN_READER_GUIDANCE = '本机已安装 BotCamp 文档库插件（BotCamp Library）：库根目录下的 .md 终稿可在 Notion 式阅读页中打开，支持 GFM（表格/任务列表/删除线）、大纲、阅读进度、相对路径图片、视频（range 播放）、代码复制与表格滚动。库根默认 ~/BotCamp/library，可新建/编辑/重命名/移入回收站，不做版本管理；入口是 BotCamp 客户端里的「文档库」，也可以用 Ctrl+Shift+M 打开。用户提到「文档库 / 阅读 / 打开某篇终稿」时即指本插件。'

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
// Write layer (create / edit / rename / trash). The reader used to be read-only;
// the workspace page needs a small, root-gated file API. Every write is atomic
// (temp file + rename), never accepts a path outside docs/, and keeps deletions
// recoverable in the hidden .trash/ folder.
// ---------------------------------------------------------------------------

/** Maximum Markdown file size accepted by /md-reader/write. */
const MAX_WRITE_BYTES = 4 * 1024 * 1024

/** Normalize a client path and reject empty / dot / traversal segments. */
function normalizeRelPath(value) {
  if (typeof value !== 'string') return null
  const rel = value.replaceAll('\\', '/').replace(/^\/+/, '')
  if (rel === '' || rel.includes('\0')) return null
  const parts = rel.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null
  return rel
}

/** Whether a relative path is a Markdown document under docs/. */
function isDocumentPath(rel) {
  return rel.startsWith('docs/') && MD_EXT.has(extname(rel).toLowerCase())
}

/** Turn a title into a safe folder name (Unicode letters are preserved). */
function slugFromTitle(title) {
  const base = String(title ?? '')
    .trim()
    .replace(/[\\/:*?"<>|#%{}[\]]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64)
  return base || `doc-${Date.now()}`
}

/** Find a free docs/<slug> folder, appending -2, -3, ... on collision. */
async function uniqueDocSlug(docsDir, base) {
  for (let attempt = 1; attempt < 1000; attempt += 1) {
    const slug = attempt === 1 ? base : `${base}-${attempt}`
    try {
      await stat(join(docsDir, slug))
    } catch {
      return slug
    }
  }
  return `${base}-${Date.now()}`
}

/** GET /md-reader/tree: docs and media for the workspace sidebar. */
async function handleTree(gate, root, res) {
  await mkdir(join(root, 'docs'), { recursive: true }).catch(() => {})
  await mkdir(join(root, 'media'), { recursive: true }).catch(() => {})
  const gated = await gate('')
  if (!gated.ok) {
    json(res, FAIL(gated.error.code, gated.error.message), 500)
    return
  }
  const docs = await collectDocs(gated.canonical)
  const media = []
  const walkMedia = async (dir, depth) => {
    if (depth > 6 || media.length >= 500) return
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
        await walkMedia(absolute, depth + 1)
        continue
      }
      if (!entry.isFile() || media.length >= 500) continue
      let info
      try { info = await stat(absolute) } catch { continue }
      media.push({
        path: relative(gated.canonical, absolute).replaceAll('\\', '/'),
        name: entry.name,
        size: info.size,
        mtime: info.mtimeMs,
      })
    }
  }
  await walkMedia(join(gated.canonical, 'media'), 0)
  json(res, { ok: true, value: { root: gated.canonical, docs, media } })
}

/** POST /md-reader/create: create docs/<slug>/index.md plus assets/. */
async function handleCreate(gate, root, payload, res) {
  const title = (strField(payload, 'title') ?? '').trim() || '未命名文档'
  if (title.length > 120) {
    json(res, FAIL('invalid-title', 'title is too long'), 400)
    return
  }
  const gated = await gate('')
  if (!gated.ok) {
    json(res, FAIL(gated.error.code, gated.error.message), 500)
    return
  }
  const docsDir = join(gated.canonical, 'docs')
  await mkdir(docsDir, { recursive: true })
  const requestedSlug = strField(payload, 'slug')
  const base = slugFromTitle(requestedSlug || title)
  const slug = await uniqueDocSlug(docsDir, base)
  const dir = join(docsDir, slug)
  await mkdir(join(dir, 'assets'), { recursive: true })
  const date = new Date().toISOString().slice(0, 10)
  const heading = title.replace(/\r?\n/g, ' ')
  const content = `---\ntitle: ${JSON.stringify(heading)}\nicon: 📄\ncreated: ${date}\nupdated: ${date}\n---\n\n# ${heading}\n\n`
  try {
    await writeFile(join(dir, 'index.md'), content, { flag: 'wx', mode: 0o600 })
  } catch {
    json(res, FAIL('create-failed', 'document already exists or could not be created'), 409)
    return
  }
  json(res, { ok: true, value: { path: `docs/${slug}/index.md`, slug, title: heading } })
}

/** POST /md-reader/write: atomically replace one Markdown document. */
async function handleWrite(gate, root, payload, res) {
  const rel = normalizeRelPath(strField(payload, 'path'))
  const content = typeof payload?.content === 'string' ? payload.content : null
  if (rel === null || !isDocumentPath(rel)) {
    json(res, FAIL('invalid-path', 'path must be a Markdown file under docs/'), 400)
    return
  }
  if (content === null || Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES) {
    json(res, FAIL('invalid-content', 'content is missing or too large'), 413)
    return
  }
  const resolved = await resolveInside(gate, root, rel)
  if (!resolved.ok) {
    json(res, FAIL(resolved.error.code, resolved.error.message), resolved.status)
    return
  }
  const dir = dirname(resolved.real)
  const tmp = join(dir, `.${basename(resolved.real)}.${process.pid}.${Date.now()}.tmp`)
  try {
    await writeFile(tmp, content, { mode: 0o600 })
    await rename(tmp, resolved.real)
    const info = await stat(resolved.real)
    json(res, { ok: true, value: { path: rel, mtime: info.mtimeMs, size: info.size } })
  } catch {
    await unlink(tmp).catch(() => {})
    json(res, FAIL('write-failed', 'document could not be written'), 500)
  }
}

/** POST /md-reader/rename: rename a document folder and update its title. */
async function handleRename(gate, root, payload, res) {
  const rel = normalizeRelPath(strField(payload, 'path'))
  const title = (strField(payload, 'title') ?? '').trim()
  if (rel === null || !isDocumentPath(rel) || title === '' || title.length > 120) {
    json(res, FAIL('invalid-request', 'path and title are required'), 400)
    return
  }
  const resolved = await resolveInside(gate, root, rel)
  if (!resolved.ok) {
    json(res, FAIL(resolved.error.code, resolved.error.message), resolved.status)
    return
  }
  const gated = await gate('')
  if (!gated.ok) {
    json(res, FAIL(gated.error.code, gated.error.message), 500)
    return
  }
  const docsDir = join(gated.canonical, 'docs')
  const docDir = dirname(resolved.real)
  if (!isPathInside(docsDir, docDir) || docDir === docsDir) {
    json(res, FAIL('invalid-path', 'only a document folder can be renamed'), 400)
    return
  }
  const slug = slugFromTitle(title)
  const target = join(docsDir, slug)
  if (target === docDir) {
    json(res, { ok: true, value: { path: rel } })
    return
  }
  try {
    await stat(target)
    json(res, FAIL('already-exists', 'a document with that name already exists'), 409)
    return
  } catch { /* free */ }
  try {
    await rename(docDir, target)
    const file = join(target, basename(resolved.real))
    const text = await readFile(file, 'utf8').catch(() => '')
    if (text !== '') {
      const next = /^title:.*$/m.test(text)
        ? text.replace(/^title:.*$/m, `title: ${JSON.stringify(title)}`)
        : `---\ntitle: ${JSON.stringify(title)}\n---\n\n${text}`
      await writeFile(file, next, { mode: 0o600 })
    }
    json(res, { ok: true, value: { path: `docs/${slug}/${basename(resolved.real)}` } })
  } catch {
    json(res, FAIL('rename-failed', 'document could not be renamed'), 500)
  }
}

/** Allowed image extensions for the workspace upload route. */
const UPLOAD_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif'])

/** POST /md-reader/upload: save one base64 image into the document's assets/. */
async function handleUpload(gate, root, payload, res) {
  const rel = normalizeRelPath(strField(payload, 'path'))
  if (rel === null || !isDocumentPath(rel)) {
    json(res, FAIL('invalid-path', 'path must be a Markdown file under docs/'), 400)
    return
  }
  const name = basename(String(strField(payload, 'name') ?? 'image.png'))
  const ext = extname(name).toLowerCase()
  if (!UPLOAD_EXT.has(ext)) {
    json(res, FAIL('unsupported-type', 'only image files can be uploaded'), 415)
    return
  }
  const raw = typeof payload?.data === 'string' ? payload.data : ''
  const comma = raw.indexOf(',')
  const base64 = raw.startsWith('data:') && comma !== -1 ? raw.slice(comma + 1) : raw
  let buffer
  try { buffer = Buffer.from(base64, 'base64') } catch { buffer = null }
  if (buffer === null || buffer.length === 0) {
    json(res, FAIL('invalid-content', 'image data is missing'), 400)
    return
  }
  if (buffer.length > 20 * 1024 * 1024) {
    json(res, FAIL('too-large', 'image is larger than 20MB'), 413)
    return
  }
  const resolved = await resolveInside(gate, root, rel)
  if (!resolved.ok) {
    json(res, FAIL(resolved.error.code, resolved.error.message), resolved.status)
    return
  }
  const assets = join(dirname(resolved.real), 'assets')
  await mkdir(assets, { recursive: true })
  const stem = basename(name, ext).replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-|-$/g, '') || 'image'
  let file = `${stem}${ext}`
  for (let attempt = 1; attempt < 1000; attempt += 1) {
    try { await stat(join(assets, file)); file = `${stem}-${attempt}${ext}` } catch { break }
  }
  try {
    await writeFile(join(assets, file), buffer, { flag: 'wx' })
    json(res, { ok: true, value: { path: `assets/${file}`, size: buffer.length } })
  } catch {
    json(res, FAIL('upload-failed', 'image could not be saved'), 500)
  }
}

/** POST /md-reader/delete: move a document folder into library/.trash/. */
async function handleDelete(gate, root, payload, res) {
  const rel = normalizeRelPath(strField(payload, 'path'))
  if (rel === null || !isDocumentPath(rel)) {
    json(res, FAIL('invalid-path', 'path must be a Markdown file under docs/'), 400)
    return
  }
  const resolved = await resolveInside(gate, root, rel)
  if (!resolved.ok) {
    json(res, FAIL(resolved.error.code, resolved.error.message), resolved.status)
    return
  }
  const gated = await gate('')
  if (!gated.ok) {
    json(res, FAIL(gated.error.code, gated.error.message), 500)
    return
  }
  const docsDir = join(gated.canonical, 'docs')
  const docDir = dirname(resolved.real)
  if (!isPathInside(docsDir, docDir) || docDir === docsDir) {
    json(res, FAIL('invalid-path', 'only a document folder can be deleted'), 400)
    return
  }
  const trash = join(root, '.trash')
  await mkdir(trash, { recursive: true })
  const target = join(trash, `${Date.now()}-${basename(docDir)}`)
  try {
    await rename(docDir, target)
    json(res, { ok: true, value: { trash: target } })
  } catch {
    json(res, FAIL('delete-failed', 'document could not be moved to trash'), 500)
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
      readonly: false,
      version: 2,
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
  let rel = url.pathname.replace(/^\/library\/?/, '')
  if (rel === 'reader' || rel.startsWith('reader/')) rel = rel.slice(6).replace(/^\/+/, '') || 'index.html'
  else if (rel === '' || rel === 'index.html') rel = 'workspace.html'
  const allowed = rel === 'workspace.js' || rel === 'workspace.html' || rel === 'index.html'
    || rel === 'react.js' || rel === 'react-dom.js' || rel === 'client.js'
    || rel.startsWith('vditor/')
  if (!allowed) {
    res.writeHead(404)
    res.end()
    return
  }
  const file = rel === 'client.js'
    ? fileURLToPath(new URL('../lib/client.cjs', import.meta.url))
    : join(STANDALONE_DIR, rel)
  if (!isPathInside(STANDALONE_DIR, file) && rel !== 'client.js') {
    res.writeHead(404)
    res.end()
    return
  }
  const ext = extname(file).toLowerCase()
  const mime = ext === '.html' ? 'text/html; charset=utf-8'
    : ext === '.js' ? 'text/javascript; charset=utf-8'
      : ext === '.css' ? 'text/css; charset=utf-8'
        : ASSET_MIME[ext] ?? 'application/octet-stream'
  try {
    const body = await readFile(file)
    res.writeHead(200, {
      'content-type': mime,
      'content-length': body.length,
      'cache-control': rel.startsWith('vditor/') ? 'public, max-age=86400' : 'no-store',
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
      if (req.method === 'GET' && url.pathname === '/md-reader/tree') {
        await handleTree(gate, libraryRoot, res)
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
    if (pathname === '/md-reader/create') {
      await handleCreate(gate, libraryRoot, payload, res)
      return
    }
    if (pathname === '/md-reader/write') {
      await handleWrite(gate, libraryRoot, payload, res)
      return
    }
    if (pathname === '/md-reader/rename') {
      await handleRename(gate, libraryRoot, payload, res)
      return
    }
    if (pathname === '/md-reader/delete') {
      await handleDelete(gate, libraryRoot, payload, res)
      return
    }
    if (pathname === '/md-reader/upload') {
      await handleUpload(gate, libraryRoot, payload, res)
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
