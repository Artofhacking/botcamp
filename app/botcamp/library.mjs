/**
 * Per-owner document library: nested folders and markdown files.
 * No schema and no required sections. Owner id comes from the session, never the payload.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { kvGet, kvSet } from '../../server/kv.mjs'
import { PHOSA_OWNER_ID } from '../../scripts/seed-ids.mjs'
import { mediaOwnerIdFor } from './mediaControl.mjs'

const MAX_NAME = 80
const MAX_CONTENT = 200_000
const MAX_NODES = 2000

export const LIBRARY_CONTROL = [
  'library/list',
  'library/get',
  'library/create',
  'library/update',
  'library/delete',
  'library/asset',
]

const MAX_IMAGE = 4 * 1024 * 1024
const MAX_VIDEO = 12 * 1024 * 1024
const ASSET_ID = /^[a-f0-9]{32}$/
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const VIDEO_TYPES = new Set(['video/mp4', 'video/webm'])

function treeKey(ownerId) {
  return `library:${ownerId}:tree`
}

function seededKey(ownerId) {
  return `library:${ownerId}:seeded`
}

function loadTree(ownerId) {
  const saved = kvGet(treeKey(ownerId))
  if (!saved || !Array.isArray(saved.nodes)) return { nodes: [] }
  return { nodes: saved.nodes.filter((node) => node && typeof node.id === 'string') }
}

function saveTree(ownerId, tree) {
  kvSet(treeKey(ownerId), {
    owner_user_id: ownerId,
    nodes: tree.nodes,
    updated_at: new Date().toISOString(),
  })
}

function newId() {
  return `doc_${randomBytes(8).toString('hex')}`
}

export function sanitizeName(name, kind) {
  if (typeof name !== 'string') return null
  let next = name.trim().replace(/[\\/]/g, '')
  if (!next || next === '.' || next === '..') return null
  if (next.length > MAX_NAME) next = next.slice(0, MAX_NAME)
  if (kind === 'file' && !next.toLowerCase().endsWith('.md')) next = `${next}.md`
  return next
}

function siblingTaken(nodes, parentId, name, exceptId) {
  const parent = parentId || null
  return nodes.some((node) => (node.parentId || null) === parent && node.name === name && node.id !== exceptId)
}

function uniqueName(nodes, parentId, name, exceptId) {
  if (!siblingTaken(nodes, parentId, name, exceptId)) return name
  const ext = name.toLowerCase().endsWith('.md') ? '.md' : ''
  const stem = ext ? name.slice(0, -3) : name
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${stem} ${i}${ext}`
    if (!siblingTaken(nodes, parentId, candidate, exceptId)) return candidate
  }
  return null
}

function parentOk(nodes, parentId) {
  if (parentId == null || parentId === '') return true
  const parent = nodes.find((node) => node.id === parentId)
  return Boolean(parent && parent.kind === 'folder')
}

function isDescendant(nodes, ancestorId, id) {
  let current = nodes.find((node) => node.id === id)
  const seen = new Set()
  while (current) {
    if (current.id === ancestorId) return true
    if (seen.has(current.id)) return false
    seen.add(current.id)
    if (!current.parentId) return false
    current = nodes.find((node) => node.id === current.parentId)
  }
  return false
}

function publicNode(node, withContent) {
  const out = {
    id: node.id,
    parentId: node.parentId || null,
    kind: node.kind,
    name: node.name,
    updatedAt: node.updatedAt,
    createdAt: node.createdAt,
  }
  if (withContent && node.kind === 'file') out.content = typeof node.content === 'string' ? node.content : ''
  return out
}

function fixturesDir() {
  const candidates = []
  try {
    const here = path.dirname(fileURLToPath(import.meta.url))
    candidates.push(path.resolve(here, '../../fixtures/xiaogao/manuscripts'))
  } catch { /* bundled without import.meta */ }
  candidates.push(path.resolve(process.cwd(), 'fixtures/xiaogao/manuscripts'))
  candidates.push(path.resolve(process.cwd(), '../fixtures/xiaogao/manuscripts'))
  return candidates.find((dir) => {
    try { return existsSync(dir) } catch { return false }
  }) || null
}

function createNode(ownerId, { parentId = null, kind, name, content = '' }) {
  if (kind !== 'folder' && kind !== 'file') return { error: '类型不对。' }
  const tree = loadTree(ownerId)
  if (tree.nodes.length >= MAX_NODES) return { error: '文档太多了。' }
  const parent = parentId || null
  if (!parentOk(tree.nodes, parent)) return { error: '文件夹不存在。' }
  const clean = sanitizeName(name, kind)
  if (!clean) return { error: '名字无效。' }
  const unique = uniqueName(tree.nodes, parent, clean)
  if (!unique) return { error: '名字冲突。' }
  if (kind === 'file') {
    if (typeof content !== 'string') return { error: '正文无效。' }
    if (content.length > MAX_CONTENT) return { error: '正文太长。' }
  }
  const now = new Date().toISOString()
  const node = {
    id: newId(),
    parentId: parent,
    kind,
    name: unique,
    createdAt: now,
    updatedAt: now,
  }
  if (kind === 'file') node.content = content
  tree.nodes.push(node)
  saveTree(ownerId, tree)
  return { node: publicNode(node, true) }
}

/** Readable manuscripts for the seeded owner. Skipped when fixtures are absent. */
function maybeSeed(ownerId) {
  if (ownerId !== PHOSA_OWNER_ID) return
  if (kvGet(seededKey(ownerId))) return
  kvSet(seededKey(ownerId), { at: new Date().toISOString() })
  const dir = fixturesDir()
  if (!dir) return
  let files = []
  try {
    files = readdirSync(dir).filter((name) => name.endsWith('.md')).slice(0, 40)
  } catch {
    return
  }
  if (files.length === 0) return
  const folder = createNode(ownerId, { kind: 'folder', name: '小稿' })
  if (folder.error) return
  for (const file of files) {
    let raw = ''
    try { raw = readFileSync(path.join(dir, file), 'utf8') } catch { continue }
    if (raw.length > MAX_CONTENT) raw = raw.slice(0, MAX_CONTENT)
    const titleLine = raw.split('\n').find((line) => line.startsWith('# '))
    const name = (titleLine ? titleLine.slice(2).trim() : file.replace(/\.md$/i, '')) || file
    createNode(ownerId, { parentId: folder.node.id, kind: 'file', name, content: raw })
  }
}

export function listLibrary(ownerId) {
  maybeSeed(ownerId)
  return { nodes: loadTree(ownerId).nodes.map((node) => publicNode(node, false)) }
}

export function getLibraryNode(ownerId, id) {
  maybeSeed(ownerId)
  if (typeof id !== 'string' || !id) return null
  const node = loadTree(ownerId).nodes.find((item) => item.id === id)
  return node ? publicNode(node, true) : null
}

export function createLibraryNode(ownerId, input) {
  maybeSeed(ownerId)
  return createNode(ownerId, input ?? {})
}

export function updateLibraryNode(ownerId, { id, name, content, parentId } = {}) {
  maybeSeed(ownerId)
  const tree = loadTree(ownerId)
  const node = tree.nodes.find((item) => item.id === id)
  if (!node) return { error: '找不到文档。' }
  if (name !== undefined) {
    const clean = sanitizeName(name, node.kind)
    if (!clean) return { error: '名字无效。' }
    const unique = uniqueName(tree.nodes, node.parentId, clean, node.id)
    if (!unique) return { error: '名字冲突。' }
    node.name = unique
  }
  if (parentId !== undefined) {
    const parent = parentId || null
    if (parent === node.id) return { error: '不能移到自己里面。' }
    if (!parentOk(tree.nodes, parent)) return { error: '文件夹不存在。' }
    if (node.kind === 'folder' && parent && isDescendant(tree.nodes, node.id, parent)) return { error: '不能移到子文件夹里。' }
    const unique = uniqueName(tree.nodes, parent, node.name, node.id)
    if (!unique) return { error: '名字冲突。' }
    node.parentId = parent
    node.name = unique
  }
  if (content !== undefined) {
    if (node.kind !== 'file') return { error: '文件夹没有正文。' }
    if (typeof content !== 'string') return { error: '正文无效。' }
    if (content.length > MAX_CONTENT) return { error: '正文太长。' }
    node.content = content
  }
  node.updatedAt = new Date().toISOString()
  saveTree(ownerId, tree)
  return { node: publicNode(node, true) }
}

export function deleteLibraryNode(ownerId, id) {
  const tree = loadTree(ownerId)
  if (!tree.nodes.some((node) => node.id === id)) return { error: '找不到文档。' }
  const drop = new Set()
  const collect = (current) => {
    drop.add(current)
    for (const node of tree.nodes) if (node.parentId === current) collect(node.id)
  }
  collect(id)
  tree.nodes = tree.nodes.filter((node) => !drop.has(node.id))
  saveTree(ownerId, tree)
  return { ok: true }
}

/** Bot keep: write a free markdown file and return an in-app link. */
export function keepMarkdown(ownerId, { folderName = '笔记', name, content } = {}) {
  maybeSeed(ownerId)
  const tree = loadTree(ownerId)
  let folder = tree.nodes.find((node) => node.kind === 'folder' && !node.parentId && node.name === folderName)
  if (!folder) {
    const made = createNode(ownerId, { kind: 'folder', name: folderName })
    if (made.error) return made
    folder = made.node
  }
  const file = createNode(ownerId, {
    parentId: folder.id,
    kind: 'file',
    name: name || '笔记',
    content: typeof content === 'string' ? content : '',
  })
  if (file.error) return file
  const label = file.node.name.replace(/\.md$/i, '')
  return {
    node: file.node,
    link: { href: `doc://${file.node.id}`, label },
  }
}

function fail(status, message) {
  return { status, body: { ok: false, error: { message } } }
}

function assetKey(id) {
  return `library-asset:${id}`
}

export function requestOrigin(req) {
  const forwardedProto = typeof req?.headers?.['x-forwarded-proto'] === 'string'
    ? req.headers['x-forwarded-proto'].split(',')[0].trim()
    : ''
  const proto = forwardedProto || (req?.socket?.encrypted ? 'https' : 'http')
  const forwardedHost = typeof req?.headers?.['x-forwarded-host'] === 'string'
    ? req.headers['x-forwarded-host'].split(',')[0].trim()
    : ''
  const host = forwardedHost || (typeof req?.headers?.host === 'string' ? req.headers.host : '')
  return host ? `${proto}://${host}` : ''
}

export function assetPublicUrl(origin, id) {
  const pathname = `/api/library/asset/${id}`
  return origin ? `${String(origin).replace(/\/$/, '')}${pathname}` : pathname
}

export function matchLibraryAssetPath(pathname) {
  if (pathname === '/api/library/asset' || pathname === '/api/library/assets') return { index: true }
  const match = /^\/api\/library\/asset\/([a-f0-9]{32})$/.exec(pathname || '')
  return match ? { id: match[1] } : null
}

function normalizeMediaType(contentType) {
  const type = String(contentType || '').toLowerCase().split(';')[0].trim()
  if (type === 'image/jpg') return 'image/jpeg'
  return type
}

function mediaKind(contentType) {
  if (IMAGE_TYPES.has(contentType)) return 'image'
  if (VIDEO_TYPES.has(contentType)) return 'video'
  return ''
}

function mediaMagicOk(bytes, contentType) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12) return false
  if (contentType === 'image/png') return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  if (contentType === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  if (contentType === 'image/gif') return bytes.subarray(0, 4).toString('ascii') === 'GIF8'
  if (contentType === 'image/webp') return bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  if (contentType === 'video/mp4') return bytes.subarray(4, 8).toString('ascii') === 'ftyp'
  if (contentType === 'video/webm') return bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3
  return false
}

function saveAssetBytes(ownerId, bytes, contentType) {
  const type = normalizeMediaType(contentType)
  const kind = mediaKind(type)
  if (!kind) return { error: '只接受 png、jpeg、gif、webp、mp4、webm。' }
  const max = kind === 'video' ? MAX_VIDEO : MAX_IMAGE
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > max) {
    return { error: kind === 'video' ? '视频太大或是空的。' : '图片太大或是空的。' }
  }
  if (!mediaMagicOk(bytes, type)) return { error: kind === 'video' ? '视频内容和格式对不上。' : '图片内容和格式对不上。' }
  const id = randomBytes(16).toString('hex')
  kvSet(assetKey(id), {
    id,
    owner_user_id: ownerId,
    content_type: type,
    data: bytes.toString('base64'),
    created_at: new Date().toISOString(),
  })
  return { id, contentType: type }
}

export function readLibraryAsset(id) {
  if (!ASSET_ID.test(id || '')) return null
  const row = kvGet(assetKey(id))
  if (!row || typeof row.data !== 'string' || !mediaKind(row.content_type)) return null
  const bytes = Buffer.from(row.data, 'base64')
  if (!mediaMagicOk(bytes, row.content_type)) return null
  return { id, contentType: row.content_type, bytes }
}

function decodeBase64(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  const cleaned = value.trim().replace(/^data:[^,]*,/, '').replace(/\s/g, '')
  if (!/^[a-z0-9+/]+={0,2}$/i.test(cleaned)) return null
  const bytes = Buffer.from(cleaned, 'base64')
  return bytes.length ? bytes : null
}

function assetIdFromUrl(url) {
  try {
    const parsed = url.startsWith('/') ? new URL(url, 'http://asset.local') : new URL(url)
    const match = /^\/api\/library\/asset\/([a-f0-9]{32})$/.exec(parsed.pathname)
    return match ? match[1] : ''
  } catch {
    return ''
  }
}

function collectMediaSources(markdown) {
  const found = []
  const push = (url) => {
    if (typeof url === 'string' && url && !found.includes(url)) found.push(url)
  }
  for (const match of markdown.matchAll(/!\[[^\]]*\]\(\s*<?([^\s)>]+)>?/g)) push(match[1])
  for (const match of markdown.matchAll(/<(?:img|video|source)\b[^>]*?\ssrc\s*=\s*(?:"([^"]+)"|'([^']+)')/gi)) push(match[1] || match[2])
  return found.sort((a, b) => b.length - a.length)
}

function replaceLiteral(text, from, to) {
  return from && from !== to ? text.split(from).join(to) : text
}

function parseDataMedia(url) {
  const match = /^data:(image\/(?:png|jpe?g|gif|webp)|video\/(?:mp4|webm));base64,([a-z0-9+/=\s]+)$/i.exec(url)
  if (!match) return null
  const bytes = Buffer.from(match[2].replace(/\s/g, ''), 'base64')
  return { contentType: normalizeMediaType(match[1]), bytes }
}

function blockedRemoteHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '')
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  if (host === '0.0.0.0' || host === '::1' || host === 'metadata.google.internal') return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!v4) return false
  const n = v4.slice(1).map((part) => Number(part))
  if (n.some((part) => part > 255)) return true
  const [a, b] = n
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

async function mirrorRemoteAsset(ownerId, url) {
  let parsed
  try { parsed = new URL(url) } catch { return null }
  if (parsed.protocol !== 'https:' || blockedRemoteHost(parsed.hostname)) return null
  if (assetIdFromUrl(url)) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 4000)
  try {
    const response = await fetch(url, { redirect: 'manual', signal: controller.signal })
    if (!response.ok || response.status >= 300) return null
    const type = normalizeMediaType(response.headers.get('content-type') || '')
    const bytes = Buffer.from(await response.arrayBuffer())
    const saved = saveAssetBytes(ownerId, bytes, type)
    return saved.error ? null : saved
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function maskCode(markdown) {
  const blocks = []
  const put = (block) => {
    const token = `\u0000CODE${blocks.length}\u0000`
    blocks.push(block)
    return token
  }
  const masked = markdown
    .replace(/```[\s\S]*?```/g, put)
    .replace(/~~~[\s\S]*?~~~/g, put)
    .replace(/`[^`\n]*`/g, put)
  return { masked, blocks }
}

function unmaskCode(text, blocks) {
  return text.replace(/\u0000CODE(\d+)\u0000/g, (all, index) => blocks[Number(index)] ?? all)
}

/** Rewrite image and video targets to absolute asset URLs. Other markdown is left as written. */
export async function materializeMarkdownMedia(ownerId, markdown, origin) {
  if (typeof markdown !== 'string') return { error: '正文无效。' }
  const { masked, blocks } = maskCode(markdown)
  let next = masked
  for (const url of collectMediaSources(masked)) {
    if (url.startsWith('blob:')) return { error: '图片或视频还停在这次会话里，请重新上传。' }
    const existing = assetIdFromUrl(url)
    if (existing) {
      if (!readLibraryAsset(existing)) return { error: '媒体地址无效。' }
      next = replaceLiteral(next, url, assetPublicUrl(origin, existing))
      continue
    }
    if (url.startsWith('data:')) {
      const parsed = parseDataMedia(url)
      if (!parsed) return { error: '这个文件的格式不支持。' }
      const saved = saveAssetBytes(ownerId, parsed.bytes, parsed.contentType)
      if (saved.error) return saved
      next = replaceLiteral(next, url, assetPublicUrl(origin, saved.id))
      continue
    }
    if (/^https:\/\//i.test(url)) {
      const mirrored = await mirrorRemoteAsset(ownerId, url)
      if (mirrored?.id) next = replaceLiteral(next, url, assetPublicUrl(origin, mirrored.id))
    }
  }
  return { markdown: unmaskCode(next, blocks) }
}

export async function handleLibraryControl(req, endpoint, payload, user) {
  const ownerId = mediaOwnerIdFor(user)
  if (!ownerId) return fail(401, '请先登录')
  const body = payload && typeof payload === 'object' ? payload : {}
  if (endpoint === 'library/asset') {
    const bytes = decodeBase64(body.data)
    const video = normalizeMediaType(body.contentType).startsWith('video/')
    if (!bytes) return fail(400, video ? '视频数据无效。' : '图片数据无效。')
    const saved = saveAssetBytes(ownerId, bytes, body.contentType)
    if (saved.error) return fail(400, saved.error)
    return { status: 200, body: { ok: true, id: saved.id, url: assetPublicUrl(requestOrigin(req), saved.id), contentType: saved.contentType } }
  }
  return handleLibraryDocument(req, endpoint, body, ownerId)
}

async function handleLibraryDocument(req, endpoint, body, ownerId) {
  const prepared = async (content) => {
    if (content === undefined) return {}
    return materializeMarkdownMedia(ownerId, content, requestOrigin(req))
  }
  if (endpoint === 'library/list') {
    return { status: 200, body: { ok: true, ...listLibrary(ownerId) } }
  }
  if (endpoint === 'library/get') {
    const node = getLibraryNode(ownerId, body.id)
    if (!node) return fail(404, '找不到文档。')
    return { status: 200, body: { ok: true, node } }
  }
  if (endpoint === 'library/create') {
    const images = body.kind === 'file' ? await prepared(body.content ?? '') : {}
    if (images.error) return fail(400, images.error)
    const made = createLibraryNode(ownerId, {
      parentId: body.parentId ?? null,
      kind: body.kind,
      name: body.name,
      content: images.markdown ?? body.content,
    })
    if (made.error) return fail(400, made.error)
    return { status: 200, body: { ok: true, node: made.node } }
  }
  if (endpoint === 'library/update') {
    const images = body.content === undefined ? {} : await prepared(body.content)
    if (images.error) return fail(400, images.error)
    const updated = updateLibraryNode(ownerId, {
      id: body.id,
      name: body.name,
      content: images.markdown,
      parentId: Object.hasOwn(body, 'parentId') ? body.parentId : undefined,
    })
    if (updated.error) return fail(updated.error === '找不到文档。' ? 404 : 400, updated.error)
    return { status: 200, body: { ok: true, node: updated.node } }
  }
  if (endpoint === 'library/delete') {
    const removed = deleteLibraryNode(ownerId, body.id)
    if (removed.error) return fail(404, removed.error)
    return { status: 200, body: { ok: true } }
  }
  return fail(404, '未知接口。')
}
