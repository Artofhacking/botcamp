// Demox production gateway. The browser stays on botcamp.demox.site. This function
// uses the same account gate as app/kernelProxy.mjs: email login, quotas, and one
// workspace directory per account. Unauthenticated /api/bot is rejected here.
// Kernel cookies and launch tokens stay in this process.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const KERNEL = 'https://camp.aigc.sx.cn'
const ENV_KEYS = [
  'BOTCAMP_DATA_DIR',
  'BOTCAMP_ADMIN_EMAIL',
  'BOTCAMP_ADMIN_PASSWORD',
  'BOTCAMP_DEFAULT_QUOTA',
  'BOTCAMP_PRODUCTION',
  'NODE_ENV',
  'DSH_KERNEL_ORIGIN',
]

let active = null

function gateFile() {
  const bundled = path.join(__dirname, 'botcamp', 'http.mjs')
  if (fs.existsSync(bundled)) return bundled
  return path.join(__dirname, '..', '..', 'app', 'botcamp', 'http.mjs')
}

function picked(source) {
  const out = {}
  if (!source || typeof source !== 'object') return out
  for (const key of ENV_KEYS) {
    if (typeof source[key] === 'string' && source[key] !== '') out[key] = source[key]
  }
  return out
}

function campEnv(requestEnv) {
  return {
    NODE_ENV: 'production',
    BOTCAMP_PRODUCTION: '1',
    ...picked(process.env),
    ...picked(requestEnv),
  }
}

async function campFor(requestEnv) {
  const env = campEnv(requestEnv)
  const dataDir = env.BOTCAMP_DATA_DIR || path.join(os.tmpdir(), 'botcamp-data')
  if (active && active.dataDir === dataDir) return active.camp
  const { createBotcamp } = await import(pathToFileURL(gateFile()).href)
  const camp = await createBotcamp({
    dataDir,
    env,
    kernelOrigin: env.DSH_KERNEL_ORIGIN || KERNEL,
    fetchImpl: (url, init) => globalThis.fetch(url, init),
    feed: { maxMs: 2500, maxBytes: 64 * 1024, stopAfterEvent: true },
  })
  active = { dataDir, camp }
  return camp
}

function pathOf(request) {
  const raw = request?.path || request?.rawPath || request?.route || request?.url || '/'
  try {
    if (String(raw).includes('://')) return new URL(String(raw)).pathname || '/'
  } catch {
    // already a path
  }
  const value = String(raw).split('?')[0] || '/'
  return value.length > 1 && value.endsWith('/') ? value.slice(0, -1) : value
}

function routeOf(request) {
  const pathName = pathOf(request)
  if (pathName === '/api/bot/feed' || pathName.endsWith('/api/bot/feed')) return '/api/bot/feed'
  if (pathName.startsWith('/api/auth') || pathName.startsWith('/api/admin') || pathName === '/api/bot') return pathName
  if (pathName.endsWith('/api/bot')) return '/api/bot'
  return '/api/bot'
}

function scrub(text) {
  return String(text == null ? '' : text)
    .replace(/([?&#])token=[^&#\s"'<>]*/gi, '$1token=')
    .replace(/dsh-auth-[^=;\s"']*=[^;\s"']*/gi, 'dsh-auth=')
}

function requestHeaders(request) {
  const headers = {}
  const raw = request?.headers
  if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw)) {
      if (value == null) continue
      headers[key] = Array.isArray(value) ? value.join(', ') : String(value)
    }
  }
  return headers
}

exports.handler = async (request, env) => {
  try {
    const { invokeBotcamp } = await import(pathToFileURL(gateFile()).href)
    const camp = await campFor(env || {})
    const result = await invokeBotcamp(camp, {
      method: request?.method,
      path: routeOf(request || {}),
      headers: requestHeaders(request),
      body: request?.body,
      isBase64Encoded: request?.isBase64Encoded,
    })
    return {
      statusCode: result.statusCode,
      headers: result.headers,
      body: scrub(result.body),
    }
  } catch {
    return {
      statusCode: 502,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
      body: JSON.stringify({ ok: false, error: { message: '暂时连不上内核。' } }),
    }
  }
}
