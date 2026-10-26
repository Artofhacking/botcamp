import {
  buildCompanyState,
  claimCompanyAccess,
  companyChatPage,
  companySend,
  companySessionIds,
  isCompanySessionId,
  mergeProjectRooms,
  viewerCompany,
} from './company.mjs'
import { CROSS_MESSAGE, QUOTA_MESSAGE, claimCreated, createAccess, decide, feedBlockAllowed, feedMessageItem, localValue, mergePrefs, releaseDeleted, rewriteValue, stateRequestPayload } from './isolate.mjs'
import { bindMediaDataDir, grantMediaView, handleMediaControl } from './mediaControl.mjs'
import { handleLibraryControl, LIBRARY_CONTROL, matchLibraryAssetPath, readLibraryAsset } from './library.mjs'
import { handleWhiteboardControl, WHITEBOARD_CONTROL } from './whiteboard.mjs'
import { usageRequestPayload } from './scope.mjs'
import { defaultDataDir, defaultQuota, openStore } from './store.mjs'
import { applyUserSetting } from './userSettings.mjs'
import { DEFAULT_TEAM, provisionDefaultTeam } from './team.mjs'
import { PATH_MESSAGE, materializeFolder, pathsStayInside, runWorkspace, stripPathFields } from './workspace.mjs'

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

function readBearer(req) {
  const header = req.headers.authorization
  if (typeof header !== 'string') return ''
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim())
  return match ? match[1] : ''
}

function readSessionToken(req) {
  return readBearer(req) || readCookie(req, COOKIE)
}

function clientRequest(req) {
  return req.headers['x-botcamp-client'] === '1'
}

function applyCors(res) {
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-headers', 'authorization, content-type, x-botcamp-client')
  res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS')
  res.setHeader('access-control-max-age', '86400')
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

function passwordWall(res, user) {
  if (user?.mustChangePassword !== true) return false
  sendJson(res, 403, { ok: false, error: { code: 'auth/password', message: '请先修改初始密码。' } })
  return true
}

export async function createBotcamp(options = {}) {
  const env = options.env ?? process.env
  const kernelOrigin = (options.kernelOrigin ?? env.DSH_KERNEL_ORIGIN ?? 'https://camp.aigc.sx.cn').replace(/\/$/, '')
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const dataDir = options.dataDir ?? defaultDataDir()
  // Tests / Demox cache: keep MediaAccount KV under the same dataDir. Local default
  // already is repo data/, so seed + botcamp accounts share one tree.
  if (options.dataDir || env.BOTCAMP_DATA_DIR || env.BOTCAMP_STORE === 'demox-project') {
    bindMediaDataDir(dataDir)
  }
  const store = await openStore(dataDir, { ledger: options.ledger ?? null })
  const boot = await store.bootstrap(env)
  if (boot.created) console.info('[botcamp] 已创建引导管理员。')
  else if (boot.empty) console.warn('[botcamp] 用户库为空。设置 BOTCAMP_ADMIN_EMAIL 和 BOTCAMP_ADMIN_PASSWORD 后重启，才会创建管理员。')

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

  function exchangeHeader() {
    const secret = typeof env.BOTCAMP_KERNEL_EXCHANGE === 'string' ? env.BOTCAMP_KERNEL_EXCHANGE.trim() : ''
    return secret ? { 'x-botcamp-exchange': secret } : {}
  }

  async function refreshCookie() {
    jar.clear()
    let url = `${kernelOrigin}/`
    for (let hop = 0; hop < 6; hop += 1) {
      const headers = { ...exchangeHeader() }
      if (cookieHeader()) headers.cookie = cookieHeader()
      const response = await fetchImpl(url, { redirect: 'manual', headers })
      storeCookies(response)
      const location = response.headers.get('location')
      await response.body?.cancel().catch(() => {})
      if (!location || response.status < 300 || response.status >= 400) break
      url = new URL(location, url).toString()
    }
  }

  function withSessionCookie(headers, sessionToken) {
    if (!sessionToken) return
    const pair = `botcamp_session=${encodeURIComponent(sessionToken)}`
    if (!headers.cookie) headers.cookie = pair
    else if (!headers.cookie.includes('botcamp_session=')) headers.cookie = `${headers.cookie}; ${pair}`
  }

  async function callKernel(pathname, { method, body, signal, namespace, sessionToken }) {
    if (jar.size === 0) await refreshCookie()
    const headers = { origin: kernelOrigin, 'content-type': 'application/json' }
    if (cookieHeader()) headers.cookie = cookieHeader()
    // camp 的 /api/ 要求同一条多用户会话。密码不在这里。dsh-auth 仍只留在这个进程里。
    withSessionCookie(headers, sessionToken)
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
      withSessionCookie(headers, sessionToken)
      upstream = await send()
    }
    storeCookies(upstream)
    return upstream
  }

  async function accessFor(userId) {
    return createAccess(userId, await store.resources())
  }

  async function currentUser(req) {
    return store.userForToken(readSessionToken(req))
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
    if (endpoint === 'team-workspace' && typeof payload?.path === 'string' && payload.path && !payload.path.startsWith('/') && !payload.path.includes('..')) {
      const root = await store.ensureUserWorkspace(user.id)
      if (root) {
        const made = await materializeFolder(root, payload.path)
        if (!made) return { error: PATH_MESSAGE }
        await store.syncWorkspace(user.id)
      }
    }
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
        const payload = { ok: true, user: store.publicUser(user) }
        if (clientRequest(req)) payload.token = session.token
        sendJson(res, 200, payload, {
          'set-cookie': sessionCookie(session.token, req, SESSION_MAX_AGE),
        })
        return
      }
      if (req.method === 'POST' && path === '/api/auth/logout') {
        await store.deleteSession(readSessionToken(req))
        sendJson(res, 200, { ok: true }, { 'set-cookie': sessionCookie('', req, 0) })
        return
      }
      if (req.method === 'POST' && path === '/api/auth/password') {
        const user = await currentUser(req)
        if (!user) {
          sendJson(res, 401, { ok: false, error: { code: 'auth/required', message: '请先登录' } })
          return
        }
        const body = await readJson(req, JSON_LIMIT)
        const result = await store.changePassword(user.id, body?.current, body?.next, readSessionToken(req))
        if (result.error) {
          sendJson(res, result.status ?? 400, { ok: false, error: { message: result.error } })
          return
        }
        sendJson(res, 200, { ok: true, user: result.user })
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

  async function provisionTeam(userId, sessionToken) {
    const failedAll = DEFAULT_TEAM.map(member => member.name)
    try {
      const kernelKey = await store.kernelKey(userId)
      const provisioned = await provisionDefaultTeam(callKernel, { kernelKey, sessionToken })
      const created = []
      const failed = [...provisioned.failed]
      for (const item of provisioned.created) {
        const access = await accessFor(userId)
        claimCreated('create-bot', item.value, access)
        const id = typeof item.value?.id === 'string' ? item.value.id : item.value?.bot?.id
        if (typeof id === 'string' && access.owns(id)) {
          await store.commitAccess(userId, access)
          created.push(item.name)
        } else {
          failed.push(item.name)
        }
      }
      return { created, failed }
    } catch (error) {
      console.error('[botcamp]', error instanceof Error ? error.message : 'team provision failed')
      return { created: [], failed: failedAll }
    }
  }

  async function handleAdmin(req, res, path, user) {
    if (!user) {
      sendJson(res, 401, { ok: false, error: { code: 'auth/required', message: '请先登录' } })
      return
    }
    if (passwordWall(res, user)) return
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
          role: body?.role === undefined ? 'user' : body.role,
          quota: body?.quota === undefined ? defaultQuota(env) : body.quota,
        })
        if (created.error) {
          sendJson(res, 400, { ok: false, error: { message: created.error } })
          return
        }
        // 账号先落库。三个 bot 用新用户自己的命名空间认领，失败也不撤回账号。
        // 这里不建群、不设主 bot、不发消息，所以不扣配额。
        const team = await provisionTeam(created.user.id, readSessionToken(req))
        sendJson(res, 201, { ok: true, user: created.user, password: created.password, team })
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
        if (body?.resetPassword === true) {
          const reset = await store.resetPassword(id)
          if (reset.error) {
            sendJson(res, reset.status ?? 400, { ok: false, error: { message: reset.error } })
            return
          }
          sendJson(res, 200, { ok: true, user: reset.user, password: reset.password })
          return
        }
        const patch = {}
        if (Object.hasOwn(body ?? {}, 'quota')) patch.quota = body.quota
        if (Object.hasOwn(body ?? {}, 'used')) patch.used = body.used
        if (Object.hasOwn(body ?? {}, 'role')) patch.role = body.role
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

  async function replyCompanyState(res, user, access) {
    const view = viewerCompany(user)
    claimCompanyAccess(access, view.chatOwnerId, view.accounts)
    const built = buildCompanyState(view.chatOwnerId, user, view.accounts)
    const value = rewriteValue('state', built, user, access, {})
    // Employee ids are shared. The first login to claim co_chief must not hide
    // 主编 / 写稿 / 数据 from everyone else. Rooms stay the ones this viewer may see.
    if (value && typeof value === 'object' && !value.unchanged) {
      value.bots = built.bots
      value.rooms = built.rooms
      value.mainBotIds = ['co_chief']
      value.mainBotId = 'co_chief'
    }
    await store.commitAccess(user.id, access)
    sendJson(res, 200, { ok: true, value })
  }

  /** Kernel state with no usable roster after ownership filter → company-local employees. */
  function stateNeedsCompany(value, payload) {
    if (!value || typeof value !== 'object') return true
    if (value.companyMode) return false
    const empty = !Array.isArray(value.bots) || value.bots.length === 0
    if (value.unchanged) {
      // A first load has no roster yet. `unchanged` would leave it empty and the host retries.
      const since = payload?.since
      const fresh = since == null || since === '' || Number(since) < 0
      return fresh && empty
    }
    return empty
  }

  function stampWorkspaceSessions(result, user) {
    const view = viewerCompany(user)
    const sessionIds = companySessionIds(view.chatOwnerId, view.accounts)
    const lists = [result?.value?.items, result?.value?.workspaces]
    for (const list of lists) {
      if (!Array.isArray(list)) continue
      for (const item of list) {
        if (item && typeof item === 'object') item.sessionIds = sessionIds
      }
    }
    return result
  }

  async function handleBot(req, res, context, body) {
    const user = context.user
    if (passwordWall(res, user)) return
    const client = new AbortController()
    const onClose = () => { if (!res.writableEnded) client.abort() }
    res.on('close', onClose)
    let charged = false
    try {
      const endpoint = body.endpoint
      const payload = body.payload ?? null
      const access = createAccess(user.id, context.resources)
      const view = viewerCompany(user)
      const sessionHint = payload?.botId || payload?.sessionId

      // Company-local sessions never hit the kernel (roster / chat / send).
      if (
        (endpoint === 'chat' || endpoint === 'earlier' || endpoint === 'send')
        && isCompanySessionId(sessionHint)
      ) {
        claimCompanyAccess(access, view.chatOwnerId, view.accounts)
        await store.commitAccess(user.id, access)
        if (endpoint === 'send') {
          const result = companySend(view.chatOwnerId, payload, view.accounts)
          sendJson(res, result.ok ? 200 : 400, result)
          return
        }
        sendJson(res, 200, companyChatPage(view.chatOwnerId, payload, view.accounts))
        return
      }

      const decision = decide(endpoint, payload, access, { role: user.role, workspaceId: user.kernelKey })
      if (decision.action === 'refuse') {
        sendJson(res, 200, refused(decision.message ?? CROSS_MESSAGE))
        return
      }
      if (decision.action === 'workspace') {
        const listing = endpoint === 'workspace-list' || endpoint === 'workspaces'
        const root = listing
          ? await store.localWorkspace(user.id)
          : await store.ensureUserWorkspace(user.id)
        if (!root || !(await pathsStayInside(root, payload))) {
          sendJson(res, 200, refused(PATH_MESSAGE))
          return
        }
        const result = await store.exclusive(() => runWorkspace({ root, workspaceId: user.kernelKey, endpoint, payload }))
        if (listing) stampWorkspaceSessions(result, user)
        // The host retries "Retry listing workspace…" until this answer arrives.
        // Remote file sync must not hold that answer.
        if (listing) {
          sendJson(res, 200, result)
          void store.syncWorkspace(user.id).catch((error) => {
            console.error('[botcamp]', error instanceof Error ? error.message : 'syncWorkspace failed')
          })
          return
        }
        try {
          await store.syncWorkspace(user.id)
        } catch (error) {
          console.error('[botcamp]', error instanceof Error ? error.message : 'syncWorkspace failed')
        }
        sendJson(res, 200, result)
        return
      }
      if (typeof payload?.folder === 'string' && payload.folder) {
        const root = await store.ensureUserWorkspace(user.id)
        if (root) {
          if (!(await pathsStayInside(root, { folder: payload.folder })) || !(await materializeFolder(root, payload.folder))) {
            sendJson(res, 200, refused(PATH_MESSAGE))
            return
          }
          await store.syncWorkspace(user.id)
        }
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
      if (endpoint === 'state') outboundPayload = stateRequestPayload(payload, user)
      else if (endpoint === 'usage') outboundPayload = usageRequestPayload(payload)
      outboundPayload = stripPathFields(outboundPayload)
      let upstream
      const kernelAbort = new AbortController()
      const stopKernel = () => kernelAbort.abort()
      // A hung kernel used to leave the roster empty, so the host kept listing workspaces.
      const kernelTimer = endpoint === 'state' ? setTimeout(stopKernel, 1200) : null
      if (client.signal.aborted) stopKernel()
      else client.signal.addEventListener('abort', stopKernel, { once: true })
      try {
        upstream = await callKernel('/api/bot', {
          method: 'POST',
          body: JSON.stringify({ endpoint, payload: outboundPayload }),
          signal: kernelAbort.signal,
          namespace: user.kernelKey,
          sessionToken: readSessionToken(req),
        })
      } catch (error) {
        if (endpoint === 'state' && !client.signal.aborted) {
          if (charged) await store.refund(user.id).catch(() => {})
          await replyCompanyState(res, user, createAccess(user.id, context.resources))
          return
        }
        throw error
      } finally {
        if (kernelTimer) clearTimeout(kernelTimer)
        client.signal.removeEventListener('abort', stopKernel)
      }
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
      // Empty / failed kernel state → company roster so login always shows employees.
      if (
        endpoint === 'state'
        && (
          !upstream.ok
          || parsed?.ok === false
          || !parsed
          || (parsed?.ok !== false && stateNeedsCompany(parsed.value, payload))
        )
      ) {
        await replyCompanyState(res, user, createAccess(user.id, context.resources))
        return
      }
      if (parsed && typeof parsed === 'object' && Object.hasOwn(parsed, 'value')) {
        const after = createAccess(user.id, context.resources)
        if (parsed.ok !== false) {
          claimCreated(endpoint, parsed.value, after)
          releaseDeleted(endpoint, payload, after)
          if ((endpoint === 'chat' || endpoint === 'earlier') && Array.isArray(parsed.value?.items)) {
            const sessionId = parsed.value.sessionId ?? payload?.sessionId ?? payload?.botId
            await store.rememberPage(user.id, sessionId, parsed.value.items)
          }
        }
        parsed.value = rewriteValue(endpoint, parsed.value, user, after, context.settings)
        if (endpoint === 'state' && parsed.ok !== false && parsed.value && !parsed.value.unchanged) {
          parsed.value = mergeProjectRooms(parsed.value, user, after)
        }
        // Foreign / unowned kernel bots are stripped by filterState — fall back after filter.
        if (endpoint === 'state' && parsed.ok !== false && stateNeedsCompany(parsed.value, payload)) {
          await replyCompanyState(res, user, createAccess(user.id, context.resources))
          return
        }
        if (endpoint === 'usage' && parsed.ok !== false) await store.writeUsage(user.id, parsed.value)
        await store.commitAccess(user.id, after)
        sendJson(res, upstream.status, parsed)
        return
      }
      if (endpoint === 'state') {
        await replyCompanyState(res, user, createAccess(user.id, context.resources))
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
      if (body?.endpoint === 'state') {
        try {
          await replyCompanyState(res, user, createAccess(user.id, context.resources))
          return
        } catch { /* fall through */ }
      }
      console.error('[botcamp]', error instanceof Error ? error.message : 'bot proxy failed')
      sendJson(res, 502, { ok: false, error: { code: 'bot/error', message: '暂时连不上内核。' } })
    } finally {
      res.off('close', onClose)
    }
  }

  async function handleFeed(req, res, context) {
    const user = context.user
    if (passwordWall(res, user)) return
    const access = createAccess(user.id, context.resources)
    const client = new AbortController()
    const onClose = () => { if (!res.writableEnded) client.abort() }
    res.on('close', onClose)
    try {
      const upstream = await callKernel('/api/bot/feed', {
        method: 'GET',
        signal: client.signal,
        namespace: user.kernelKey,
        sessionToken: readSessionToken(req),
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
        if (!feedBlockAllowed(block, access)) return
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
        if (access.pending().length > 0 || access.released().length > 0) await store.commitAccess(user.id, access)
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

  const MEDIA_CONTROL = new Set([
    'media/demo-users', 'media/login', 'media/logout', 'media/me',
    'media/workspace', 'media/manuscript',
    'media/accounts', 'media/focus', 'media/create-account', 'media/note',
    'media/update',
  ])
  const BOARD_CONTROL = new Set(WHITEBOARD_CONTROL)
  const DOCS_CONTROL = new Set(LIBRARY_CONTROL)
  const CONTROL = new Set([
    'auth/me', 'auth/login', 'auth/logout', 'auth/signup', 'auth/password',
    'admin/list', 'admin/create', 'admin/update', 'admin/delete',
    'media/grant',
    ...MEDIA_CONTROL,
    ...DOCS_CONTROL,
    ...BOARD_CONTROL,
  ])

  function jsonRequest(req, method, url, json) {
    const raw = Buffer.from(JSON.stringify(json ?? {}))
    return {
      method,
      url,
      headers: req.headers,
      socket: req.socket,
      async *[Symbol.asyncIterator]() { yield raw },
    }
  }

  function sendMediaResult(res, result) {
    const headers = {}
    if (result.setCookie) headers['set-cookie'] = result.setCookie
    sendJson(res, result.status, result.body, headers)
  }

  // Demox 已经建好的函数只能接到 /api/bot 和 /api/bot/feed。登录、管理、自媒体工作台
  // 走同一条 POST，在这里改写成原来的接口 / MediaAccount 读路径。
  async function handleControl(req, res, body) {
    const payload = body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload) ? body.payload : {}
    if (body.endpoint === 'auth/me') return handleAuth(jsonRequest(req, 'GET', '/api/auth/me'), res, '/api/auth/me')
    if (body.endpoint === 'auth/login') return handleAuth(jsonRequest(req, 'POST', '/api/auth/login', payload), res, '/api/auth/login')
    if (body.endpoint === 'auth/logout') return handleAuth(jsonRequest(req, 'POST', '/api/auth/logout', {}), res, '/api/auth/logout')
    if (body.endpoint === 'auth/signup') return handleAuth(jsonRequest(req, 'POST', '/api/auth/signup', payload), res, '/api/auth/signup')
    if (body.endpoint === 'auth/password') return handleAuth(jsonRequest(req, 'POST', '/api/auth/password', payload), res, '/api/auth/password')

    if (body.endpoint === 'media/grant') {
      const user = await currentUser(req)
      if (!user) {
        sendJson(res, 401, { ok: false, error: { code: 'auth/required', message: '请先登录' } })
        return
      }
      if (passwordWall(res, user)) return
      const granteeEmail = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : ''
      let granteeUserId = typeof payload.userId === 'string' ? payload.userId.trim() : ''
      if (!granteeUserId && granteeEmail) {
        const users = await store.listUsers()
        const found = users.find((entry) => entry.email === granteeEmail)
        if (found) granteeUserId = found.id
      }
      const granted = grantMediaView(user, {
        accountId: payload.accountId,
        granteeUserId,
        granteeEmail,
      })
      if (granted.error) {
        sendJson(res, granted.status ?? 403, { ok: false, error: { message: granted.error } })
        return
      }
      sendJson(res, 200, { ok: true, accountId: granted.accountId, grants: granted.grants })
      return
    }
    if (MEDIA_CONTROL.has(body.endpoint)) {
      // demo-users / login 公开；其余用 media session（Bearer/cookie）或 botcamp 会话。
      const user = await currentUser(req)
      if (user && passwordWall(res, user)) return
      sendMediaResult(res, handleMediaControl(req, body.endpoint, payload, user))
      return
    }
    if (DOCS_CONTROL.has(body.endpoint)) {
      const user = await currentUser(req)
      if (!user) {
        sendJson(res, 401, { ok: false, error: { code: 'auth/required', message: '请先登录' } })
        return
      }
      if (passwordWall(res, user)) return
      sendMediaResult(res, await handleLibraryControl(req, body.endpoint, payload, user))
      return
    }
    if (BOARD_CONTROL.has(body.endpoint)) {
      const user = await currentUser(req)
      if (!user) {
        sendJson(res, 401, { ok: false, error: { code: 'auth/required', message: '请先登录' } })
        return
      }
      if (passwordWall(res, user)) return
      sendMediaResult(res, handleWhiteboardControl(req, body.endpoint, payload, user))
      return
    }

    const user = await currentUser(req)
    if (!user) {
      sendJson(res, 401, { ok: false, error: { code: 'auth/required', message: '请先登录' } })
      return
    }
    if (passwordWall(res, user)) return
    if (body.endpoint === 'admin/list') return handleAdmin(jsonRequest(req, 'GET', '/api/admin/users'), res, '/api/admin/users', user)
    if (body.endpoint === 'admin/create') return handleAdmin(jsonRequest(req, 'POST', '/api/admin/users', payload), res, '/api/admin/users', user)
    if (body.endpoint === 'admin/update') {
      const id = encodeURIComponent(typeof payload.id === 'string' ? payload.id : '')
      const patch = { ...payload }
      delete patch.id
      return handleAdmin(jsonRequest(req, 'PATCH', `/api/admin/users/${id}`, patch), res, `/api/admin/users/${id}`, user)
    }
    const id = encodeURIComponent(typeof payload.id === 'string' ? payload.id : '')
    return handleAdmin(jsonRequest(req, 'DELETE', `/api/admin/users/${id}`), res, `/api/admin/users/${id}`, user)
  }

  async function handle(req, res, next) {
    const path = routePath(req.url)
    if (!path.startsWith('/api/')) {
      next()
      return
    }
    applyCors(res)
    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.end()
      return
    }
    if (path === '/api/library/asset' || path === '/api/library/assets' || path.startsWith('/api/library/asset/')) {
      serveLibraryAsset(req, res, path)
      return
    }
    if (path.startsWith('/api/auth')) {
      await handleAuth(req, res, path)
      return
    }
    if (path === '/api/bot' && req.method === 'POST') {
      let body
      try {
        const raw = await readBody(req, BOT_LIMIT)
        body = JSON.parse(raw.length ? raw.toString('utf8') : '{}')
      } catch (error) {
        if (error?.code === 'LIMIT') {
          sendJson(res, 413, { ok: false, error: { message: '请求太大。' } })
          return
        }
        sendJson(res, 400, { ok: false, error: { code: 'bot/invalid', message: '请求格式不正确。' } })
        return
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) body = {}
      if (CONTROL.has(body.endpoint)) {
        await handleControl(req, res, body)
        return
      }
      const context = await store.accountContext(readSessionToken(req))
      if (!context?.user) {
        sendJson(res, 401, { ok: false, error: { code: 'auth/required', message: '请先登录' } })
        return
      }
      await handleBot(req, res, context, body)
      return
    }
    if (path === '/api/bot/feed' && (req.method === 'GET' || req.method === 'HEAD')) {
      const context = await store.accountContext(readSessionToken(req))
      if (!context?.user) {
        sendJson(res, 401, { ok: false, error: { code: 'auth/required', message: '请先登录' } })
        return
      }
      await handleFeed(req, res, context)
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
    sendJson(res, 404, { ok: false, error: { message: '未知接口。' } })
  }

  function serveLibraryAsset(req, res, path) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('allow', 'GET, HEAD')
      sendJson(res, 405, { ok: false, error: { message: '找不到。' } })
      return
    }
    const matched = matchLibraryAssetPath(path)
    if (!matched?.id) {
      sendJson(res, 404, { ok: false, error: { message: '找不到。' } })
      return
    }
    const asset = readLibraryAsset(matched.id)
    if (!asset) {
      sendJson(res, 404, { ok: false, error: { message: '找不到。' } })
      return
    }
    const total = asset.bytes.length
    res.setHeader('content-type', asset.contentType)
    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('accept-ranges', 'bytes')
    res.setHeader('cache-control', 'public, max-age=31536000, immutable')
    const range = typeof req.headers.range === 'string' ? req.headers.range.trim() : ''
    let start = 0
    let end = total - 1
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range)
      const bad = !match || (match[1] === '' && match[2] === '')
      if (!bad && match[1] === '') {
        const suffix = Number(match[2])
        if (!Number.isFinite(suffix) || suffix <= 0) {
          res.statusCode = 416
          res.setHeader('content-range', `bytes */${total}`)
          res.end()
          return
        }
        start = Math.max(0, total - suffix)
      } else if (!bad) {
        start = Number(match[1])
        end = match[2] === '' ? total - 1 : Number(match[2])
        if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= total) {
          res.statusCode = 416
          res.setHeader('content-range', `bytes */${total}`)
          res.end()
          return
        }
        end = Math.min(end, total - 1)
      } else {
        res.statusCode = 416
        res.setHeader('content-range', `bytes */${total}`)
        res.end()
        return
      }
      res.statusCode = 206
      res.setHeader('content-range', `bytes ${start}-${end}/${total}`)
    } else {
      res.statusCode = 200
    }
    const chunk = asset.bytes.subarray(start, end + 1)
    res.setHeader('content-length', chunk.length)
    if (req.method === 'HEAD') res.end()
    else res.end(chunk)
  }

  return { store, handle, idle: () => store.idle() }
}
