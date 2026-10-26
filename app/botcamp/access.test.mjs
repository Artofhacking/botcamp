import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { kvGet } from '../../server/kv.mjs'
import { PHOSA_MAC_ID, PHOSA_OWNER_ID } from '../../scripts/seed-ids.mjs'
import { createBotcamp } from './http.mjs'
import {
  bindLoginOwner,
  mediaGrantKey,
  mediaOwnerIdFor,
} from './mediaControl.mjs'

const ADMIN_EMAIL = 'admin@example.com'
const ADMIN_PASSWORD = 'admin-password-1'
const OWNER_EMAIL = 'owner@example.com'
const STRANGER_EMAIL = 'stranger@example.com'
const ROOM_ID = `co_room_${PHOSA_MAC_ID}`
const ACCOUNT_NAME = '小稿的AI日记'

function seesXiaogao(payload) {
  return JSON.stringify(payload ?? {}).includes(ACCOUNT_NAME) || JSON.stringify(payload ?? {}).includes(ROOM_ID)
}

test('admin role and the admin aliases are not the owner of 小稿', () => {
  for (const email of ['admin@localhost', 'admin@example.com', 'admin@botcamp.demox.site']) {
    const id = mediaOwnerIdFor({ id: 'admin-1', role: 'admin', email })
    assert.equal(id, 'usr_botcamp_admin-1')
    assert.notEqual(id, PHOSA_OWNER_ID)
    assert.equal(bindLoginOwner(email, PHOSA_OWNER_ID).ok, undefined)
  }
  assert.equal(mediaOwnerIdFor({ id: 'member-1', role: 'user', email: OWNER_EMAIL }), 'usr_botcamp_member-1')
})

async function boot() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'botcamp-access-'))
  const fetchImpl = async (url, init = {}) => {
    const href = String(url)
    if (!href.includes('/api/bot')) return new Response('ok', { status: 200 })
    const body = JSON.parse(init.body ?? '{}')
    if (body.endpoint === 'create-bot') {
      return Response.json({ ok: true, value: { id: `bot-${body.payload?.name}`, name: body.payload?.name, sessionId: `sess-${body.payload?.name}` } })
    }
    if (body.endpoint === 'state') return Response.json({ ok: true, value: { revision: 1, bots: [], rooms: [] } })
    return Response.json({ ok: true, value: null })
  }
  const camp = await createBotcamp({
    dataDir,
    kernelOrigin: 'http://kernel.test',
    fetchImpl,
    env: {
      NODE_ENV: 'production',
      BOTCAMP_PRODUCTION: '1',
      BOTCAMP_ADMIN_EMAIL: ADMIN_EMAIL,
      BOTCAMP_ADMIN_PASSWORD: ADMIN_PASSWORD,
    },
  })
  const server = createServer((req, res) => {
    camp.handle(req, res, () => { res.statusCode = 404; res.end() }).catch(() => {
      if (!res.writableEnded) { res.statusCode = 500; res.end() }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      await new Promise((resolve) => server.close(resolve))
      await rm(dataDir, { recursive: true, force: true })
    },
  }
}

async function api(base, pathname, { method = 'POST', body, cookie } = {}) {
  const headers = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (cookie) headers.cookie = cookie
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { json = null }
  const setCookie = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
  return { status: response.status, json, text, cookie: setCookie[0]?.split(';', 1)[0] ?? '' }
}

async function settle(base, email, created, next) {
  const first = await api(base, '/api/auth/login', { body: { email, password: created.json.password } })
  assert.equal(first.status, 200, email)
  const changed = await api(base, '/api/bot', {
    cookie: first.cookie,
    body: { endpoint: 'auth/password', payload: { current: created.json.password, next } },
  })
  assert.equal(changed.status, 200, email)
  const login = await api(base, '/api/auth/login', { body: { email, password: next } })
  assert.equal(login.status, 200, email)
  return login
}

async function bot(base, cookie, endpoint, payload) {
  return api(base, '/api/bot', { cookie, body: { endpoint, payload: payload ?? {} } })
}

test('owner sees 小稿, a stranger and an ungranted admin do not, and a grant is not ownership', async () => {
  const ctx = await boot()
  try {
    assert.equal(bindLoginOwner(OWNER_EMAIL, PHOSA_OWNER_ID).ok, true)
    const adminLogin = await api(ctx.base, '/api/auth/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
    assert.equal(adminLogin.status, 200)
    const adminCookie = adminLogin.cookie
    const adminId = adminLogin.json.user.id

    const createdOwner = await api(ctx.base, '/api/admin/users', {
      cookie: adminCookie,
      body: { email: OWNER_EMAIL, password: 'password-owner-1', quota: 5 },
    })
    const createdStranger = await api(ctx.base, '/api/admin/users', {
      cookie: adminCookie,
      body: { email: STRANGER_EMAIL, password: 'password-stranger', quota: 5 },
    })
    assert.equal(createdOwner.status, 201)
    assert.equal(createdStranger.status, 201)
    const owner = await settle(ctx.base, OWNER_EMAIL, createdOwner, 'password-owner-1')
    const stranger = await settle(ctx.base, STRANGER_EMAIL, createdStranger, 'password-stranger')

    const ownerState = await bot(ctx.base, owner.cookie, 'state', { since: -1, models: '' })
    assert.equal(ownerState.status, 200)
    assert.equal(ownerState.json.value.bots.find((bot) => bot.name === '主编')?.id, 'co_chief')
    assert.equal(ownerState.json.value.rooms.some((room) => room.name === ACCOUNT_NAME), true)
    const ownerChat = await bot(ctx.base, owner.cookie, 'chat', { botId: 'co_chief' })
    assert.match(ownerChat.json.value.items[0].text, /目前在管：小稿的AI日记/)
    const ownerLibrary = await bot(ctx.base, owner.cookie, 'library/list', {})
    assert.equal(ownerLibrary.json.nodes.some((node) => node.name === '小稿'), true)

    assert.equal(kvGet(mediaGrantKey(PHOSA_MAC_ID)) ?? null, null)
    for (const session of [stranger, adminLogin]) {
      const state = await bot(ctx.base, session.cookie, 'state', { since: -1, models: '' })
      assert.equal(state.json.value.bots.some((bot) => bot.id === 'co_chief'), true)
      assert.equal(state.json.value.rooms.some((room) => room.id === ROOM_ID || room.name === ACCOUNT_NAME), false)
      assert.equal(seesXiaogao(state.json), false)
      const chat = await bot(ctx.base, session.cookie, 'chat', { botId: 'co_chief' })
      assert.equal(seesXiaogao(chat.json), false)
      const library = await bot(ctx.base, session.cookie, 'library/list', {})
      assert.equal(seesXiaogao(library.json), false)
      assert.equal(library.json.nodes.some((node) => node.name === '小稿'), false)
      const room = await bot(ctx.base, session.cookie, 'chat', { botId: ROOM_ID })
      assert.equal(room.json.ok, false)
      assert.equal(seesXiaogao(room.json), false)
    }

    const granted = await bot(ctx.base, owner.cookie, 'media/grant', { accountId: PHOSA_MAC_ID, userId: adminId })
    assert.equal(granted.status, 200)
    assert.equal(granted.json.ok, true)
    assert.deepEqual(granted.json.grants.userIds, [adminId])
    assert.equal(kvGet(`media_account:${PHOSA_MAC_ID}`).owner_user_id, PHOSA_OWNER_ID)

    const adminState = await bot(ctx.base, adminCookie, 'state', { since: -1, models: '' })
    assert.equal(adminState.json.value.rooms.some((room) => room.name === ACCOUNT_NAME), true)
    const adminChat = await bot(ctx.base, adminCookie, 'chat', { botId: 'co_chief' })
    assert.match(adminChat.json.value.items[0].text, /目前在管：小稿的AI日记/)
    const adminLibrary = await bot(ctx.base, adminCookie, 'library/list', {})
    assert.equal(adminLibrary.json.nodes.some((node) => node.name === '小稿'), true)

    const denied = await bot(ctx.base, adminCookie, 'media/grant', {
      accountId: PHOSA_MAC_ID,
      userId: createdStranger.json.user.id,
    })
    assert.equal(denied.json.ok, false)
    const strangerAfter = await bot(ctx.base, stranger.cookie, 'state', { since: -1, models: '' })
    assert.equal(seesXiaogao(strangerAfter.json), false)
    const strangerLibrary = await bot(ctx.base, stranger.cookie, 'library/list', {})
    assert.equal(strangerLibrary.json.nodes.some((node) => node.name === '小稿'), false)
  } finally {
    await ctx.close()
  }
})
