import { Readable } from 'node:stream'
import { createBotcamp } from './http.mjs'

// Demox invokes functions/bot with its own request shape. The decision is still
// the BotCamp gate: a missing session is 401, and a signed-in caller cannot
// write the shared model catalog or read someone else's usage.
let campPromise = null

export function resetDemoxCamp() {
  campPromise = null
}

function defaultCamp() {
  campPromise ??= createBotcamp()
  return campPromise
}

function headerMap(headers) {
  const out = {}
  if (!headers || typeof headers !== 'object') return out
  for (const [key, value] of Object.entries(headers)) {
    if (value == null) continue
    out[String(key).toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value)
  }
  return out
}

function pathOf(request) {
  const raw = request?.path || request?.rawPath || request?.url || '/'
  let path = String(raw)
  try {
    if (path.includes('://')) path = new URL(path).pathname || '/'
  } catch {
    // already a path
  }
  path = path.split('?')[0] || '/'
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}

function bodyText(request) {
  const body = request?.body
  if (body == null || body === '') return ''
  if (typeof body === 'string') {
    if (request?.isBase64Encoded) return Buffer.from(body, 'base64').toString('utf8')
    return body
  }
  return JSON.stringify(body)
}

export async function handleDemox(request, _env = {}, options = {}) {
  const camp = options.camp ?? await defaultCamp()
  const method = String(request?.method || 'GET').toUpperCase()
  const text = bodyText(request || {})
  const req = Readable.from(method === 'GET' || method === 'HEAD' || text === '' ? [] : [Buffer.from(text)])
  req.method = method
  req.url = pathOf(request || {})
  req.headers = headerMap(request?.headers)
  req.socket = {}
  const chunks = []
  const response = await new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      headers: {},
      writableEnded: false,
      destroyed: false,
      setHeader(name, value) { this.headers[String(name).toLowerCase()] = value },
      write(chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
        return true
      },
      end(chunk) {
        if (chunk) this.write(chunk)
        this.writableEnded = true
        resolve(this)
      },
      on() { return this },
      off() { return this },
    }
    Promise.resolve(camp.handle(req, res, () => {
      res.statusCode = 404
      res.end()
    })).catch(reject)
  })
  return {
    statusCode: response.statusCode,
    headers: { ...response.headers, 'cache-control': 'no-store' },
    body: Buffer.concat(chunks).toString('utf8'),
  }
}
