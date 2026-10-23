// The installed client is not a website on the API's origin. It asks for a
// session token and sends it as a bearer. The same call works on Windows now
// and on macOS, Android, and iOS later. The website keeps using its cookie.

const SESSION_KEY = 'botcamp.session'

export function clientMode(env = import.meta.env ?? {}) {
  return env?.VITE_BOTCAMP_CLIENT === '1'
}

export function apiBase(env = import.meta.env ?? {}) {
  const value = env?.VITE_BOTCAMP_API
  return typeof value === 'string' ? value.replace(/\/$/, '') : ''
}

export function isBotcampApi(url) {
  if (typeof url !== 'string' || url.length === 0) return false
  const path = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '')
  const bare = path.replace(/^\.\//, '').replace(/^\//, '').split('?')[0]
  return bare === 'api/bot' || bare === 'api/bot/feed' || bare.startsWith('api/auth') || bare.startsWith('api/admin')
}

export function endpointUrl(base, url) {
  const path = String(url).replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '')
  const suffix = path.replace(/^\.\//, '').replace(/^\//, '')
  const root = String(base ?? '').replace(/\/$/, '')
  return root ? `${root}/${suffix}` : suffix
}

export function applyClientHeaders(headers, token) {
  const next = new Headers(headers || undefined)
  next.set('x-botcamp-client', '1')
  if (token) next.set('authorization', `Bearer ${token}`)
  return next
}

export function detectPlatform(nav) {
  const source = nav ?? (typeof navigator === 'undefined' ? { userAgent: '', platform: '' } : navigator)
  const ua = `${source.userAgent ?? ''} ${source.userAgentData?.platform ?? ''} ${source.platform ?? ''}`
  if (/android/i.test(ua)) return 'android'
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios'
  if (/Mac/i.test(ua)) return 'macos'
  if (/Win/i.test(ua)) return 'windows'
  return 'linux'
}

export function readToken() {
  try { return localStorage.getItem(SESSION_KEY) || '' } catch { return '' }
}

export function saveToken(token) {
  try { localStorage.setItem(SESSION_KEY, token) } catch { /* the window can still finish this login */ }
}

export function clearToken() {
  try { localStorage.removeItem(SESSION_KEY) } catch { /* already gone */ }
}

export function installClientFetch(target = globalThis) {
  if (!clientMode() || target.__botcampFetch || typeof target.fetch !== 'function') return
  const native = target.fetch.bind(target)
  target.__botcampFetch = true
  target.fetch = (input, init = {}) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url
    if (!isBotcampApi(raw)) return native(input, init)
    const headers = applyClientHeaders(init.headers ?? input?.headers, readToken())
    return native(endpointUrl(apiBase(), raw), { ...init, headers, credentials: 'omit' })
  }
}
