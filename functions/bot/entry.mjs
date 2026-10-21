// Demox 云函数入口。浏览器停在 botcamp.demox.site，/api/bot 与 /api/bot/feed
// 先走和 Vite 相同的 createBotcamp：没有 botcamp_session 就 401，不到内核。
// 内核自己的 dsh-auth 只留在这个进程里，不写进响应，也不打日志。
import { createBotcamp } from '../../app/botcamp/http.mjs'

const DATA_DIR = '/tmp/botcamp-data'

let campPromise = null

function runtimeEnv(extra) {
  const merged = { ...process.env }
  if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
    for (const [key, value] of Object.entries(extra)) {
      if (typeof value === 'string') merged[key] = value
    }
  }
  merged.NODE_ENV = 'production'
  merged.BOTCAMP_PRODUCTION = '1'
  if (!merged.BOTCAMP_DATA_DIR) merged.BOTCAMP_DATA_DIR = DATA_DIR
  return merged
}

async function sharedCamp(extra) {
  if (!campPromise) {
    const env = runtimeEnv(extra)
    campPromise = createBotcamp({ env, dataDir: env.BOTCAMP_DATA_DIR })
  }
  return campPromise
}

export function resetDemoxCamp() {
  campPromise = null
}

function methodOf(request) {
  return String(request?.method || request?.httpMethod || 'GET').toUpperCase()
}

function pathOf(request) {
  const raw = request?.path || request?.rawPath || request?.route || request?.url || '/api/bot'
  let path = String(raw)
  try {
    if (path.includes('://')) path = new URL(path).pathname || '/'
  } catch {
    // 已经是路径
  }
  path = path.split('?')[0] || '/'
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1)
  return path
}

function headerMap(request) {
  const source = request?.headers || request?.multiValueHeaders || {}
  const headers = {}
  if (source && typeof source === 'object') {
    for (const [key, value] of Object.entries(source)) {
      const name = String(key).toLowerCase()
      if (Array.isArray(value)) headers[name] = value.map(item => String(item)).join(name === 'cookie' ? '; ' : ', ')
      else if (typeof value === 'string') headers[name] = value
    }
  }
  if (!headers.cookie && request?.cookies && typeof request.cookies === 'object') {
    headers.cookie = Object.entries(request.cookies)
      .filter(([, value]) => typeof value === 'string')
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
      .join('; ')
  }
  if (!headers['x-forwarded-proto']) headers['x-forwarded-proto'] = 'https'
  return headers
}

async function bodyText(request, method) {
  if (method === 'GET' || method === 'HEAD') return ''
  const body = request?.body
  if (typeof body === 'string') {
    if (request?.isBase64Encoded) return Buffer.from(body, 'base64').toString('utf8')
    return body
  }
  if (body == null || body === '') {
    if (typeof request?.text === 'function') {
      const text = await request.text()
      return typeof text === 'string' ? text : ''
    }
    return ''
  }
  if (typeof body === 'object') return JSON.stringify(body)
  return String(body)
}

function createReq(method, url, headers, text) {
  const raw = Buffer.from(text)
  let sent = false
  return {
    method,
    url,
    headers,
    socket: { encrypted: true },
    async *[Symbol.asyncIterator]() {
      if (sent) return
      sent = true
      if (raw.length > 0) yield raw
    },
  }
}

function createRes(feed) {
  const headers = new Map()
  let statusCode = 200
  const chunks = []
  let writableEnded = false
  let destroyed = false
  const listeners = new Set()
  const emitClose = () => {
    for (const fn of [...listeners]) fn()
  }
  const res = {
    get statusCode() { return statusCode },
    set statusCode(value) { statusCode = value },
    get writableEnded() { return writableEnded },
    get destroyed() { return destroyed },
    get headersSent() { return writableEnded },
    setHeader(name, value) { headers.set(String(name).toLowerCase(), String(value)) },
    write(chunk) {
      if (writableEnded) return false
      chunks.push(Buffer.from(chunk))
      // 云函数只能回完整 body。读到第一条事件就停，并让网关取消上游。
      if (feed && Buffer.concat(chunks).includes('\n\n')) {
        emitClose()
        writableEnded = true
        return false
      }
      return true
    },
    end(chunk) {
      if (writableEnded) return
      if (chunk) chunks.push(Buffer.from(chunk))
      writableEnded = true
      emitClose()
    },
    on(event, fn) { if (event === 'close') listeners.add(fn) },
    off(event, fn) { listeners.delete(fn) },
    destroy() { destroyed = true; writableEnded = true },
  }
  return {
    res,
    snapshot() {
      return { statusCode, headers, body: Buffer.concat(chunks).toString('utf8') }
    },
  }
}

function scrub(text) {
  return String(text)
    .replace(/([?&#])token=[^&#\s"'<>]*/gi, '$1token=')
    .replace(/dsh-auth-[^=;\s"']*=[^;\s"']*/gi, 'dsh-auth=')
}

function toResult(snapshot) {
  const headers = { 'cache-control': snapshot.headers.get('cache-control') || 'no-store' }
  const contentType = snapshot.headers.get('content-type')
  if (contentType) headers['content-type'] = contentType
  const cookie = snapshot.headers.get('set-cookie') || ''
  if (cookie.startsWith('botcamp_session=')) headers['set-cookie'] = cookie
  return { statusCode: snapshot.statusCode, headers, body: scrub(snapshot.body) }
}

function failed(statusCode, message) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
    body: JSON.stringify({ ok: false, error: { message } }),
  }
}

export async function handleDemoxRequest(request, env, options = {}) {
  const gate = options.camp ?? await sharedCamp(env)
  const method = methodOf(request)
  const path = pathOf(request)
  const feed = path === '/api/bot/feed'
  const captured = createRes(feed)
  const req = createReq(method, path, headerMap(request), await bodyText(request, method))
  await gate.handle(req, captured.res, () => {
    captured.res.statusCode = 404
    captured.res.setHeader('content-type', 'text/plain; charset=utf-8')
    captured.res.end('not found')
  })
  return toResult(captured.snapshot())
}

export async function handler(request, env) {
  try {
    return await handleDemoxRequest(request || {}, env)
  } catch {
    return failed(502, '暂时连不上内核。')
  }
}
