/**
 * MediaAccount workbench behind POST /api/bot CONTROL endpoints.
 * Demox only routes /api/bot(+feed); workbench auth + reads go through here.
 *
 * Two caller shapes:
 * 1) Workbench SPA — media/login (phosa / other_creator) → Bearer / media cookie
 * 2) BotCamp shell — already logged in; owner mapped from botcamp user
 */
import path from 'node:path'
import {
  configureDataRoot,
  ensureStoreDirs,
  getDataRoot,
  kvGet,
  kvSet,
} from '../../server/kv.mjs'
import {
  getFocusedAccountId,
  getManuscriptBody,
  loadMediaAccountBundle,
} from '../../server/accountStore.mjs'
import {
  createSession,
  destroySession,
  findDemoUser,
  listDemoUsers,
  resolveSession,
  SESSION_COOKIE,
} from '../../server/auth.mjs'
import {
  PHOSA_MAC_ID,
  PHOSA_OWNER_ID,
  seed,
} from '../../scripts/seed.mjs'

const SCHEMA = '1.0.0'
/** Separate from botcamp_session so workbench login does not clobber DS Bot sessions. */
export const MEDIA_SESSION_COOKIE = 'botcamp_media_session'
let readyForRoot = ''

function nowIso() {
  return new Date().toISOString()
}

export function bindMediaDataDir(dataDir) {
  if (!dataDir) return
  const root = path.join(path.resolve(dataDir), 'media-store')
  if (getDataRoot() === root) return
  configureDataRoot(root)
  readyForRoot = ''
}

function ensureSeeded() {
  ensureStoreDirs()
  const root = getDataRoot()
  if (readyForRoot === root) return
  if (!kvGet(`media_account:${PHOSA_MAC_ID}`)) seed()
  readyForRoot = root
}

function readCookie(req, name) {
  const header = req.headers?.cookie
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
  const header = req.headers?.authorization
  if (typeof header !== 'string') return ''
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim())
  return match ? match[1] : ''
}

/** Prefer media cookie, then Bearer, then legacy botcamp_session (local Express). */
export function extractMediaToken(req) {
  return readCookie(req, MEDIA_SESSION_COOKIE)
    || readBearer(req)
    || readCookie(req, SESSION_COOKIE)
    || ''
}

function mediaCookieHeader(token, req, maxAge) {
  const secure = Boolean(req.socket?.encrypted)
    || (typeof req.headers?.['x-forwarded-proto'] === 'string'
      && req.headers['x-forwarded-proto'].split(',')[0].trim() === 'https')
  const parts = [
    `${MEDIA_SESSION_COOKIE}=${encodeURIComponent(token || '')}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${maxAge}`,
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

export function mediaOwnerIdFor(user) {
  const email = String(user?.email || '').toLowerCase()
  if (email === 'admin@localhost') return PHOSA_OWNER_ID
  return `usr_botcamp_${user.id}`
}

function ensureEmptyWorkspace(ownerId, label) {
  const existing = kvGet(`owner:${ownerId}:media_accounts`)
  if (Array.isArray(existing) && existing.length > 0) return

  const macId = `mac_botcamp_${ownerId.replace(/[^a-zA-Z0-9]/g, '').slice(-16) || 'new'}`
  const stamp = nowIso()
  const meta = {
    owner_user_id: ownerId,
    media_account_id: macId,
    schema_version: SCHEMA,
    version: 1,
    created_at: stamp,
    updated_at: stamp,
    deleted_at: null,
  }

  kvSet(`owner:${ownerId}:prefs`, {
    owner_user_id: ownerId,
    display_name: label || '创作者',
    preferred_timezone: 'Asia/Singapore',
    locale: 'zh-CN',
    schema_version: SCHEMA,
    version: 1,
    created_at: stamp,
    updated_at: stamp,
  })
  kvSet(`owner:${ownerId}:focus`, {
    id: ownerId,
    owner_user_id: ownerId,
    current_media_account_id: macId,
    last_session_id: null,
    schema_version: SCHEMA,
    version: 1,
    updated_at: stamp,
  })
  kvSet(`owner:${ownerId}:media_accounts`, [macId])
  kvSet(`media_account:${macId}`, {
    id: macId,
    ...meta,
    platform: 'other',
    display_name: label ? `${label}的号` : '新自媒体账号',
    handle: null,
    profile_url: null,
    avatar_ref: null,
    biz_line_tag: 'default',
    status: 'active',
    onboarding_path: 'new_account',
    stage: 'onboarding',
    content_timezone: 'Asia/Singapore',
    credential_ref: null,
  })
  kvSet(`media_account:${macId}:profile`, {
    ...meta,
    what_it_is: '尚未完成主编引导',
    goal: '打开对话，由主编一次一问完成起号',
    redlines_summary: '',
    tone_notes: null,
  })
  kvSet(`media_account:${macId}:rules`, {
    ...meta,
    enabled_rule_ids: [],
    publish_window_start: null,
    publish_window_end: null,
  })
  kvSet(`media_account:${macId}:posts`, [])
  kvSet(`media_account:${macId}:manuscripts`, [])
  kvSet(`media_account:${macId}:engagement_snapshots`, [])
  kvSet(`media_account:${macId}:follower_snapshots`, [])
  kvSet(`media_account:${macId}:revenue`, [])
  kvSet(`media_account:${macId}:platform_events`, [])
  kvSet(`media_account:${macId}:daily_trends`, [])
}

function workspaceForOwner(ownerId) {
  const macId = getFocusedAccountId(ownerId)
  if (!macId) {
    return { status: 404, body: { ok: false, error: { code: 'media/no_focus', message: '没有聚焦的自媒体账号。' } } }
  }
  const bundle = loadMediaAccountBundle(macId)
  if (!bundle) {
    return { status: 404, body: { ok: false, error: { code: 'media/not_found', message: '自媒体账号不存在。' } } }
  }
  if (bundle.account.owner_user_id !== ownerId) {
    return { status: 403, body: { ok: false, error: { code: 'media/forbidden', message: '无权查看该自媒体账号。' } } }
  }
  return { status: 200, body: { ok: true, owner_user_id: ownerId, workspace: bundle } }
}

function manuscriptForOwner(ownerId, payload) {
  const accountId = typeof payload?.accountId === 'string' ? payload.accountId : ''
  const manuscriptId = typeof payload?.manuscriptId === 'string' ? payload.manuscriptId : ''
  if (!accountId || !manuscriptId) {
    return { status: 400, body: { ok: false, error: { code: 'media/invalid', message: '缺少 accountId 或 manuscriptId。' } } }
  }
  const account = kvGet(`media_account:${accountId}`)
  if (!account || account.deleted_at) {
    return { status: 404, body: { ok: false, error: { code: 'media/not_found', message: '自媒体账号不存在。' } } }
  }
  if (account.owner_user_id !== ownerId) {
    return { status: 403, body: { ok: false, error: { code: 'media/forbidden', message: '无权查看该稿件。' } } }
  }
  const data = getManuscriptBody(accountId, manuscriptId)
  if (!data) {
    return { status: 404, body: { ok: false, error: { code: 'media/manuscript_missing', message: '稿件不存在。' } } }
  }
  return { status: 200, body: { ok: true, ...data } }
}

function resolveMediaOwner(req, botcampUser) {
  ensureSeeded()
  const token = extractMediaToken(req)
  const session = resolveSession(token)
  if (session?.owner_user_id) return { ownerId: session.owner_user_id, via: 'media' }
  if (botcampUser?.id) {
    const ownerId = mediaOwnerIdFor(botcampUser)
    if (ownerId !== PHOSA_OWNER_ID) {
      ensureEmptyWorkspace(ownerId, botcampUser.email?.split('@')[0] || botcampUser.email)
    }
    return { ownerId, via: 'botcamp' }
  }
  return null
}

export function handleMediaControl(req, endpoint, payload, botcampUser) {
  ensureSeeded()

  if (endpoint === 'media/demo-users') {
    return {
      status: 200,
      body: {
        ok: true,
        users: listDemoUsers().map(u => ({
          username: u.username,
          display_name: u.display_name,
        })),
      },
    }
  }

  if (endpoint === 'media/login') {
    const user = findDemoUser(payload?.username)
    if (!user) {
      return { status: 401, body: { ok: false, error: { code: 'media/invalid', message: '无效的演示用户' } } }
    }
    const session = createSession(user.owner_user_id)
    return {
      status: 200,
      body: {
        ok: true,
        owner_user_id: user.owner_user_id,
        username: user.username,
        display_name: user.display_name,
        token: session.token,
      },
      setCookie: mediaCookieHeader(session.token, req, 7 * 24 * 60 * 60),
    }
  }

  if (endpoint === 'media/logout') {
    destroySession(extractMediaToken(req))
    return {
      status: 200,
      body: { ok: true },
      setCookie: mediaCookieHeader('', req, 0),
    }
  }

  if (endpoint === 'media/me') {
    const token = extractMediaToken(req)
    const session = resolveSession(token)
    if (!session) {
      return { status: 401, body: { ok: false, error: { code: 'media/unauthorized', message: '需要登录' } } }
    }
    const prefs = kvGet(`owner:${session.owner_user_id}:prefs`)
    const demo = listDemoUsers().find(u => u.owner_user_id === session.owner_user_id)
    return {
      status: 200,
      body: {
        ok: true,
        owner_user_id: session.owner_user_id,
        display_name: prefs?.display_name || demo?.display_name || null,
        username: demo?.username || null,
      },
    }
  }

  const resolved = resolveMediaOwner(req, botcampUser)
  if (!resolved) {
    return { status: 401, body: { ok: false, error: { code: 'auth/required', message: '请先登录' } } }
  }

  if (endpoint === 'media/workspace') return workspaceForOwner(resolved.ownerId)
  if (endpoint === 'media/manuscript') return manuscriptForOwner(resolved.ownerId, payload)

  return { status: 404, body: { ok: false, error: { message: '未知的自媒体接口。' } } }
}

/** @deprecated use handleMediaControl */
export function resolveMediaWorkspace(user) {
  return handleMediaControl({ headers: {} }, 'media/workspace', null, user)
}

/** @deprecated use handleMediaControl */
export function resolveMediaManuscript(user, payload) {
  return handleMediaControl({ headers: {} }, 'media/manuscript', payload, user)
}
