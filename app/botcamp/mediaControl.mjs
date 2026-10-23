/**
 * MediaAccount workbench behind POST /api/bot CONTROL endpoints.
 * Demox only routes /api/bot(+feed); workbench auth + reads go through here.
 *
 * Two caller shapes:
 * 1) Workbench SPA — media/login (phosa / other_creator) → Bearer / media cookie
 * 2) BotCamp shell — already logged in; owner mapped from botcamp user
 */
import crypto from 'node:crypto'
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
  findDemoUser,
  listDemoUsers,
  SESSION_COOKIE,
} from '../../server/auth.mjs'
import {
  PHOSA_MAC_ID,
  PHOSA_OWNER_ID,
  seed,
} from '../../scripts/seed.mjs'
import packedFixture from '../../fixtures/xiaogao/fixture.generated.mjs'

const FIXTURE_META = packedFixture?.meta || null

const SCHEMA = '1.0.0'
/** Separate from botcamp_session so workbench login does not clobber DS Bot sessions. */
export const MEDIA_SESSION_COOKIE = 'botcamp_media_session'
const MEDIA_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000
let readyForRoot = ''

/**
 * Stateless signed tokens — Demox cold starts / multi-instance cannot share file KV sessions.
 * Secret prefers BOTCAMP_MEDIA_TOKEN_SECRET, then store token, else a fixed local-dev fallback.
 */
function mediaTokenSecret() {
  return process.env.BOTCAMP_MEDIA_TOKEN_SECRET
    || process.env.BOTCAMP_STORE_TOKEN
    || 'botcamp-media-local-dev'
}

function issueMediaToken(ownerUserId) {
  const body = Buffer.from(JSON.stringify({
    o: ownerUserId,
    e: Date.now() + MEDIA_TOKEN_TTL_MS,
    v: 1,
  })).toString('base64url')
  const sig = crypto.createHmac('sha256', mediaTokenSecret()).update(body).digest('base64url')
  return `${body}.${sig}`
}

function verifyMediaToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null
  const [body, sig] = token.split('.')
  if (!body || !sig) return null
  const expect = crypto.createHmac('sha256', mediaTokenSecret()).update(body).digest('base64url')
  const a = Buffer.from(sig)
  const b = Buffer.from(expect)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (!data?.o || typeof data.e !== 'number' || data.e < Date.now()) return null
    return { owner_user_id: String(data.o) }
  } catch {
    return null
  }
}

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
  const fixtureTs = FIXTURE_META?.import_timestamp || null
  const applied = kvGet(`media_account:${PHOSA_MAC_ID}:import_meta`)
  const needsImport =
    !kvGet(`media_account:${PHOSA_MAC_ID}`) ||
    (fixtureTs && applied?.import_timestamp !== fixtureTs) ||
    !applied?.counts?.posts
  if (readyForRoot === root && !needsImport) return
  if (needsImport) seed()
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
  // Local + production admins see the seeded 小稿账号 after email/password login.
  const email = String(user?.email || '').toLowerCase()
  if (email === 'admin@localhost' || user?.role === 'admin') return PHOSA_OWNER_ID
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

function listAccounts(ownerId) {
  const ids = kvGet(`owner:${ownerId}:media_accounts`) || []
  const focus = getFocusedAccountId(ownerId)
  const accounts = ids
    .map((id) => kvGet(`media_account:${id}`))
    .filter((a) => a && !a.deleted_at && a.owner_user_id === ownerId)
  return {
    status: 200,
    body: {
      ok: true,
      owner_user_id: ownerId,
      current_media_account_id: focus,
      accounts: accounts.map((a) => ({
        id: a.id,
        display_name: a.display_name,
        platform: a.platform,
        status: a.status,
        stage: a.stage,
        biz_line_tag: a.biz_line_tag,
      })),
    },
  }
}

function focusAccount(ownerId, payload) {
  const accountId = typeof payload?.accountId === 'string' ? payload.accountId : ''
  const account = kvGet(`media_account:${accountId}`)
  if (!account || account.deleted_at || account.owner_user_id !== ownerId) {
    return { status: 403, body: { ok: false, error: { code: 'media/forbidden', message: '无权切换到该自媒体账号。' } } }
  }
  const stamp = nowIso()
  const prev = kvGet(`owner:${ownerId}:focus`) || { id: ownerId, owner_user_id: ownerId, schema_version: SCHEMA, version: 0 }
  kvSet(`owner:${ownerId}:focus`, {
    ...prev,
    current_media_account_id: accountId,
    version: (prev.version || 0) + 1,
    updated_at: stamp,
  })
  return workspaceForOwner(ownerId)
}

function createAccount(ownerId, payload) {
  const label = typeof payload?.display_name === 'string' && payload.display_name.trim()
    ? payload.display_name.trim()
    : '新自媒体账号'
  const stamp = nowIso()
  const macId = `mac_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  const meta = {
    owner_user_id: ownerId,
    media_account_id: macId,
    schema_version: SCHEMA,
    version: 1,
    created_at: stamp,
    updated_at: stamp,
    deleted_at: null,
  }
  const ids = kvGet(`owner:${ownerId}:media_accounts`) || []
  kvSet(`owner:${ownerId}:media_accounts`, [...ids, macId])
  kvSet(`media_account:${macId}`, {
    id: macId,
    ...meta,
    platform: typeof payload?.platform === 'string' ? payload.platform : 'other',
    display_name: label,
    handle: null,
    profile_url: null,
    avatar_ref: null,
    biz_line_tag: 'default',
    status: 'onboarding',
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
  for (const key of ['posts', 'manuscripts', 'engagement_snapshots', 'follower_snapshots', 'revenue', 'platform_events', 'daily_trends']) {
    kvSet(`media_account:${macId}:${key}`, [])
  }
  const prev = kvGet(`owner:${ownerId}:focus`) || { id: ownerId, owner_user_id: ownerId, schema_version: SCHEMA, version: 0 }
  kvSet(`owner:${ownerId}:focus`, {
    ...prev,
    current_media_account_id: macId,
    version: (prev.version || 0) + 1,
    updated_at: stamp,
  })
  return workspaceForOwner(ownerId)
}

const POST_STATUSES = new Set(['选题', '写稿中', '待确认', '已发布', '被隐藏', '搁置'])

function reindexPostStatus(accountId, postId, prevStatus, nextStatus) {
  if (prevStatus === nextStatus) return
  if (prevStatus) {
    const prev = (kvGet(`media_account:${accountId}:posts_by_status:${prevStatus}`) || []).filter((id) => id !== postId)
    kvSet(`media_account:${accountId}:posts_by_status:${prevStatus}`, prev)
  }
  if (nextStatus) {
    const next = kvGet(`media_account:${accountId}:posts_by_status:${nextStatus}`) || []
    if (!next.includes(postId)) kvSet(`media_account:${accountId}:posts_by_status:${nextStatus}`, [...next, postId])
  }
}

/** Real status / gate mutations — Confirm / Review / hold / set_status. */
function updateEntity(ownerId, payload) {
  const accountId = typeof payload?.accountId === 'string' ? payload.accountId : getFocusedAccountId(ownerId)
  const account = kvGet(`media_account:${accountId}`)
  if (!account || account.deleted_at || account.owner_user_id !== ownerId) {
    return { status: 403, body: { ok: false, error: { code: 'media/forbidden', message: '无权写入该自媒体账号。' } } }
  }
  const kind = payload?.kind === 'manuscript' ? 'manuscript' : 'post'
  const entityId = typeof payload?.entityId === 'string' ? payload.entityId : ''
  const action = typeof payload?.action === 'string' ? payload.action : ''
  const stamp = nowIso()
  if (!entityId || !action) {
    return { status: 400, body: { ok: false, error: { code: 'media/invalid', message: '缺少 entityId 或 action。' } } }
  }

  if (kind === 'post') {
    const post = kvGet(`media_account:${accountId}:post:${entityId}`)
    if (!post || post.owner_user_id !== ownerId) {
      return { status: 404, body: { ok: false, error: { code: 'media/not_found', message: '帖子不存在。' } } }
    }
    const prev = post.status
    let next = prev
    let noteLine = ''

    if (action === 'confirm_topic') {
      if (prev !== '选题' && prev !== '待确认') {
        return { status: 400, body: { ok: false, error: { code: 'media/invalid', message: `当前状态「${prev}」不能确认选题。` } } }
      }
      next = prev === '选题' ? '写稿中' : '写稿中'
      noteLine = '闸门 Confirm：选题确认 → 写稿中'
    } else if (action === 'pass_review') {
      if (post.manuscript_id) {
        const m = kvGet(`media_account:${accountId}:manuscript:${post.manuscript_id}`)
        if (m && m.owner_user_id === ownerId) {
          kvSet(`media_account:${accountId}:manuscript:${post.manuscript_id}`, {
            ...m,
            final_review_passed: true,
            final_reviewed_at: stamp,
            status: m.status === '写稿中' ? '待确认' : m.status,
            version: (m.version || 1) + 1,
            updated_at: stamp,
          })
        }
      }
      if (prev === '写稿中') next = '待确认'
      noteLine = '闸门 Review：终审通过'
    } else if (action === 'confirm_publish') {
      if (prev !== '待确认' && prev !== '写稿中') {
        return { status: 400, body: { ok: false, error: { code: 'media/invalid', message: `当前状态「${prev}」不能确认发布。` } } }
      }
      if (post.manuscript_id) {
        const m = kvGet(`media_account:${accountId}:manuscript:${post.manuscript_id}`)
        if (m && !m.final_review_passed) {
          return { status: 400, body: { ok: false, error: { code: 'media/review_required', message: '关联稿件终审未过，不能确认发布。' } } }
        }
      }
      next = '已发布'
      noteLine = '闸门 Confirm：确认发布 → 已发布'
    } else if (action === 'hold') {
      next = '搁置'
      noteLine = '闸门：搁置'
    } else if (action === 'set_status') {
      if (!POST_STATUSES.has(payload?.status)) {
        return { status: 400, body: { ok: false, error: { code: 'media/invalid', message: '非法状态。' } } }
      }
      next = payload.status
      noteLine = `状态设为 ${next}`
    } else {
      return { status: 400, body: { ok: false, error: { code: 'media/invalid', message: `未知 action：${action}` } } }
    }

    const remarkExtra = typeof payload?.note === 'string' && payload.note.trim()
      ? payload.note.trim()
      : noteLine
    const line = `[主编 ${stamp}] ${remarkExtra}`
    kvSet(`media_account:${accountId}:post:${entityId}`, {
      ...post,
      status: next,
      published_at: next === '已发布' && !post.published_at ? stamp.slice(0, 10) : post.published_at,
      remark: post.remark ? `${post.remark}\n${line}` : line,
      version: (post.version || 1) + 1,
      updated_at: stamp,
    })
    reindexPostStatus(accountId, entityId, prev, next)
    return workspaceForOwner(ownerId)
  }

  // manuscript
  const m = kvGet(`media_account:${accountId}:manuscript:${entityId}`)
  if (!m || m.owner_user_id !== ownerId) {
    return { status: 404, body: { ok: false, error: { code: 'media/not_found', message: '稿件不存在。' } } }
  }
  if (action === 'pass_review') {
    kvSet(`media_account:${accountId}:manuscript:${entityId}`, {
      ...m,
      final_review_passed: true,
      final_reviewed_at: stamp,
      status: m.status === '写稿中' ? '待确认' : m.status,
      version: (m.version || 1) + 1,
      updated_at: stamp,
    })
    if (m.post_id) {
      const post = kvGet(`media_account:${accountId}:post:${m.post_id}`)
      if (post && post.status === '写稿中') {
        kvSet(`media_account:${accountId}:post:${m.post_id}`, {
          ...post,
          status: '待确认',
          remark: post.remark
            ? `${post.remark}\n[主编 ${stamp}] 关联稿终审通过 → 待确认`
            : `[主编 ${stamp}] 关联稿终审通过 → 待确认`,
          version: (post.version || 1) + 1,
          updated_at: stamp,
        })
        reindexPostStatus(accountId, m.post_id, '写稿中', '待确认')
      }
    }
    return workspaceForOwner(ownerId)
  }
  if (action === 'hold') {
    kvSet(`media_account:${accountId}:manuscript:${entityId}`, {
      ...m,
      status: '搁置',
      version: (m.version || 1) + 1,
      updated_at: stamp,
    })
    return workspaceForOwner(ownerId)
  }
  return { status: 400, body: { ok: false, error: { code: 'media/invalid', message: `稿件不支持 action：${action}` } } }
}

/** Persist a chat write-back onto a post remark and/or a platform event, then return workspace. */
function noteOnEntity(ownerId, payload) {
  const accountId = typeof payload?.accountId === 'string' ? payload.accountId : getFocusedAccountId(ownerId)
  const account = kvGet(`media_account:${accountId}`)
  if (!account || account.deleted_at || account.owner_user_id !== ownerId) {
    return { status: 403, body: { ok: false, error: { code: 'media/forbidden', message: '无权写入该自媒体账号。' } } }
  }
  const text = typeof payload?.text === 'string' ? payload.text.trim() : ''
  if (!text) {
    return { status: 400, body: { ok: false, error: { code: 'media/invalid', message: '缺少写入内容。' } } }
  }
  const stamp = nowIso()
  const kind = payload?.kind === 'post' ? 'post' : 'event'
  const entityId = typeof payload?.entityId === 'string' ? payload.entityId : ''

  if (kind === 'post' && entityId) {
    const post = kvGet(`media_account:${accountId}:post:${entityId}`)
    if (!post || post.owner_user_id !== ownerId) {
      return { status: 404, body: { ok: false, error: { code: 'media/not_found', message: '帖子不存在。' } } }
    }
    const line = `[主编对话 ${stamp}] ${text}`
    kvSet(`media_account:${accountId}:post:${entityId}`, {
      ...post,
      remark: post.remark ? `${post.remark}\n${line}` : line,
      version: (post.version || 1) + 1,
      updated_at: stamp,
    })
  }

  const evtId = `evt_chat_${Date.now().toString(36)}`
  const evtIds = kvGet(`media_account:${accountId}:platform_events`) || []
  kvSet(`media_account:${accountId}:platform_events`, [evtId, ...evtIds])
  kvSet(`media_account:${accountId}:platform_event:${evtId}`, {
    id: evtId,
    owner_user_id: ownerId,
    media_account_id: accountId,
    schema_version: SCHEMA,
    version: 1,
    created_at: stamp,
    updated_at: stamp,
    deleted_at: null,
    name: entityId ? `对话锚定 · ${payload?.title || entityId}` : '对话写入工作台',
    event_type: 'chat_writeback',
    occurred_at: stamp,
    registered_on: stamp.slice(0, 10),
    related_title: payload?.title || null,
    remark: text.slice(0, 2000),
  })

  return workspaceForOwner(ownerId)
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
  const session = verifyMediaToken(token)
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
    const token = issueMediaToken(user.owner_user_id)
    return {
      status: 200,
      body: {
        ok: true,
        owner_user_id: user.owner_user_id,
        username: user.username,
        display_name: user.display_name,
        token,
      },
      setCookie: mediaCookieHeader(token, req, Math.floor(MEDIA_TOKEN_TTL_MS / 1000)),
    }
  }

  if (endpoint === 'media/logout') {
    return {
      status: 200,
      body: { ok: true },
      setCookie: mediaCookieHeader('', req, 0),
    }
  }

  if (endpoint === 'media/me') {
    const session = verifyMediaToken(extractMediaToken(req))
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
  if (endpoint === 'media/accounts') return listAccounts(resolved.ownerId)
  if (endpoint === 'media/focus') return focusAccount(resolved.ownerId, payload)
  if (endpoint === 'media/create-account') return createAccount(resolved.ownerId, payload)
  if (endpoint === 'media/note') return noteOnEntity(resolved.ownerId, payload)
  if (endpoint === 'media/update') return updateEntity(resolved.ownerId, payload)

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
