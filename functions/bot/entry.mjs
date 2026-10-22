import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createBotcamp } from '../../app/botcamp/http.mjs'
import { createHttpLedger } from '../../app/botcamp/projectLedger.mjs'

const gates = new Map()
const FEED_MS = 2500

function headerMap(request) {
  const out = {}
  const raw = request?.headers ?? request?.multiValueHeaders ?? {}
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const key = String(item?.key ?? item?.name ?? '').toLowerCase()
      const value = Array.isArray(item?.value) ? item.value.join('; ') : String(item?.value ?? '')
      if (!key) continue
      out[key] = out[key] ? `${out[key]}; ${value}` : value
    }
  } else if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw)) {
      const name = key.toLowerCase()
      const text = Array.isArray(value) ? value.join('; ') : String(value ?? '')
      out[name] = out[name] ? `${out[name]}; ${text}` : text
    }
  }
  if (!out.cookie && request?.cookies && typeof request.cookies === 'object' && !Array.isArray(request.cookies)) {
    out.cookie = Object.entries(request.cookies).map(([key, value]) => `${key}=${value}`).join('; ')
  }
  if (!out['x-forwarded-proto']) out['x-forwarded-proto'] = 'https'
  return out
}

function requestPath(request) {
  const raw = request?.path || request?.rawPath || request?.route || request?.url || '/'
  let path = String(raw)
  try {
    if (path.includes('://')) path = new URL(path).pathname || '/'
  } catch {
    // already a path
  }
  path = path.split('?')[0] || '/'
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1)
  return path
}

function requestMethod(request) {
  return String(request?.method || request?.httpMethod || 'GET').toUpperCase()
}

async function requestBody(request) {
  const body = request?.body
  if (body == null || body === '') {
    if (typeof request?.text === 'function') return await request.text()
    return ''
  }
  if (typeof body === 'string') {
    if (request?.isBase64Encoded) return Buffer.from(body, 'base64').toString('utf8')
    return body
  }
  if (typeof body === 'object' && typeof body.getReader === 'function' && typeof request.text === 'function') {
    return await request.text()
  }
  if (Buffer.isBuffer(body)) return body.toString('utf8')
  if (typeof body === 'object') return JSON.stringify(body)
  return String(body)
}

function scrub(text) {
  return String(text ?? '')
    .replace(/([?&#])token=[^&#\s"'<>]*/gi, '$1token=')
    .replace(/dsh-auth-[^=;\s"']*=[^;\s"']*/gi, 'dsh-auth=')
    .replace(/x-botcamp-exchange:\s*\S+/gi, 'x-botcamp-exchange')
}

export function runtimeEnv(functionEnv) {
  const extra = functionEnv && typeof functionEnv === 'object' ? functionEnv : {}
  return {
    ...process.env,
    ...extra,
    NODE_ENV: 'production',
    BOTCAMP_PRODUCTION: '1',
  }
}

function explicitDataDir(env) {
  return typeof env.BOTCAMP_DATA_DIR === 'string' ? env.BOTCAMP_DATA_DIR.trim() : ''
}

function gateFor(env, fetchImpl) {
  const project = env.BOTCAMP_STORE === 'demox-project'
  const configured = explicitDataDir(env)
  const key = project ? `project:${env.BOTCAMP_PROJECT_ID || ''}` : (configured || 'dev')
  const existing = gates.get(key)
  if (existing) return existing
  const pending = (async () => {
    if (project) {
      const dataDir = await mkdtemp(path.join(os.tmpdir(), 'botcamp-cache-'))
      const ledger = createHttpLedger({
        fetchImpl: fetchImpl ?? globalThis.fetch,
        apiUrl: env.BOTCAMP_PROJECT_API || undefined,
        token: env.BOTCAMP_STORE_TOKEN,
        projectId: env.BOTCAMP_PROJECT_ID,
      })
      return createBotcamp({ env, dataDir, fetchImpl, ledger })
    }
    if (!configured || configured === '/tmp' || configured === '/tmp/botcamp-data') {
      const error = new Error('生产函数不能把账本放在会清空的目录。请设置 BOTCAMP_STORE=demox-project。')
      error.code = 'STORE'
      throw error
    }
    return createBotcamp({ env, dataDir: configured, fetchImpl })
  })().catch((error) => {
    gates.delete(key)
    throw error
  })
  gates.set(key, pending)
  return pending
}

function listen(res) {
  const events = new Map()
  res.on = (name, fn) => {
    const list = events.get(name) ?? []
    list.push(fn)
    events.set(name, list)
    return res
  }
  res.off = (name, fn) => {
    events.set(name, (events.get(name) ?? []).filter(item => item !== fn))
    return res
  }
  res.emit = (name) => {
    for (const fn of [...(events.get(name) ?? [])]) fn()
  }
  return res
}

async function invoke(gate, { method, url, headers, rawBody, feed }) {
  const gateHandle = (await gate).handle
  const chunks = []
  const responseHeaders = {}
  let finished = false
  let finish
  const done = new Promise(resolve => { finish = resolve })
  let timer = null
  const complete = () => {
    if (finished) return
    finished = true
    if (timer) clearTimeout(timer)
    finish({
      statusCode: res.statusCode || 200,
      headers: responseHeaders,
      body: Buffer.concat(chunks).toString('utf8'),
    })
  }
  const req = {
    method,
    url,
    headers,
    socket: {},
    async *[Symbol.asyncIterator]() {
      if (rawBody) yield Buffer.from(rawBody)
    },
  }
  const res = listen({
    statusCode: 200,
    writableEnded: false,
    closing: false,
    destroyed: false,
    setHeader(name, value) { responseHeaders[String(name).toLowerCase()] = String(value) },
    write(chunk) {
      if (this.writableEnded || this.closing) return false
      chunks.push(Buffer.from(chunk))
      if (feed && Buffer.concat(chunks).toString('utf8').includes('\n\n')) this.end()
      return true
    },
    end(chunk) {
      if (this.writableEnded || this.closing) return this
      this.closing = true
      if (chunk) chunks.push(Buffer.from(chunk))
      // Close while writableEnded is still false so the gateway aborts the kernel stream.
      this.emit('close')
      this.writableEnded = true
      complete()
      return this
    },
  })
  timer = setTimeout(() => {
    if (!res.writableEnded) res.end()
  }, feed ? FEED_MS : 25000)
  try {
    await gateHandle(req, res, () => {
      if (!res.writableEnded && !res.closing) {
        res.statusCode = 404
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ ok: false, error: { message: '未知接口。' } }))
      }
    })
  } catch {
    if (!res.writableEnded && !res.closing) {
      res.statusCode = 500
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ ok: false, error: { message: '账号服务暂时不可用。' } }))
    }
  }
  if (!res.writableEnded && !res.closing) res.end()
  return done
}

export async function handler(request, functionEnv, deps = {}) {
  try {
    const env = runtimeEnv(functionEnv)
    const gate = gateFor(env, deps.fetchImpl ?? globalThis.fetch)
    const path = requestPath(request || {})
    const method = requestMethod(request || {})
    const headers = headerMap(request || {})
    const rawBody = method === 'GET' || method === 'HEAD' ? '' : await requestBody(request || {})
    const feed = path === '/api/bot/feed'
    const result = await invoke(gate, { method, url: path, headers, rawBody, feed })
    const responseHeaders = {
      'content-type': result.headers['content-type'] || (feed ? 'text/event-stream; charset=utf-8' : 'application/json; charset=utf-8'),
      'cache-control': 'no-store',
    }
    const response = {
      statusCode: result.statusCode,
      headers: responseHeaders,
      body: scrub(result.body),
    }
    if (result.headers['set-cookie']) {
      response.headers['set-cookie'] = result.headers['set-cookie']
      response.multiValueHeaders = { 'set-cookie': [result.headers['set-cookie']] }
    }
    for (const name of ['access-control-allow-origin', 'access-control-allow-headers', 'access-control-allow-methods', 'access-control-max-age']) {
      if (result.headers[name]) response.headers[name] = result.headers[name]
    }
    return response
  } catch {
    return {
      statusCode: 502,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      body: JSON.stringify({ ok: false, error: { message: '暂时连不上内核。' } }),
    }
  }
}
