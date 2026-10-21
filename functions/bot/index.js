// Server-side proxy for the Demox page. The browser stays on botcamp.demox.site.
// camp.aigc.sx.cn is the kernel API. Calls from that page are cross-site and get 403,
// so this function fetches the kernel with the kernel's own Origin and a cookie
// collected by following the launch redirect. The cookie and any launch token stay here.

const KERNEL = 'https://camp.aigc.sx.cn'
const FEED_READ_MS = 2500
const HOP_MS = 4000
const UPSTREAM_MS = 8000
const MAX_FEED_BYTES = 64 * 1024

const jar = new Map()

function readSetCookie(response) {
  const headers = response.headers
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie()
  const single = headers.get('set-cookie')
  return single ? [single] : []
}

function storeCookies(response) {
  for (const cookie of readSetCookie(response)) {
    const pair = String(cookie).split(';', 1)[0] || ''
    const eq = pair.indexOf('=')
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
  }
}

function cookieHeader() {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
}

async function refreshCookie() {
  jar.clear()
  let url = `${KERNEL}/`
  for (let hop = 0; hop < 6; hop += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), HOP_MS)
    let response
    try {
      const headers = { origin: KERNEL }
      if (cookieHeader()) headers.cookie = cookieHeader()
      response = await fetch(url, {
        redirect: 'manual',
        headers,
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
    storeCookies(response)
    await response.body?.cancel().catch(() => {})
    const location = response.headers.get('location')
    if (!location || response.status < 300 || response.status >= 400) break
    const next = new URL(location, url)
    if (next.origin !== KERNEL) break
    url = next.toString()
  }
}

function pathOf(request) {
  const raw = request?.path || request?.rawPath || request?.route || request?.url || '/'
  try {
    if (String(raw).includes('://')) return new URL(String(raw)).pathname || '/'
  } catch {
    // path is already a path
  }
  const path = String(raw).split('?')[0] || '/'
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}

function isFeed(path) {
  return path === '/api/bot/feed'
}

function scrub(text) {
  return String(text == null ? '' : text)
    .replace(/([?&#])token=[^&#\s"'<>]*/gi, '$1token=')
    .replace(/dsh-auth-[^=;\s"']*=[^;\s"']*/gi, 'dsh-auth=')
}

function json(statusCode, payload) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
    body: JSON.stringify(payload),
  }
}

function upstreamTarget(request, path) {
  const url = new URL(path, `${KERNEL}/`)
  const query = request?.query
  if (query && typeof query === 'object') {
    for (const [key, value] of Object.entries(query)) {
      if (String(key).toLowerCase() === 'token' || value == null) continue
      url.searchParams.set(key, String(value))
    }
  }
  return url
}

async function upstreamBody(method, request) {
  if (method === 'GET' || method === 'HEAD') return undefined
  const body = request?.body
  if (typeof body === 'string') {
    if (request?.isBase64Encoded) return Buffer.from(body, 'base64').toString('utf8')
    return body
  }
  if (body == null || body === '') {
    if (typeof request?.text === 'function') {
      const text = await request.text()
      return text || undefined
    }
    return undefined
  }
  if (typeof body === 'object' && typeof body.getReader === 'function' && typeof request.text === 'function') {
    const text = await request.text()
    return text || undefined
  }
  if (typeof body === 'object') return JSON.stringify(body)
  return String(body)
}

async function send(request, path) {
  const method = String(request?.method || 'GET').toUpperCase()
  const headers = {
    origin: KERNEL,
    accept: isFeed(path) ? 'text/event-stream' : 'application/json',
  }
  const cookie = cookieHeader()
  if (cookie) headers.cookie = cookie
  const body = await upstreamBody(method, request)
  if (body !== undefined) headers['content-type'] = 'application/json'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), UPSTREAM_MS)
  try {
    return await fetch(upstreamTarget(request, path), {
      method,
      headers,
      body,
      redirect: 'manual',
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

async function readFeed(response) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = typeof response.text === 'function' ? await response.text() : ''
    const end = text.indexOf('\n\n')
    return scrub(end >= 0 ? text.slice(0, end + 2) : text).slice(0, MAX_FEED_BYTES)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let pending = null
  const deadline = Date.now() + FEED_READ_MS
  try {
    while (Date.now() < deadline && text.length < MAX_FEED_BYTES) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      pending = reader.read()
      const chunk = await Promise.race([
        pending.then((value) => ({ value })),
        new Promise((resolve) => setTimeout(() => resolve(null), remaining)),
      ])
      if (chunk == null) break
      pending = null
      if (chunk.value.done) break
      text += decoder.decode(chunk.value.value, { stream: true })
      const end = text.indexOf('\n\n')
      if (end >= 0) {
        text = text.slice(0, end + 2)
        break
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
    if (pending) await pending.catch(() => {})
    await response.body.cancel().catch(() => {})
  }
  return scrub(text).slice(0, MAX_FEED_BYTES)
}

function publicHeaders(response, feed) {
  const contentType = feed
    ? (response.headers.get('content-type') || 'text/event-stream; charset=utf-8')
    : (response.headers.get('content-type') || 'application/json; charset=utf-8')
  return {
    'content-type': contentType.split(';')[0].toLowerCase().includes('text/event-stream') || !feed
      ? contentType
      : 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
  }
}

async function proxy(request) {
  const path = isFeed(pathOf(request)) ? '/api/bot/feed' : '/api/bot'
  const feed = path === '/api/bot/feed'
  if (jar.size === 0) await refreshCookie()
  let upstream = await send(request, path)
  if (upstream.status === 401 || (upstream.status >= 300 && upstream.status < 400)) {
    await upstream.body?.cancel().catch(() => {})
    await refreshCookie()
    upstream = await send(request, path)
  }
  if (upstream.status >= 300 && upstream.status < 400) {
    await upstream.body?.cancel().catch(() => {})
    return json(502, { error: 'kernel auth failed' })
  }
  if (feed) {
    const body = await readFeed(upstream)
    return { statusCode: upstream.status, headers: publicHeaders(upstream, true), body }
  }
  const body = scrub(typeof upstream.text === 'function' ? await upstream.text() : '')
  return { statusCode: upstream.status, headers: publicHeaders(upstream, false), body }
}

exports.handler = async (request, env) => {
  try {
    return await proxy(request || {}, env)
  } catch {
    return json(502, { error: 'kernel proxy failed' })
  }
}
