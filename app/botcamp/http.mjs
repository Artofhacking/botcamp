import { CROSS_MESSAGE, QUOTA_MESSAGE, claimCreated, createAccess, decide, feedBlockAllowed, feedMessageItem, localValue, mergePrefs, releaseDeleted, rewriteValue, stateRequestPayload } from './isolate.mjs'
import { usageRequestPayload } from './scope.mjs'
import { defaultDataDir, defaultQuota, openStore } from './store.mjs'
import { applyUserSetting } from './userSettings.mjs'

const COOKIE = 'botcamp_session'
const SESSION_MAX_AGE = 14 * 24 * 60 * 60
const JSON_LIMIT = 1024 * 1024
const BOT_LIMIT = 20 * 1024 * 1024

function routePath(url) {
  const path = (url ?? '').split('?')[0]
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}

function sendJson(res, status, body, headers = {}) {
  if (res.writableEnded || res.destroyed) return
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value)
  res.end(JSON.stringify(body))
}

function readCookie(req, name) {
  const header = req.headers.cookie
  if (typeof header !== 'string') return ''
  for (const part of header.split(';')) {
    const trimmed = part.trim()
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    if (trimmed.slice(0, eq) === name) {
      try { return decodeURIComponent(trimmed.slice(eq + 1)) } catch { return '' }
    }
  }
  return ''
}

function secureRequest(req) {
  if (req.socket?.encrypted) return true
  const proto = req.headers['x-forwarded-proto']
  return typeof proto === 'string' && proto.split(',')[0].trim() === 'https'
}

function sessionCookie(token, req, maxAge) {
  const parts = [`${COOKIE}=${encodeURIComponent(token)}`, 'HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${maxAge}`]
  if (secureRequest(req)) parts.push('Secure')
  return parts.join('; ')
}

async function readBody(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > limit) {
      const error = new Error('body too large')
      error.code = 'LIMIT'
      throw error
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

async function readJson(req, limit) {
  const raw = await readBody(req, limit)
  if (raw.length === 0) return {}
  return JSON.parse(raw.toString('utf8'))
}

function refused(message) {
  return { ok: false, error: { code: 'bot/refused', message } }
}

export async function createBotcamp(options = {}) {
  const env = options.env ?? process.env
  const kernelOrigin = (options.kernelOrigin ?? env.DSH_KERNEL_ORIGIN ?? 'https://camp.aigc.sx.cn').replace(/\/$/, '')
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const dataDir = options.dataDir ?? (typeof env.BOTCAMP_DATA_DIR === 'string' && env.BOTCAMP_DATA_DIR.trim() ? env.BOTCAMP_DATA_DIR.trim() : defaultDataDir())
  const store = await openStore(dataDir)
  const boot = await store.bootstrap(env)
  if (boot.created) console.info('[botcamp] 已创建引导管理员。')
  else if ((await store.listUsers()).length === 0) console.warn('[botcamp] 用户库为空。设置 BOTCAMP_ADMIN_EMAIL 和 BOTCAMP_ADMIN_PASSWORD 后重启，才会创建管理员。')

  const jar = new Map()

  function cookieHeader() {
    return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
  }

  function storeCookies(response) {
    const headers = response.headers
    const list = typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : (headers.get('set-cookie') ? [headers.get('set-cookie')] : [])
    for (const cookie of list) {
      const pair = cookie.split(';', 1)[0] ?? ''
      const eq = pair.indexOf('=')
      if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
    }
  }

  async function refreshCookie() {
    jar.clear()
    let url = `${kernelOrigin}/`
    for (let hop = 0; hop < 6; hop += 1) {
      const response = await fetchImpl(url, {
        redirect: 'manual',
        headers: cookieHeader() ? { cookie: cookieHeader() } : {},
      })
      storeCookies(response)
      const location = response.headers.get('location')
      await response.body?.cancel().catch(() => {})
      if (!location || response.status < 300 || response.status >= 400) break
      url = new URL(location, url).toString()
    }
  }

  async function callKernel(pathname, { method, body, signal, namespace }) {
    if (jar.size === 0) await refreshCookie()
    const headers = { origin: kernelOrigin, 'content-type': 'application/json' }
    if (cookieHeader()) headers.cookie = cookieHeader()
    if (typeof namespace === 'string' && /^u_[A-Za-z0-9_-]{8,}$/.test(namespace)) headers['x-botcamp-namespace'] = namespace
    const send = () => fetchImpl(new URL(pathname, `${kernelOrigin}/`), {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : body,
      redirect: 'manual',
      signal,
    })
    let upstream = await send()
    if (upstream.status === 401 && !signal?.aborted) {
      await upstream.body?.cancel().catch(() => {})
      await refreshCookie()
      if (cookieHeader()) headers.cookie = cookieHeader()
      else delete headers.cookie
      upstream = await send()
    }
    storeCookies(upstream)
    return upstream
  }

  async function accessFor(userId) {
    return createAccess(userId, await store.resources())
  }

  async function currentUser(req) {
    return store.userForToken(readCookie(req, COOKIE))
  }

  async function applyLocal(user, endpoint, payload) {
    if (endpoint === 'set-prefs') {
      const updated = await store.setPrefs(user.id, mergePrefs(user.prefs, payload))
      return { user: updated ?? user, value: localValue(endpoint, updated ?? user) }
    }
    if (endpoint === 'set-main') {
      const id = payload?.id
      let ids = [...(user.mainBotIds ?? [])]
      if (payload?.main === false) ids = ids.filter(item => item !== id)
      else ids = [id, ...ids.filter(item => item !== id)]
      const updated = await store.setMain(user.id, ids)
      return { user: updated ?? user, value: localValue(endpoint, updated ?? user) }
    }
    if (endpoint === 'diagnostics' || endpoint === 'diagnostics-log' || endpoint === 'diagnostics-clear') {
      return { user, value: localValue(endpoint, user) }
    }
    const settings = await store.readSettings(user.id)
    const applied = applyUserSetting(settings, endpoint, payload)
    if (applied.error) return { error: applied.error }
    if (applied.settings !== settings) await store.writeSettings(user.id, applied.settings)
    return { user, value: applied.value }
  }

  async function handleAuth(req, res, path) {
    try {
      if (req.method === 'POST' && path === '/api/auth/signup') {
        sendJson(res, 403, { ok: false, error: { code: 'auth/closed', message: '不能自行注册，请联系管理员开通账号。' } })
        return
      }
      if (req.method === 'GET' && path === '/api/auth/me') {
        const user = await currentUser(req)
        if (!user) {
          sendJson(res, 401, { ok: false, error: { code: 'auth/required', message: '请先登录' } })
          return
        }
        sendJson(res, 200, { ok: true, user: store.publicUser(user) })
        return
      }
      if (req.method === 'POST' && path === '/api/auth/login') {
        const body = await readJson(req, JSON_LIMIT)
        const user = await store.authenticate(body?.email, body?.password)
        if (!user) {
          sendJson(res, 401, { ok: false, error: { code: 'auth/invalid', message: '邮箱或密码不正确' } })
          return
        }
        const session = await store.createSession(user.id)
        sendJson(res, 200, { ok: true, user: store.publicUser(user) }, {
          'set-cookie': sessionCookie(session.token, req, SESSION_MAX_AGE),
        })
        return
      }
      if (req.method === 'POST' && path === '/api/auth/logout') {
        await store.deleteSession(readCookie(req, COOKIE))
        sendJson(res, 200, { ok: true }, { 'set-cookie': sessionCookie('', req, 0) })
        return
      }
      sendJson(res, 404, { ok: false, error: { code: 'auth/unknown', message: '未知的登录接口。' } })
    } catch (error) {
      if (error?.code === 'LIMIT') {
        sendJson(res, 413, { ok: false, error: { message: '请求太大。' } })
        return
      }
      if (error instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: { message: '请求格式不正确。' } })
        return
      }
      console.error('[botcamp]', error instanceof Error ? error.message : 'auth failed')
      sendJson(res, 500, { ok: false, error: { message: '登录服务暂时不可用。' } })
    }
  }

  async function handleAdmin(req, res, path, user) {
    if (!user) {
      sendJson(res, 401, { ok: false, error: { code: 'auth/required', message: '请先登录' } })
      return
    }
    if (user.role !== 'admin') {
      sendJson(res, 403, { ok: false, error: { code: 'auth/forbidden', message: '只有管理员可以管理用户和配额。' } })
      return
    }
    try {
      if (req.method === 'GET' && path === '/api/admin/users') {
        sendJson(res, 200, { ok: true, users: await store.listUsers() })
        return
      }
      if (req.method === 'POST' && path === '/api/admin/users') {
        const body = await readJson(req, JSON_LIMIT)
        const created = await store.createUser({
          email: body?.email,
          password: body?.password,
          role: body?.role === undefined ? 'user' : body.role,
          quota: body?.quota === undefined ? defaultQuota(env) : body.quota,
        })
        if (created.error) {
          sendJson(res, 400, { ok: false, error: { message: created.error } })
          return
        }
        sendJson(res, 201, { ok: true, user: created.user })
        return
      }
      const match = path.match(/^\/api\/admin\/users\/([^/]+)$/)
      if (match && (req.method === 'PATCH' || req.method === 'DELETE')) {
        const id = decodeURIComponent(match[1])
        if (req.method === 'DELETE') {
          const result = await store.deleteUser(id, user.id)
          if (result.error) {
            sendJson(res, result.status ?? 400, { ok: false, error: { message: result.error } })
            return
          }
          sendJson(res, 200, { ok: true })
          return
        }
        const body = await readJson(req, JSON_LIMIT)
        const patch = {}
        if (Object.hasOwn(body ?? {}, 'quota')) patch.quota = body.quota
        if (Object.hasOwn(body ?? {}, 'used')) patch.used = body.used
        if (Object.hasOwn(body ?? {}, 'role')) patch.role = body.role
        if (Object.hasOwn(body ?? {}, 'password')) patch.password = body.password
        const result = await store.updateUser(id, patch)
        if (result.error) {
          sendJson(res, result.status ?? 400, { ok: false, error: { message: result.error } })
          return
        }
        sendJson(res, 200, { ok: true, user: result.user })
        return
      }
      sendJson(res, 404, { ok: false, error: { message: '未知的管理接口。' } })
    } catch (error) {
      if (error?.code === 'LIMIT') {
        sendJson(res, 413, { ok: false, error: { message: '请求太大。' } })
        return
      }
      if (error instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: { message: '请求格式不正确。' } })
        return
      }
      console.error('[botcamp]', error instanceof Error ? error.message : 'admin failed')
      sendJson(res, 500, { ok: false, error: { message: '管理服务暂时不可用。' } })
    }
  }

  async function handleBot(req, res, user) {
    const client = new AbortController()
    const onClose = () => { if (!res.writableEnded) client.abort() }
    res.on('close', onClose)
    let charged = false
    try {
      const raw = await readBody(req, BOT_LIMIT)
      let body
      try { body = JSON.parse(raw.length ? raw.toString('utf8') : '{}') } catch {
        sendJson(res, 400, { ok: false, error: { code: 'bot/invalid', message: '请求格式不正确。' } })
        return
      }
      const endpoint = typeof body.endpoint === 'string' ? body.endpoint.trim() : body.endpoint
      const payload = body.payload ?? null
      const access = await accessFor(user.id)
      const decision = decide(endpoint, payload, access, { role: user.role })
      if (decision.action === 'refuse') {
        sendJson(res, 200, refused(decision.message ?? CROSS_MESSAGE))
        return
      }
      if (access.pending().length > 0) await store.commitAccess(user.id, access)
      const reserved = access.pending().map(claim => claim.id)

      if (decision.action === 'local') {
        const applied = await applyLocal(user, endpoint, payload)
        if (applied?.error) {
          sendJson(res, 200, refused(applied.error))
          return
        }
        sendJson(res, 200, { ok: true, value: applied?.value ?? null })
        return
      }
      if (decision.action === 'metered') {
        const charge = await store.tryConsume(user.id)
        if (!charge.ok) {
          sendJson(res, 200, refused(QUOTA_MESSAGE))
          return
        }
        charged = true
      }

      let outboundPayload = payload
      if (endpoint === 'state') outboundPayload = stateRequestPayload(payload, await store.getUser(user.id) ?? user)
      else if (endpoint === 'usage') outboundPayload = usageRequestPayload(payload)
      const upstream = await callKernel('/api/bot', {
        method: 'POST',
        body: JSON.stringify({ endpoint, payload: outboundPayload }),
        signal: client.signal,
        namespace: user.kernelKey,
      })
      const text = await upstream.text()
      let parsed = null
      try { parsed = text ? JSON.parse(text) : null } catch { parsed = null }
      if (charged && (!upstream.ok || parsed?.ok === false)) {
        await store.refund(user.id)
        charged = false
      }
      if (parsed?.ok === false && reserved.length > 0) {
        const rollback = await accessFor(user.id)
        for (const id of reserved) rollback.release(id)
        await store.commitAccess(user.id, rollback)
      }
      if (parsed && typeof parsed === 'object' && Object.hasOwn(parsed, 'value')) {
        const after = await accessFor(user.id)
        const fresh = await store.getUser(user.id) ?? user
        if (parsed.ok !== false) {
          claimCreated(endpoint, parsed.value, after)
          releaseDeleted(endpoint, payload, after)
          if ((endpoint === 'chat' || endpoint === 'earlier') && Array.isArray(parsed.value?.items)) {
            const sessionId = parsed.value.sessionId ?? payload?.sessionId ?? payload?.botId
            await store.rememberPage(user.id, sessionId, parsed.value.items)
          }
        }
        const settings = await store.readSettings(user.id)
        parsed.value = rewriteValue(endpoint, parsed.value, fresh, after, settings)
        if (endpoint === 'usage' && parsed.ok !== false) await store.writeUsage(user.id, parsed.value)
        await store.commitAccess(user.id, after)
        sendJson(res, upstream.status, parsed)
        return
      }
      if (res.writableEnded || res.destroyed) return
      res.statusCode = upstream.status
      const contentType = upstream.headers.get('content-type')
      if (contentType) res.setHeader('content-type', contentType)
      res.setHeader('cache-control', 'no-store')
      res.end(text)
    } catch (error) {
      if (charged) await store.refund(user.id).catch(() => {})
      if (client.signal.aborted || error?.name === 'AbortError') {
        if (!res.writableEnded) res.end()
        return
      }
      if (error?.code === 'LIMIT') {
        sendJson(res, 413, { ok: false, error: { message: '请求太大。' } })
        return
      }
      console.error('[botcamp]', error instanceof Error ? error.message : 'bot proxy failed')
      sendJson(res, 502, { ok: false, error: { code: 'bot/error', message: '暂时连不上内核。' } })
    } finally {
      res.off('close', onClose)
    }
  }

  async function handleFeed(req, res, user) {
    const client = new AbortController()
    const onClose = () => { if (!res.writableEnded) client.abort() }
    res.on('close', onClose)
    try {
      const upstream = await callKernel('/api/bot/feed', {
        method: 'GET',
        signal: client.signal,
        namespace: user.kernelKey,
      })
      if (!upstream.ok || upstream.body == null) {
        await upstream.body?.cancel().catch(() => {})
        sendJson(res, upstream.ok ? 502 : upstream.status, { ok: false, error: { message: '暂时连不上内核。' } })
        return
      }
      if (client.signal.aborted || res.writableEnded) {
        await upstream.body.cancel().catch(() => {})
        return
      }
      res.statusCode = 200
      res.setHeader('content-type', 'text/event-stream; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.setHeader('x-accel-buffering', 'no')
      const reader = upstream.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      const writeBlock = async (block) => {
        const access = await accessFor(user.id)
        if (!feedBlockAllowed(block, access)) return
        await store.commitAccess(user.id, access)
        const message = feedMessageItem(block)
        if (message) await store.appendItem(user.id, message.sessionId, message.item)
        if (!res.writableEnded) res.write(`${block}\n\n`)
      }
      try {
        for (;;) {
          if (client.signal.aborted || res.writableEnded) break
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let split = buffer.indexOf('\n\n')
          while (split >= 0) {
            const block = buffer.slice(0, split)
            buffer = buffer.slice(split + 2)
            if (block.trim() !== '') await writeBlock(block)
            split = buffer.indexOf('\n\n')
          }
        }
      } finally {
        reader.releaseLock()
        await upstream.body.cancel().catch(() => {})
      }
      if (!res.writableEnded) res.end()
    } catch (error) {
      if (client.signal.aborted || error?.name === 'AbortError') {
        if (!res.writableEnded) res.end()
        return
      }
      console.error('[botcamp]', error instanceof Error ? error.message : 'feed failed')
      sendJson(res, 502, { ok: false, error: { message: '暂时连不上内核。' } })
    } finally {
      res.off('close', onClose)
    }
  }

  async function handle(req, res, next) {
    const path = routePath(req.url)
    if (!path.startsWith('/api/')) {
      next()
      return
    }
    if (path.startsWith('/api/auth')) {
      await handleAuth(req, res, path)
      return
    }
    const user = await currentUser(req)
    if (path.startsWith('/api/admin')) {
      await handleAdmin(req, res, path, user)
      return
    }
    if (!user) {
      sendJson(res, 401, { ok: false, error: { code: 'auth/required', message: '请先登录' } })
      return
    }
    if (path === '/api/bot' && req.method === 'POST') {
      await handleBot(req, res, user)
      return
    }
    if (path === '/api/bot/feed' && (req.method === 'GET' || req.method === 'HEAD')) {
      await handleFeed(req, res, user)
      return
    }
    sendJson(res, 404, { ok: false, error: { message: '未知接口。' } })
  }

  return { store, handle, idle: () => store.idle() }
}
