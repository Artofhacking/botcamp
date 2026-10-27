import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createBotcamp } from './http.mjs'
import { createMemoryLedger } from './projectLedger.mjs'
import { DEFAULT_TEAM } from './team.mjs'
import { configureDataRoot, getDataRoot } from '../../server/kv.mjs'

const ADMIN_EMAIL = 'admin@example.com'
const ADMIN_PASSWORD = 'admin-password-1'

function kernelFactory() {
  const bots = []
  let teamSlot = 0
  return async function kernel(href, init = {}) {
    if (href === 'http://kernel.test/' || href === 'http://kernel.test') return new Response('ok', { status: 200 })
    if (href.endsWith('/api/bot/feed')) {
      const events = [
        'event: hello\ndata: {}\n\n',
        `event: message\ndata: ${JSON.stringify({ botId: 'bot-a', sessionId: 'sess-a', item: { kind: 'user', text: 'only-a', time: 1 } })}\n\n`,
        `event: message\ndata: ${JSON.stringify({ botId: 'bot-b', sessionId: 'sess-b', item: { kind: 'user', text: 'only-b', time: 2 } })}\n\n`,
      ]
      return new Response(events.join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    const body = JSON.parse(init.body ?? '{}')
    if (body.endpoint === 'create-bot') {
      const name = body.payload?.name ?? ''
      const named = name === '甲' ? 'a' : name === '乙' ? 'b' : `t${teamSlot++}`
      const bot = { id: `bot-${named}`, name: name || named, sessionId: `sess-${named}`, parts: [] }
      bots.push(bot)
      return Response.json({ ok: true, value: bot })
    }
    if (body.endpoint === 'state') {
      return Response.json({
        ok: true,
        value: {
          revision: 3,
          modelsKey: 'm',
          bots,
          rooms: [{ id: 'room-b', name: '乙的群' }],
          prefs: { theme: 'shared' },
          secrets: [{ name: 'kernel-secret', value: 'foreign-secret-value' }],
          connectors: [{ id: 'github', name: 'GitHub', state: 'ready', account: 'foreign-account', token: 'ghp-foreign-token' }],
          questions: { 'sess-b': { q: 'hidden-question' } },
          work: { bots: { 'bot-b': { tool: 'foreign' } }, approvals: [] },
          usage: { rows: [['2026-10-21 11', 1, 0, 0, 999, 0, 0, 888, 7]], totalTokens: 1902 },
          models: [{ key: 'deepseek', name: 'DeepSeek', tokens: 1902, apiKey: 'sk-hidden' }],
        },
      })
    }
    if (body.endpoint === 'usage') {
      return Response.json({
        ok: true,
        value: {
          now: '2026-10-21 12',
          scanning: false,
          totalTokens: 1902,
          owners: [
            { key: 'bot-a', id: 'bot-a', kind: 'bot', name: '甲', tokens: 18 },
            { key: 'bot-b', id: 'bot-b', kind: 'bot', name: '乙', tokens: 1887 },
          ],
          models: [{ key: 'deepseek', name: 'DeepSeek', provider: 'deepseek', tokens: 1902 }],
          rows: [
            ['2026-10-21 10', 0, 0, 0, 10, 1, 2, 5, 1],
            ['2026-10-21 11', 1, 0, 0, 999, 3, 4, 888, 7],
          ],
        },
      })
    }
    if (body.endpoint === 'chat') {
      const bot = bots.find(item => item.id === body.payload?.botId)
      return Response.json({
        ok: true,
        value: { sessionId: bot?.sessionId ?? null, items: [{ kind: 'user', text: `secret-${bot?.id}`, time: 1 }], cursor: null },
      })
    }
    if (body.endpoint === 'send') return Response.json({ ok: true, value: { sent: true } })
    if (body.endpoint === 'set-prefs') return Response.json({ ok: true, value: body.payload })
    return Response.json({ ok: true, value: null })
  }
}

async function start(env = {}, extras = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'botcamp-'))
  const calls = []
  const kernel = kernelFactory()
  const fetchImpl = extras.fetchImpl ?? (async (url, init = {}) => {
    calls.push({ href: String(url), method: init.method ?? 'GET', headers: { ...(init.headers ?? {}) }, body: init.body })
    return kernel(String(url), init)
  })
  const options = {
    dataDir,
    kernelOrigin: 'http://kernel.test',
    fetchImpl,
    ledger: extras.ledger ?? null,
    env: { NODE_ENV: 'production', BOTCAMP_PRODUCTION: '1', ...env },
  }
  const camp = await createBotcamp(options)
  const server = createServer((req, res) => {
    camp.handle(req, res, () => {
      res.statusCode = 404
      res.end()
    }).catch(() => {
      if (!res.writableEnded) {
        res.statusCode = 500
        res.end()
      }
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    base,
    calls,
    dataDir,
    options,
    close: async () => {
      await new Promise(resolve => server.close(resolve))
      await rm(dataDir, { recursive: true, force: true })
    },
  }
}

async function api(base, pathname, { method = 'GET', body, cookie, headers: extra } = {}) {
  const headers = { ...(extra ?? {}) }
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
  return {
    status: response.status,
    json,
    text,
    setCookie,
    allowOrigin: response.headers.get('access-control-allow-origin'),
    allowHeaders: response.headers.get('access-control-allow-headers'),
  }
}

function cookieHeader(setCookie) {
  return setCookie[0]?.split(';', 1)[0] ?? ''
}

async function settlePassword(base, email, created, next) {
  const initial = created.json.password
  const login = await api(base, '/api/auth/login', { method: 'POST', body: { email, password: initial } })
  assert.equal(login.status, 200, email)
  assert.equal(login.json.user.mustChangePassword, true)
  const changed = await api(base, '/api/bot', {
    method: 'POST',
    cookie: cookieHeader(login.setCookie),
    body: { endpoint: 'auth/password', payload: { current: initial, next } },
  })
  assert.equal(changed.status, 200, email)
  assert.equal(changed.json.user.mustChangePassword, false)
}

function botCalls(calls, endpoint) {
  return calls.filter((call) => {
    if (!call.href.endsWith('/api/bot')) return false
    try { return JSON.parse(call.body ?? '{}').endpoint === endpoint } catch { return false }
  })
}

test('signup and login fail closed, and a session is required', async () => {
  const ctx = await start({ BOTCAMP_ADMIN_EMAIL: ADMIN_EMAIL, BOTCAMP_ADMIN_PASSWORD: ADMIN_PASSWORD })
  try {
    const signup = await api(ctx.base, '/api/auth/signup', { method: 'POST', body: { email: 'new@example.com', password: 'password-123' } })
    assert.equal(signup.status, 403)
    assert.match(signup.json.error.message, /不能自行注册/)

    const wrong = await api(ctx.base, '/api/auth/login', { method: 'POST', body: { email: ADMIN_EMAIL, password: 'not-the-password' } })
    assert.equal(wrong.status, 401)
    assert.match(wrong.json.error.message, /不正确/)
    assert.equal(wrong.setCookie.length, 0)

    const missing = await api(ctx.base, '/api/auth/login', { method: 'POST', body: { email: 'nobody@example.com', password: 'password-123' } })
    assert.equal(missing.status, 401)

    const bare = await api(ctx.base, '/api/bot', { method: 'POST', body: { endpoint: 'state', payload: {} } })
    assert.equal(bare.status, 401)
    assert.match(bare.json.error.message, /请先登录/)
    assert.equal(botCalls(ctx.calls, 'state').length, 0)

    const feed = await api(ctx.base, '/api/bot/feed')
    assert.equal(feed.status, 401)
    assert.equal(ctx.calls.some(call => call.href.endsWith('/api/bot/feed')), false)

    const login = await api(ctx.base, '/api/auth/login', { method: 'POST', body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
    assert.equal(login.status, 200)
    assert.equal(login.json.user.email, ADMIN_EMAIL)
    assert.equal(login.json.user.role, 'admin')
    assert.equal(login.json.user.kernelKey, undefined)
    assert.equal(login.json.user.passwordHash, undefined)
    assert.equal(login.json.user.mustChangePassword, false)
    assert.match(login.setCookie[0], /HttpOnly/i)
    assert.match(login.setCookie[0], /SameSite=Lax/i)
    assert.match(cookieHeader(login.setCookie), /^botcamp_session=/)

    const stored = await readFile(path.join(ctx.dataDir, 'accounts.json'), 'utf8')
    assert.equal(stored.includes(ADMIN_PASSWORD), false)
    assert.equal(stored.includes(cookieHeader(login.setCookie).split('=')[1]), false)
    assert.match(stored, /"passwordHash":"scrypt\$/)

    const again = await createBotcamp(ctx.options)
    const reloaded = await again.store.authenticate(ADMIN_EMAIL, ADMIN_PASSWORD)
    assert.equal(reloaded?.role, 'admin')
  } finally {
    await ctx.close()
  }
})

test('production without admin env does not install the dev password', async () => {
  const ctx = await start({})
  try {
    const login = await api(ctx.base, '/api/auth/login', { method: 'POST', body: { email: 'admin@localhost', password: 'botcamp-dev' } })
    assert.equal(login.status, 401)
    let stored = ''
    try { stored = await readFile(path.join(ctx.dataDir, 'accounts.json'), 'utf8') } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    assert.equal(stored.includes('botcamp-dev'), false)
    assert.equal(stored.includes('admin@localhost'), false)
  } finally {
    await ctx.close()
  }
})

test('user A cannot read user B, quota blocks a send, and an admin can set quota', async () => {
  const ctx = await start({ BOTCAMP_ADMIN_EMAIL: ADMIN_EMAIL, BOTCAMP_ADMIN_PASSWORD: ADMIN_PASSWORD })
  try {
    const adminLogin = await api(ctx.base, '/api/auth/login', { method: 'POST', body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
    const adminCookie = cookieHeader(adminLogin.setCookie)

    const createdA = await api(ctx.base, '/api/admin/users', {
      method: 'POST', cookie: adminCookie,
      body: { email: 'a@example.com', password: 'password-user-a', quota: 1 },
    })
    const createdB = await api(ctx.base, '/api/admin/users', {
      method: 'POST', cookie: adminCookie,
      body: { email: 'b@example.com', password: 'password-user-b', quota: 5 },
    })
    assert.equal(createdA.status, 201)
    assert.equal(createdB.status, 201)
    assert.equal(JSON.stringify(createdA.json).includes('passwordHash'), false)
    await settlePassword(ctx.base, 'a@example.com', createdA, 'password-user-a')
    await settlePassword(ctx.base, 'b@example.com', createdB, 'password-user-b')

    const loginA = await api(ctx.base, '/api/auth/login', { method: 'POST', body: { email: 'a@example.com', password: 'password-user-a' } })
    const loginB = await api(ctx.base, '/api/auth/login', { method: 'POST', body: { email: 'b@example.com', password: 'password-user-b' } })
    const cookieA = cookieHeader(loginA.setCookie)
    const cookieB = cookieHeader(loginB.setCookie)

    const deniedAdmin = await api(ctx.base, '/api/admin/users', { cookie: cookieA })
    assert.equal(deniedAdmin.status, 403)

    const botA = await api(ctx.base, '/api/bot', { method: 'POST', cookie: cookieA, body: { endpoint: 'create-bot', payload: { name: '甲' } } })
    const botB = await api(ctx.base, '/api/bot', { method: 'POST', cookie: cookieB, body: { endpoint: 'create-bot', payload: { name: '乙' } } })
    assert.equal(botA.json.ok, true)
    assert.equal(botA.json.value.id, 'bot-a')
    assert.equal(botB.json.value.id, 'bot-b')
    const creates = botCalls(ctx.calls, 'create-bot')
    const explicit = creates.filter(call => ['甲', '乙'].includes(JSON.parse(call.body).payload.name))
    assert.equal(explicit.length, 2)
    assert.notEqual(explicit[0].headers['x-botcamp-namespace'], explicit[1].headers['x-botcamp-namespace'])
    assert.match(explicit[0].headers['x-botcamp-namespace'], /^u_/)
    assert.equal(creates.filter(call => ['主编', '写稿', '数据'].includes(JSON.parse(call.body).payload.name)).length, 6)

    const stateA = await api(ctx.base, '/api/bot', { method: 'POST', cookie: cookieA, body: { endpoint: 'state', payload: { since: -1, models: '' } } })
    const stateB = await api(ctx.base, '/api/bot', { method: 'POST', cookie: cookieB, body: { endpoint: 'state', payload: { since: -1, models: '' } } })
    assert.deepEqual(stateA.json.value.bots.map(bot => bot.name), ['主编', '写稿', '数据', '甲'])
    assert.deepEqual(stateB.json.value.bots.map(bot => bot.name), ['主编', '写稿', '数据', '乙'])
    const idsB = new Set(stateB.json.value.bots.map(bot => bot.id))
    for (const id of stateA.json.value.bots.map(bot => bot.id)) assert.equal(idsB.has(id), false)
    assert.equal(JSON.stringify(stateA.json).includes('bot-b'), false)
    assert.equal(JSON.stringify(stateA.json).includes('乙的群'), false)
    assert.equal(JSON.stringify(stateA.json).includes('hidden-question'), false)
    assert.equal(JSON.stringify(stateA.json).includes('kernel-secret'), false)
    assert.equal(JSON.stringify(stateA.json).includes('foreign'), false)
    assert.equal(stateA.json.value.prefs.theme, undefined)
    assert.equal(JSON.stringify(stateB.json).includes('bot-a'), false)

    const prefs = await api(ctx.base, '/api/bot', { method: 'POST', cookie: cookieA, body: { endpoint: 'set-prefs', payload: { theme: 'paper' } } })
    assert.equal(prefs.json.value.theme, 'paper')
    assert.equal(botCalls(ctx.calls, 'set-prefs').length, 0)
    const stateA2 = await api(ctx.base, '/api/bot', { method: 'POST', cookie: cookieA, body: { endpoint: 'state', payload: { since: -1, models: stateA.json.value.modelsKey } } })
    const stateB2 = await api(ctx.base, '/api/bot', { method: 'POST', cookie: cookieB, body: { endpoint: 'state', payload: { since: -1, models: '' } } })
    assert.equal(stateA2.json.value.prefs.theme, 'paper')
    assert.equal(stateB2.json.value.prefs.theme, undefined)

    const blockedKey = await api(ctx.base, '/api/bot', { method: 'POST', cookie: cookieA, body: { endpoint: 'provider-key', payload: { provider: 'deepseek', value: 'sk-test' } } })
    assert.equal(blockedKey.json.ok, false)
    assert.match(blockedKey.json.error.message, /不能配置模型/)
    assert.equal(botCalls(ctx.calls, 'provider-key').length, 0)

    const readB = await api(ctx.base, '/api/bot', { method: 'POST', cookie: cookieA, body: { endpoint: 'chat', payload: { botId: 'bot-b' } } })
    assert.equal(readB.json.ok, false)
    assert.match(readB.json.error.message, /无权/)
    assert.equal(readB.text.includes('secret-bot-b'), false)
    assert.equal(botCalls(ctx.calls, 'chat').length, 0)

    const writeB = await api(ctx.base, '/api/bot', { method: 'POST', cookie: cookieA, body: { endpoint: 'update-bot', payload: { id: 'bot-b', name: '改掉乙' } } })
    assert.equal(writeB.json.ok, false)
    assert.equal(botCalls(ctx.calls, 'update-bot').length, 0)

    const readA = await api(ctx.base, '/api/bot', { method: 'POST', cookie: cookieA, body: { endpoint: 'chat', payload: { botId: 'bot-a' } } })
    assert.equal(readA.json.value.items[0].text, 'secret-bot-a')
    const readAasB = await api(ctx.base, '/api/bot', { method: 'POST', cookie: cookieB, body: { endpoint: 'chat', payload: { botId: 'bot-a' } } })
    assert.equal(readAasB.json.ok, false)
    assert.equal(readAasB.text.includes('secret-bot-a'), false)

    const accounts = JSON.parse(await readFile(path.join(ctx.dataDir, 'accounts.json'), 'utf8'))
    const userA = accounts.users.find(user => user.email === 'a@example.com')
    const userB = accounts.users.find(user => user.email === 'b@example.com')
    const transcriptA = await readFile(path.join(ctx.dataDir, 'namespaces', `${userA.kernelKey}.json`), 'utf8')
    assert.match(transcriptA, /secret-bot-a/)
    const files = await readdir(path.join(ctx.dataDir, 'namespaces'))
    for (const file of files) {
      if (file === `${userA.kernelKey}.json`) continue
      const text = await readFile(path.join(ctx.dataDir, 'namespaces', file), 'utf8')
      assert.equal(text.includes('secret-bot-a'), false)
    }
    assert.equal(userB.kernelKey === userA.kernelKey, false)

    const feedA = await api(ctx.base, '/api/bot/feed', { cookie: cookieA })
    assert.equal(feedA.status, 200)
    assert.match(feedA.text, /only-a/)
    assert.equal(feedA.text.includes('only-b'), false)
    const feedB = await api(ctx.base, '/api/bot/feed', { cookie: cookieB })
    assert.match(feedB.text, /only-b/)
    assert.equal(feedB.text.includes('only-a'), false)

    const blockedSend = await api(ctx.base, '/api/bot', {
      method: 'POST', cookie: cookieA,
      body: { endpoint: 'send', payload: { sessionId: 'sess-a', text: '第一条' } },
    })
    assert.equal(blockedSend.status, 200)
    assert.equal(blockedSend.json.ok, true)
    const over = await api(ctx.base, '/api/bot', {
      method: 'POST', cookie: cookieA,
      body: { endpoint: 'send', payload: { sessionId: 'sess-a', text: '第二条' } },
    })
    assert.equal(over.json.ok, false)
    assert.match(over.json.error.message, /配额已用完/)
    assert.equal(botCalls(ctx.calls, 'send').length, 1)

    const raised = await api(ctx.base, `/api/admin/users/${encodeURIComponent(createdA.json.user.id)}`, {
      method: 'PATCH', cookie: adminCookie, body: { quota: 3 },
    })
    assert.equal(raised.status, 200)
    assert.equal(raised.json.user.quota, 3)
    const self = await api(ctx.base, `/api/admin/users/${encodeURIComponent(createdA.json.user.id)}`, {
      method: 'PATCH', cookie: cookieA, body: { quota: 100 },
    })
    assert.equal(self.status, 403)

    const again = await api(ctx.base, '/api/bot', {
      method: 'POST', cookie: cookieA,
      body: { endpoint: 'send', payload: { sessionId: 'sess-a', text: '恢复后' } },
    })
    assert.equal(again.json.ok, true)
    const me = await api(ctx.base, '/api/auth/me', { cookie: cookieA })
    assert.equal(me.json.user.quota, 3)
    assert.equal(me.json.user.used, 2)
    assert.equal(botCalls(ctx.calls, 'send').length, 2)

    const zero = await api(ctx.base, `/api/admin/users/${encodeURIComponent(createdA.json.user.id)}`, {
      method: 'PATCH', cookie: adminCookie, body: { quota: 0 },
    })
    assert.equal(zero.json.user.quota, 0)
    const stopped = await api(ctx.base, '/api/bot', {
      method: 'POST', cookie: cookieA,
      body: { endpoint: 'send', payload: { sessionId: 'sess-a', text: '不该发出去' } },
    })
    assert.equal(stopped.json.ok, false)
    assert.match(stopped.json.error.message, /配额已用完/)
    assert.equal(botCalls(ctx.calls, 'send').length, 2)
    const kernelCalls = ctx.calls.filter(call => call.href.includes('/api/bot'))
    assert.ok(kernelCalls.length > 0)
    for (const call of kernelCalls) {
      assert.match(String(call.headers.cookie ?? ''), /botcamp_session=/)
      assert.equal(String(call.headers.cookie).includes(ADMIN_PASSWORD), false)
      assert.equal(String(call.body ?? '').includes(ADMIN_PASSWORD), false)
    }
  } finally {
    await ctx.close()
  }
})

test('an older admin id is rewritten so another instance accepts the session', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botcamp-old-'))
  const otherDir = await mkdtemp(path.join(tmpdir(), 'botcamp-old-other-'))
  const env = { NODE_ENV: 'production', BOTCAMP_PRODUCTION: '1', BOTCAMP_ADMIN_EMAIL: ADMIN_EMAIL, BOTCAMP_ADMIN_PASSWORD: ADMIN_PASSWORD }
  try {
    await writeFile(path.join(dir, 'accounts.json'), JSON.stringify({
      users: [{
        id: 'old-admin-id-0123456789',
        email: ADMIN_EMAIL,
        passwordHash: 'scrypt$unused$unused',
        role: 'admin',
        quota: 3,
        used: 1,
        kernelKey: 'u_oldkernelkey12',
        prefs: {},
        prefsVersion: 0,
        mainBotIds: [],
        createdAt: '2020-01-01T00:00:00.000Z',
      }],
      sessions: [],
      resources: [],
    }))
    const camp = await createBotcamp({ dataDir: dir, env, kernelOrigin: 'http://kernel.test', fetchImpl: async () => new Response('ok') })
    const users = await camp.store.listUsers()
    assert.notEqual(users[0].id, 'old-admin-id-0123456789')
    assert.equal(users[0].used, 1)
    const session = await camp.store.createSession(users[0].id)
    const other = await createBotcamp({ dataDir: otherDir, env, kernelOrigin: 'http://kernel.test', fetchImpl: async () => new Response('ok') })
    const user = await other.store.userForToken(session.token)
    assert.equal(user?.email, ADMIN_EMAIL)
    assert.equal(user?.id, users[0].id)
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(otherDir, { recursive: true, force: true })
  }
})

test('a signed admin session works on another instance and logout revokes it here', async () => {
  const ctx = await start({ BOTCAMP_ADMIN_EMAIL: ADMIN_EMAIL, BOTCAMP_ADMIN_PASSWORD: ADMIN_PASSWORD })
  const otherDir = await mkdtemp(path.join(tmpdir(), 'botcamp-other-'))
  try {
    const login = await api(ctx.base, '/api/auth/login', { method: 'POST', body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
    const pair = cookieHeader(login.setCookie)
    const token = decodeURIComponent(pair.slice(pair.indexOf('=') + 1))
    const other = await createBotcamp({ ...ctx.options, dataDir: otherDir })
    const user = await other.store.userForToken(token)
    assert.equal(user?.email, ADMIN_EMAIL)
    assert.equal(user?.role, 'admin')
    const home = await other.store.listUsers()
    const there = await other.store.getUser(home[0].id)
    const here = JSON.parse(await readFile(path.join(ctx.dataDir, 'accounts.json'), 'utf8'))
    assert.equal(here.users[0].id, there.id)
    assert.equal(here.users[0].kernelKey, there.kernelKey)
    const bye = await api(ctx.base, '/api/auth/logout', { method: 'POST', cookie: pair, body: {} })
    assert.equal(bye.status, 200)
    const me = await api(ctx.base, '/api/auth/me', { cookie: pair })
    assert.equal(me.status, 401)
  } finally {
    await ctx.close()
    await rm(otherDir, { recursive: true, force: true })
  }
})

test('a stale instance still logs in a zero-quota user, refuses send, and does not erase the other user', async () => {
  const ledger = createMemoryLedger()
  const env = { BOTCAMP_ADMIN_EMAIL: ADMIN_EMAIL, BOTCAMP_ADMIN_PASSWORD: ADMIN_PASSWORD }
  const first = await start(env, { ledger })
  const second = await start(env, { ledger })
  try {
    const admin = await api(first.base, '/api/bot', {
      method: 'POST',
      body: { endpoint: 'auth/login', payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } },
    })
    assert.equal(admin.status, 200)
    const adminCookie = cookieHeader(admin.setCookie)
    const created = await api(first.base, '/api/bot', {
      method: 'POST',
      cookie: adminCookie,
      body: { endpoint: 'admin/create', payload: { email: 'zero@example.com', password: 'password-zero', quota: 0 } },
    })
    assert.equal(created.status, 201)
    assert.equal(created.json.user.quota, 0)
    assert.equal(created.json.user.used, 0)
    await settlePassword(first.base, 'zero@example.com', created, 'password-zero')

    const login = await api(second.base, '/api/bot', {
      method: 'POST',
      body: { endpoint: 'auth/login', payload: { email: 'zero@example.com', password: 'password-zero' } },
    })
    assert.equal(login.status, 200)
    assert.equal(login.json.user.quota, 0)
    assert.equal(login.json.user.used, 0)
    assert.equal(login.json.error, undefined)
    const zeroCookie = cookieHeader(login.setCookie)

    const sent = await api(second.base, '/api/bot', {
      method: 'POST',
      cookie: zeroCookie,
      body: { endpoint: 'send', payload: { text: '不会进内核' } },
    })
    assert.equal(sent.json.ok, false)
    assert.match(sent.json.error.message, /配额已用完/)
    assert.equal(botCalls(first.calls, 'send').length, 0)
    assert.equal(botCalls(second.calls, 'send').length, 0)

    const adminAgain = await api(second.base, '/api/bot', {
      method: 'POST',
      body: { endpoint: 'auth/login', payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } },
    })
    const adminCookie2 = cookieHeader(adminAgain.setCookie)
    const other = await api(second.base, '/api/bot', {
      method: 'POST',
      cookie: adminCookie2,
      body: { endpoint: 'admin/create', payload: { email: 'other@example.com', password: 'password-other', quota: 5 } },
    })
    assert.equal(other.status, 201)
    const listed = await api(first.base, '/api/bot', {
      method: 'POST',
      cookie: adminCookie,
      body: { endpoint: 'admin/list', payload: {} },
    })
    assert.equal(listed.status, 200)
    assert.deepEqual(listed.json.users.map(user => user.email).sort(), [ADMIN_EMAIL, 'other@example.com', 'zero@example.com'])
    const zeroId = listed.json.users.find(user => user.email === 'zero@example.com').id
    const removed = await api(second.base, '/api/bot', {
      method: 'POST',
      cookie: adminCookie2,
      body: { endpoint: 'admin/delete', payload: { id: zeroId } },
    })
    assert.equal(removed.status, 200)
    const after = await api(first.base, '/api/bot', {
      method: 'POST',
      cookie: adminCookie,
      body: { endpoint: 'admin/list', payload: {} },
    })
    assert.equal(after.json.users.some(user => user.email === 'zero@example.com'), false)
    assert.equal(after.json.users.some(user => user.email === 'other@example.com'), true)
    const gone = await api(second.base, '/api/bot', {
      method: 'POST',
      body: { endpoint: 'auth/login', payload: { email: 'zero@example.com', password: 'password-zero' } },
    })
    assert.equal(gone.status, 401)
    assert.equal(gone.json.error.code, 'auth/invalid')
  } finally {
    await first.close()
    await second.close()
  }
})

test('the demox bot route logs in, isolates, and blocks a zero quota before the kernel', async () => {
  const ctx = await start({ BOTCAMP_ADMIN_EMAIL: ADMIN_EMAIL, BOTCAMP_ADMIN_PASSWORD: ADMIN_PASSWORD })
  try {
    const bare = await api(ctx.base, '/api/bot', { method: 'POST', body: { endpoint: 'state', payload: {} } })
    assert.equal(bare.status, 401)
    assert.equal(ctx.calls.some(call => call.href.includes('/api/bot')), false)

    const signup = await api(ctx.base, '/api/bot', { method: 'POST', body: { endpoint: 'auth/signup', payload: { email: 'new@example.com', password: 'password-123' } } })
    assert.equal(signup.status, 403)

    const login = await api(ctx.base, '/api/bot', { method: 'POST', body: { endpoint: 'auth/login', payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } } })
    assert.equal(login.status, 200)
    assert.match(login.setCookie[0], /HttpOnly/i)
    assert.match(cookieHeader(login.setCookie), /^botcamp_session=/)
    const adminCookie = cookieHeader(login.setCookie)

    const created = await api(ctx.base, '/api/bot', {
      method: 'POST', cookie: adminCookie,
      body: { endpoint: 'admin/create', payload: { email: 'zero@example.com', password: 'password-zero', quota: 0 } },
    })
    assert.equal(created.status, 201)
    await settlePassword(ctx.base, 'zero@example.com', created, 'password-zero')
    const zeroLogin = await api(ctx.base, '/api/bot', { method: 'POST', body: { endpoint: 'auth/login', payload: { email: 'zero@example.com', password: 'password-zero' } } })
    const zeroCookie = cookieHeader(zeroLogin.setCookie)
    const other = await api(ctx.base, '/api/bot', {
      method: 'POST', cookie: adminCookie,
      body: { endpoint: 'admin/create', payload: { email: 'other@example.com', password: 'password-other', quota: 1 } },
    })
    assert.equal(other.status, 201)
    await settlePassword(ctx.base, 'other@example.com', other, 'password-other')
    const otherLogin = await api(ctx.base, '/api/bot', { method: 'POST', body: { endpoint: 'auth/login', payload: { email: 'other@example.com', password: 'password-other' } } })
    const otherCookie = cookieHeader(otherLogin.setCookie)

    const botOther = await api(ctx.base, '/api/bot', { method: 'POST', cookie: otherCookie, body: { endpoint: 'create-bot', payload: { name: '乙' } } })
    assert.equal(botOther.json.value.id, 'bot-b')
    const denied = await api(ctx.base, '/api/bot', { method: 'POST', cookie: zeroCookie, body: { endpoint: 'chat', payload: { botId: 'bot-b' } } })
    assert.equal(denied.json.ok, false)
    assert.equal(botCalls(ctx.calls, 'chat').length, 0)

    const stopped = await api(ctx.base, '/api/bot', { method: 'POST', cookie: zeroCookie, body: { endpoint: 'send', payload: { text: '不会进内核' } } })
    assert.equal(stopped.json.ok, false)
    assert.match(stopped.json.error.message, /配额已用完/)
    assert.equal(botCalls(ctx.calls, 'send').length, 0)
  } finally {
    await ctx.close()
  }
})

test('model catalog writes are rejected and settings and usage stay with the caller', async () => {
  const ctx = await start({ BOTCAMP_ADMIN_EMAIL: ADMIN_EMAIL, BOTCAMP_ADMIN_PASSWORD: ADMIN_PASSWORD })
  try {
    const adminLogin = await api(ctx.base, '/api/auth/login', { method: 'POST', body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
    const adminCookie = cookieHeader(adminLogin.setCookie)
    const createdA = await api(ctx.base, '/api/admin/users', {
      method: 'POST', cookie: adminCookie,
      body: { email: 'a@example.com', password: 'password-user-a', quota: 5 },
    })
    const createdB = await api(ctx.base, '/api/admin/users', {
      method: 'POST', cookie: adminCookie,
      body: { email: 'b@example.com', password: 'password-user-b', quota: 5 },
    })
    await settlePassword(ctx.base, 'a@example.com', createdA, 'password-user-a')
    await settlePassword(ctx.base, 'b@example.com', createdB, 'password-user-b')
    const cookieA = cookieHeader((await api(ctx.base, '/api/auth/login', { method: 'POST', body: { email: 'a@example.com', password: 'password-user-a' } })).setCookie)
    const cookieB = cookieHeader((await api(ctx.base, '/api/auth/login', { method: 'POST', body: { email: 'b@example.com', password: 'password-user-b' } })).setCookie)
    await api(ctx.base, '/api/bot', { method: 'POST', cookie: cookieA, body: { endpoint: 'create-bot', payload: { name: '甲' } } })
    await api(ctx.base, '/api/bot', { method: 'POST', cookie: cookieB, body: { endpoint: 'create-bot', payload: { name: '乙' } } })

    const modelWrites = [
      ['provider-key', { provider: 'deepseek', value: 'sk-from-a' }],
      ['provider-add', { provider: 'custom', key: 'sk-from-a', baseURL: 'https://example.invalid' }],
      ['provider-remove', { provider: 'deepseek' }],
      ['provider-models', { baseURL: 'https://example.invalid', key: 'sk-from-a' }],
      ['model-config', { models: [{ id: 'injected' }] }],
      ['update-bot', { id: 'bot-a', apiKey: 'sk-from-a', provider: 'deepseek' }],
    ]
    for (const [endpoint, payload] of modelWrites) {
      const refused = await api(ctx.base, '/api/bot', { method: 'POST', cookie: cookieA, body: { endpoint, payload } })
      assert.equal(refused.json.ok, false, endpoint)
      assert.match(refused.json.error.message, /不能配置模型/)
      assert.equal(botCalls(ctx.calls, endpoint).length, 0, endpoint)
    }
    const adminWrite = await api(ctx.base, '/api/bot', {
      method: 'POST', cookie: adminCookie,
      body: { endpoint: 'provider-add', payload: { provider: 'deepseek', key: 'sk-admin' } },
    })
    assert.equal(adminWrite.json.ok, false)
    assert.equal(ctx.calls.some(call => String(call.body ?? '').includes('sk-from-a') || String(call.body ?? '').includes('sk-admin')), false)

    const picked = await api(ctx.base, '/api/bot', {
      method: 'POST', cookie: cookieA,
      body: { endpoint: 'update-bot', payload: { id: 'bot-a', model: 'deepseek/deepseek-chat' } },
    })
    assert.equal(picked.json.ok, true)
    const pickedForeign = await api(ctx.base, '/api/bot', {
      method: 'POST', cookie: cookieA,
      body: { endpoint: 'update-bot', payload: { id: 'bot-b', model: 'deepseek/deepseek-chat' } },
    })
    assert.equal(pickedForeign.json.ok, false)
    assert.equal(botCalls(ctx.calls, 'update-bot').length, 1)

    const workspace = '/only/user-a/workspace'
    const secretValue = 'secret-value-only-a'
    const savedWorkspace = await api(ctx.base, '/api/bot', {
      method: 'POST', cookie: cookieA,
      body: { endpoint: 'team-workspace', payload: { path: workspace } },
    })
    assert.equal(savedWorkspace.json.value.team, workspace)
    const savedSecret = await api(ctx.base, '/api/bot', {
      method: 'POST', cookie: cookieA,
      body: { endpoint: 'secret-set', payload: { name: 'shared-name', value: secretValue, scope: 'all' } },
    })
    assert.equal(savedSecret.json.ok, true)
    assert.equal(savedSecret.text.includes(secretValue), false)
    const savedConnector = await api(ctx.base, '/api/bot', {
      method: 'POST', cookie: cookieA,
      body: { endpoint: 'connector-connect', payload: { id: 'github', token: 'ghp-only-user-a' } },
    })
    assert.equal(savedConnector.json.value.state, 'ready')
    assert.equal(savedConnector.text.includes('ghp-only-user-a'), false)
    await api(ctx.base, '/api/bot', {
      method: 'POST', cookie: cookieB,
      body: { endpoint: 'secret-set', payload: { name: 'shared-name', value: 'secret-value-only-b', scope: 'all' } },
    })
    const workspaceB = await api(ctx.base, '/api/bot', {
      method: 'POST', cookie: cookieB,
      body: { endpoint: 'team-workspace', payload: { path: '/only/user-b/workspace' } },
    })
    assert.equal(workspaceB.json.value.team, '/only/user-b/workspace')
    for (const endpoint of ['team-workspace', 'secret-set', 'connector-connect', 'folders', 'diagnostics', 'memory-view']) {
      assert.equal(botCalls(ctx.calls, endpoint).length, 0, endpoint)
    }
    const files = await api(ctx.base, '/api/bot', {
      method: 'POST', cookie: cookieA,
      body: { endpoint: 'file-text', payload: { file: '/etc/passwd' } },
    })
    assert.equal(files.json.ok, false)
    assert.equal(botCalls(ctx.calls, 'file-text').length, 0)

    const foldersA = await api(ctx.base, '/api/bot', { method: 'POST', cookie: cookieA, body: { endpoint: 'folders', payload: {} } })
    const foldersB = await api(ctx.base, '/api/bot', { method: 'POST', cookie: cookieB, body: { endpoint: 'folders', payload: {} } })
    assert.equal(foldersA.json.value.team, workspace)
    assert.equal(foldersB.json.value.team, '/only/user-b/workspace')
    assert.equal(foldersB.text.includes(workspace), false)

    const stateA = await api(ctx.base, '/api/bot', { method: 'POST', cookie: cookieA, body: { endpoint: 'state', payload: { since: -1, models: '' } } })
    const stateB = await api(ctx.base, '/api/bot', { method: 'POST', cookie: cookieB, body: { endpoint: 'state', payload: { since: -1, models: '' } } })
    assert.equal(stateA.json.value.secrets.some(secret => secret.name === 'shared-name'), true)
    assert.equal(stateA.text.includes(secretValue), false)
    assert.equal(stateA.text.includes('ghp-only-user-a'), false)
    assert.equal(stateA.text.includes('ghp-foreign-token'), false)
    assert.equal(stateA.text.includes('foreign-account'), false)
    assert.equal(stateA.json.value.connectors.find(item => item.id === 'github')?.account, '已保存')
    assert.equal(stateB.text.includes(secretValue), false)
    assert.equal(stateB.text.includes(workspace), false)
    assert.equal(stateB.json.value.secrets.some(secret => secret.name === 'shared-name'), true)
    assert.equal(JSON.stringify(stateB.json).includes('foreign-secret-value'), false)

    const memoryForeign = await api(ctx.base, '/api/bot', {
      method: 'POST', cookie: cookieA,
      body: { endpoint: 'memory-view', payload: { botId: 'bot-b' } },
    })
    assert.equal(memoryForeign.json.ok, false)
    const memoryA = await api(ctx.base, '/api/bot', {
      method: 'POST', cookie: cookieA,
      body: { endpoint: 'memory-view', payload: { botId: 'bot-a' } },
    })
    assert.deepEqual(memoryA.json.value.entries, [])
    assert.equal(botCalls(ctx.calls, 'memory-view').length, 0)

    const usageA = await api(ctx.base, '/api/bot', {
      method: 'POST', cookie: cookieA,
      body: { endpoint: 'usage', payload: { timeZone: 'UTC', userId: 'b@example.com', botId: 'bot-b' } },
    })
    const usageB = await api(ctx.base, '/api/bot', {
      method: 'POST', cookie: cookieB,
      body: { endpoint: 'usage', payload: { timeZone: 'UTC', userId: 'a@example.com', botId: 'bot-a' } },
    })
    assert.equal(usageA.json.ok, true)
    assert.deepEqual(usageA.json.value.rows, [['2026-10-21 10', 0, 0, 0, 10, 1, 2, 5, 1]])
    assert.deepEqual(usageA.json.value.owners.map(owner => owner.id), ['bot-a'])
    assert.equal(usageA.json.value.totalTokens, undefined)
    assert.equal(usageA.json.value.models[0].tokens, undefined)
    assert.equal(usageA.text.includes('999'), false)
    assert.equal(usageA.text.includes('乙'), false)
    assert.equal(usageB.json.value.rows[0][4], 999)
    assert.equal(usageB.json.value.rows[0][7], 888)
    assert.equal(usageB.text.includes('甲'), false)
    const usageBody = JSON.parse(botCalls(ctx.calls, 'usage')[0].body)
    assert.equal(usageBody.payload.userId, undefined)
    assert.equal(usageBody.payload.botId, undefined)

    const accounts = JSON.parse(await readFile(path.join(ctx.dataDir, 'accounts.json'), 'utf8'))
    const userA = accounts.users.find(user => user.email === 'a@example.com')
    const userB = accounts.users.find(user => user.email === 'b@example.com')
    const fileA = await readFile(path.join(ctx.dataDir, 'namespaces', `${userA.kernelKey}.json`), 'utf8')
    const fileB = await readFile(path.join(ctx.dataDir, 'namespaces', `${userB.kernelKey}.json`), 'utf8')
    assert.match(fileA, /secret-value-only-a/)
    assert.match(fileA, /ghp-only-user-a/)
    assert.equal(fileA.includes('secret-value-only-b'), false)
    assert.equal(fileB.includes('secret-value-only-a'), false)
    assert.equal(fileA.includes('999'), false)
    assert.match(fileB, /secret-value-only-b/)
  } finally {
    await ctx.close()
  }
})

test('user A cannot list or open user B workspace, send into B session, or traverse out', async () => {
  const ctx = await start({ BOTCAMP_ADMIN_EMAIL: ADMIN_EMAIL, BOTCAMP_ADMIN_PASSWORD: ADMIN_PASSWORD })
  try {
    const adminLogin = await api(ctx.base, '/api/auth/login', { method: 'POST', body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
    const adminCookie = cookieHeader(adminLogin.setCookie)
    const createdA = await api(ctx.base, '/api/admin/users', {
      method: 'POST', cookie: adminCookie,
      body: { email: 'a@example.com', password: 'password-user-a', quota: 5 },
    })
    const createdB = await api(ctx.base, '/api/admin/users', {
      method: 'POST', cookie: adminCookie,
      body: { email: 'b@example.com', password: 'password-user-b', quota: 5 },
    })
    await settlePassword(ctx.base, 'a@example.com', createdA, 'password-user-a')
    await settlePassword(ctx.base, 'b@example.com', createdB, 'password-user-b')
    const cookieA = cookieHeader((await api(ctx.base, '/api/auth/login', { method: 'POST', body: { email: 'a@example.com', password: 'password-user-a' } })).setCookie)
    const cookieB = cookieHeader((await api(ctx.base, '/api/auth/login', { method: 'POST', body: { email: 'b@example.com', password: 'password-user-b' } })).setCookie)
    const botA = await api(ctx.base, '/api/bot', { method: 'POST', cookie: cookieA, body: { endpoint: 'create-bot', payload: { name: '甲' } } })
    const botB = await api(ctx.base, '/api/bot', { method: 'POST', cookie: cookieB, body: { endpoint: 'create-bot', payload: { name: '乙' } } })
    assert.equal(botA.json.value.sessionId, 'sess-a')
    assert.equal(botB.json.value.sessionId, 'sess-b')

    const accounts = JSON.parse(await readFile(path.join(ctx.dataDir, 'accounts.json'), 'utf8'))
    const userA = accounts.users.find(user => user.email === 'a@example.com')
    const userB = accounts.users.find(user => user.email === 'b@example.com')
    const rootA = path.join(ctx.dataDir, 'workspaces', userA.kernelKey)
    const rootB = path.join(ctx.dataDir, 'workspaces', userB.kernelKey)
    assert.notEqual(rootA, rootB)
    const dirs = await readdir(path.join(ctx.dataDir, 'workspaces'))
    assert.deepEqual(new Set(dirs), new Set(accounts.users.map(user => user.kernelKey)))

    const secret = 'beta-workspace-secret'
    const writtenB = await api(ctx.base, '/api/bot', {
      method: 'POST', cookie: cookieB,
      body: { endpoint: 'file-write', payload: { file: 'secret.txt', text: secret } },
    })
    assert.equal(writtenB.json.ok, true)
    const writtenA = await api(ctx.base, '/api/bot', {
      method: 'POST', cookie: cookieA,
      body: { endpoint: 'file-write', payload: { file: 'secret.txt', text: 'alpha-workspace-secret' } },
    })
    assert.equal(writtenA.json.ok, true)
    await api(ctx.base, '/api/bot', {
      method: 'POST', cookie: cookieB,
      body: { endpoint: 'team-workspace', payload: { path: 'notes' } },
    })
    await api(ctx.base, '/api/bot', {
      method: 'POST', cookie: cookieA,
      body: { endpoint: 'set-prefs', payload: { theme: 'paper' } },
    })

    const listA = await api(ctx.base, '/api/bot', { method: 'POST', cookie: cookieA, body: { endpoint: 'workspace-list', payload: {} } })
    const listB = await api(ctx.base, '/api/bot', { method: 'POST', cookie: cookieB, body: { endpoint: 'workspace-list', payload: {} } })
    assert.equal(listA.json.ok, true)
    assert.deepEqual(listA.json.value.workspaces.map(item => item.id), [userA.kernelKey])
    assert.equal(JSON.stringify(listA.json).includes(userB.kernelKey), false)
    assert.equal(JSON.stringify(listA.json).includes(secret), false)
    assert.equal(JSON.stringify(listA.json).includes('notes'), false)
    assert.deepEqual(listB.json.value.workspaces.map(item => item.id), [userB.kernelKey])

    const openB = await api(ctx.base, '/api/bot', {
      method: 'POST', cookie: cookieA,
      body: { endpoint: 'workspace-open', payload: { workspaceId: userB.kernelKey } },
    })
    assert.equal(openB.json.ok, false)
    assert.match(openB.json.error.message, /无权/)
    assert.equal(openB.text.includes(secret), false)

    const ownFile = await api(ctx.base, '/api/bot', {
      method: 'POST', cookie: cookieA,
      body: { endpoint: 'file-text', payload: { file: 'secret.txt' } },
    })
    assert.equal(ownFile.json.value.text, 'alpha-workspace-secret')

    const sendOwn = await api(ctx.base, '/api/bot', {
      method: 'POST', cookie: cookieA,
      body: { endpoint: 'send', payload: { sessionId: 'sess-a', text: '自己的会话' } },
    })
    assert.equal(sendOwn.json.ok, true)
    const sendOther = await api(ctx.base, '/api/bot', {
      method: 'POST', cookie: cookieA,
      body: { endpoint: 'send', payload: { sessionId: 'sess-b', text: '写进乙的会话' } },
    })
    assert.equal(sendOther.json.ok, false)
    assert.match(sendOther.json.error.message, /无权/)

    const relative = await api(ctx.base, '/api/bot', {
      method: 'POST', cookie: cookieA,
      body: { endpoint: 'file-text', payload: { file: `../${userB.kernelKey}/secret.txt` } },
    })
    const doubled = await api(ctx.base, '/api/bot', {
      method: 'POST', cookie: cookieA,
      body: { endpoint: 'folder-list', payload: { path: `../../workspaces/${userB.kernelKey}` } },
    })
    const absolute = await api(ctx.base, '/api/bot', {
      method: 'POST', cookie: cookieA,
      body: { endpoint: 'file-text', payload: { file: path.join(rootB, 'secret.txt') } },
    })
    assert.equal(relative.json.ok, false)
    assert.match(relative.json.error.message, /工作区/)
    assert.equal(doubled.json.ok, false)
    assert.equal(absolute.json.ok, false)
    assert.equal(relative.text.includes(secret), false)
    assert.equal(absolute.text.includes(secret), false)

    await symlink(path.join(rootB, 'secret.txt'), path.join(rootA, 'alias.txt'))
    const linked = await api(ctx.base, '/api/bot', {
      method: 'POST', cookie: cookieA,
      body: { endpoint: 'file-text', payload: { file: 'alias.txt' } },
    })
    assert.equal(linked.json.ok, false)
    assert.equal(linked.text.includes(secret), false)

    assert.equal(await readFile(path.join(rootB, 'secret.txt'), 'utf8'), secret)
    const settingsA = JSON.parse(await readFile(path.join(rootA, 'settings.json'), 'utf8'))
    const settingsB = JSON.parse(await readFile(path.join(rootB, 'settings.json'), 'utf8'))
    assert.equal(settingsA.prefs.theme, 'paper')
    assert.equal(settingsB.prefs?.theme, undefined)
    const ownedA = JSON.parse(await readFile(path.join(rootA, 'owned.json'), 'utf8'))
    const ownedB = JSON.parse(await readFile(path.join(rootB, 'owned.json'), 'utf8'))
    assert.deepEqual(ownedA.sessions.filter(id => id === 'sess-a' || id === 'sess-b'), ['sess-a'])
    assert.deepEqual(ownedB.sessions.filter(id => id === 'sess-a' || id === 'sess-b'), ['sess-b'])
    assert.equal(ownedA.sessions.length, 4)
    assert.equal(ownedB.sessions.length, 4)
    for (const endpoint of ['workspace-list', 'workspace-open', 'file-text', 'file-write', 'folder-list', 'team-workspace']) {
      assert.equal(botCalls(ctx.calls, endpoint).length, 0, endpoint)
    }
  } finally {
    await ctx.close()
  }
})

test('opening an account creates the three duty bots without a room, a main bot, or a quota charge', async () => {
  const ctx = await start({ BOTCAMP_ADMIN_EMAIL: ADMIN_EMAIL, BOTCAMP_ADMIN_PASSWORD: ADMIN_PASSWORD })
  try {
    const adminLogin = await api(ctx.base, '/api/auth/login', { method: 'POST', body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
    const adminCookie = cookieHeader(adminLogin.setCookie)
    const created = await api(ctx.base, '/api/admin/users', {
      method: 'POST',
      cookie: adminCookie,
      body: { email: 'a@example.com', password: 'password-user-a', quota: 0 },
    })
    assert.equal(created.status, 201)
    assert.deepEqual(created.json.team.created, ['主编', '写稿', '数据'])
    assert.deepEqual(created.json.team.failed, [])
    assert.equal(created.json.user.used, 0)
    assert.equal(JSON.stringify(created.json).includes('password-user-a'), false)

    const accounts = JSON.parse(await readFile(path.join(ctx.dataDir, 'accounts.json'), 'utf8'))
    const user = accounts.users.find(entry => entry.email === 'a@example.com')
    const admin = accounts.users.find(entry => entry.email === ADMIN_EMAIL)
    const creates = botCalls(ctx.calls, 'create-bot')
    assert.equal(creates.length, 3)
    assert.deepEqual(creates.map(call => JSON.parse(call.body).payload.name), DEFAULT_TEAM.map(member => member.name))
    for (const call of creates) {
      const payload = JSON.parse(call.body).payload
      const member = DEFAULT_TEAM.find(item => item.name === payload.name)
      assert.equal(call.headers['x-botcamp-namespace'], user.kernelKey)
      assert.notEqual(user.kernelKey, admin.kernelKey)
      assert.match(String(call.headers.cookie ?? ''), /botcamp_session=/)
      assert.equal(Object.hasOwn(payload, 'model'), false)
      assert.equal(payload.hidden, undefined)
      assert.equal(payload.brief, member.brief)
      assert.equal(payload.instructions, member.brief)
      assert.equal(/群|只能|只和|不要关注/.test(payload.brief), false)
      assert.equal(/群|只能|只和|不要关注/.test(payload.instructions), false)
    }
    assert.equal(botCalls(ctx.calls, 'create-room').length, 0)
    assert.equal(botCalls(ctx.calls, 'send').length, 0)
    assert.equal(botCalls(ctx.calls, 'set-main').length, 0)
    assert.equal(ctx.calls.some(call => call.href.includes('/api/bot') && String(call.headers['x-botcamp-exchange'] ?? '') !== ''), false)

    await settlePassword(ctx.base, 'a@example.com', created, 'password-user-a')
    const login = await api(ctx.base, '/api/auth/login', { method: 'POST', body: { email: 'a@example.com', password: 'password-user-a' } })
    assert.equal(login.status, 200)
    assert.equal(login.json.user.used, 0)
    assert.equal(login.json.user.remaining, 0)
    const state = await api(ctx.base, '/api/bot', {
      method: 'POST',
      cookie: cookieHeader(login.setCookie),
      body: { endpoint: 'state', payload: {} },
    })
    assert.deepEqual(state.json.value.bots.map(bot => bot.name), ['主编', '写稿', '数据'])
    assert.deepEqual(state.json.value.rooms, [])
    assert.equal(state.json.value.mainBotId, null)
    assert.deepEqual(state.json.value.mainBotIds, [])
    assert.equal(state.json.value.bots.some(bot => bot.hidden === true), false)
  } finally {
    await ctx.close()
  }
})

test('a missed default bot still leaves the account and does not charge quota', async () => {
  let creates = 0
  const fetchImpl = async (url, init = {}) => {
    const href = String(url)
    if (!href.includes('/api/bot')) return new Response('ok', { status: 200 })
    const body = JSON.parse(init.body ?? '{}')
    if (body.endpoint !== 'create-bot') return Response.json({ ok: true, value: { revision: 1, bots: [], rooms: [] } })
    creates += 1
    if (body.payload?.name === '写稿') return Response.json({ ok: false, error: { message: 'kernel down' } }, { status: 500 })
    return Response.json({ ok: true, value: { id: `bot-${creates}`, name: body.payload.name, sessionId: `sess-${creates}` } })
  }
  const ctx = await start({ BOTCAMP_ADMIN_EMAIL: ADMIN_EMAIL, BOTCAMP_ADMIN_PASSWORD: ADMIN_PASSWORD }, { fetchImpl })
  try {
    const adminLogin = await api(ctx.base, '/api/auth/login', { method: 'POST', body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
    const created = await api(ctx.base, '/api/admin/users', {
      method: 'POST',
      cookie: cookieHeader(adminLogin.setCookie),
      body: { email: 'a@example.com', password: 'password-user-a', quota: 0 },
    })
    assert.equal(created.status, 201)
    assert.equal(creates, 3)
    assert.deepEqual(created.json.team.created, ['主编', '数据'])
    assert.deepEqual(created.json.team.failed, ['写稿'])
    assert.equal(JSON.stringify(created.json).includes('kernel down'), false)
    const login = await api(ctx.base, '/api/auth/login', { method: 'POST', body: { email: 'a@example.com', password: created.json.password } })
    assert.equal(login.status, 200)
    assert.equal(login.json.user.mustChangePassword, true)
    assert.equal(login.json.user.used, 0)
    assert.equal(login.json.user.remaining, 0)
  } finally {
    await ctx.close()
  }
})

test('the first login must replace the generated password before the kernel, and a later change keeps the session', async () => {
  const ctx = await start({ BOTCAMP_ADMIN_EMAIL: ADMIN_EMAIL, BOTCAMP_ADMIN_PASSWORD: ADMIN_PASSWORD })
  try {
    const adminLogin = await api(ctx.base, '/api/auth/login', { method: 'POST', body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
    const adminCookie = cookieHeader(adminLogin.setCookie)
    const created = await api(ctx.base, '/api/admin/users', {
      method: 'POST',
      cookie: adminCookie,
      body: { email: 'fresh@example.com', role: 'admin', quota: 1, password: 'client-should-not-choose' },
    })
    assert.equal(created.status, 201)
    assert.equal(created.json.user.mustChangePassword, true)
    assert.equal(validInitial(created.json.password), true)
    assert.equal(created.json.password === 'client-should-not-choose', false)
    assert.equal(JSON.stringify(created.json.user).includes(created.json.password), false)
    const stored = await readFile(path.join(ctx.dataDir, 'accounts.json'), 'utf8')
    assert.equal(stored.includes(created.json.password), false)
    assert.equal(stored.includes('client-should-not-choose'), false)

    const first = await api(ctx.base, '/api/auth/login', { method: 'POST', body: { email: 'fresh@example.com', password: created.json.password } })
    const firstCookie = cookieHeader(first.setCookie)
    const blocked = await api(ctx.base, '/api/bot', { method: 'POST', cookie: firstCookie, body: { endpoint: 'state', payload: {} } })
    assert.equal(blocked.status, 403)
    assert.equal(blocked.json.error.code, 'auth/password')
    assert.equal(botCalls(ctx.calls, 'state').length, 0)
    const feed = await api(ctx.base, '/api/bot/feed', { cookie: firstCookie })
    assert.equal(feed.status, 403)
    assert.equal(ctx.calls.some(call => call.href.endsWith('/api/bot/feed')), false)
    const listing = await api(ctx.base, '/api/admin/users', { cookie: firstCookie })
    assert.equal(listing.status, 403)

    const wrong = await api(ctx.base, '/api/bot', {
      method: 'POST', cookie: firstCookie,
      body: { endpoint: 'auth/password', payload: { current: 'not-the-password', next: 'password-next-1' } },
    })
    assert.equal(wrong.status, 400)
    const same = await api(ctx.base, '/api/bot', {
      method: 'POST', cookie: firstCookie,
      body: { endpoint: 'auth/password', payload: { current: created.json.password, next: created.json.password } },
    })
    assert.equal(same.status, 400)
    const changed = await api(ctx.base, '/api/bot', {
      method: 'POST', cookie: firstCookie,
      body: { endpoint: 'auth/password', payload: { current: created.json.password, next: 'password-next-1' } },
    })
    assert.equal(changed.status, 200)
    assert.equal(changed.json.user.mustChangePassword, false)
    assert.equal(changed.json.user.used, 0)
    const old = await api(ctx.base, '/api/auth/login', { method: 'POST', body: { email: 'fresh@example.com', password: created.json.password } })
    assert.equal(old.status, 401)
    const state = await api(ctx.base, '/api/bot', { method: 'POST', cookie: firstCookie, body: { endpoint: 'state', payload: {} } })
    assert.equal(state.status, 200)

    const otherSession = await api(ctx.base, '/api/auth/login', { method: 'POST', body: { email: 'fresh@example.com', password: 'password-next-1' } })
    const otherCookie = cookieHeader(otherSession.setCookie)
    const again = await api(ctx.base, '/api/bot', {
      method: 'POST', cookie: firstCookie,
      body: { endpoint: 'auth/password', payload: { current: 'password-next-1', next: 'password-next-2' } },
    })
    assert.equal(again.status, 200)
    const kept = await api(ctx.base, '/api/auth/me', { cookie: firstCookie })
    assert.equal(kept.status, 200)
    assert.equal(kept.json.user.mustChangePassword, false)
    const dropped = await api(ctx.base, '/api/auth/me', { cookie: otherCookie })
    assert.equal(dropped.status, 401)

    const reset = await api(ctx.base, '/api/bot', {
      method: 'POST', cookie: adminCookie,
      body: { endpoint: 'admin/update', payload: { id: created.json.user.id, resetPassword: true } },
    })
    assert.equal(reset.status, 200)
    assert.equal(validInitial(reset.json.password), true)
    assert.equal(reset.json.password === 'password-next-2', false)
    assert.equal(reset.json.user.mustChangePassword, true)
    const afterReset = await readFile(path.join(ctx.dataDir, 'accounts.json'), 'utf8')
    assert.equal(afterReset.includes(reset.json.password), false)
    const stale = await api(ctx.base, '/api/auth/me', { cookie: firstCookie })
    assert.equal(stale.status, 401)
    const relogin = await api(ctx.base, '/api/auth/login', { method: 'POST', body: { email: 'fresh@example.com', password: reset.json.password } })
    assert.equal(relogin.json.user.mustChangePassword, true)
    const stillBlocked = await api(ctx.base, '/api/bot', {
      method: 'POST', cookie: cookieHeader(relogin.setCookie),
      body: { endpoint: 'state', payload: {} },
    })
    assert.equal(stillBlocked.status, 403)
    const listed = await api(ctx.base, '/api/admin/users', { cookie: adminCookie })
    assert.equal(listed.json.users.every(user => user.password === undefined), true)
    assert.equal(JSON.stringify(listed.json).includes(reset.json.password), false)
    assert.equal(listed.json.users.find(user => user.email === 'fresh@example.com').mustChangePassword, true)
  } finally {
    await ctx.close()
  }
})

function validInitial(password) {
  return typeof password === 'string' && password.length >= 8 && password.length <= 200 && !/[^A-Za-z0-9]/.test(password)
}

test('a hung kernel state still answers with the company roster', async () => {
  const fetchImpl = async (url, init = {}) => {
    const href = String(url)
    if (!href.includes('/api/bot')) return new Response('ok', { status: 200 })
    const body = JSON.parse(init.body ?? '{}')
    if (body.endpoint === 'state') {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 30_000)
        const abort = () => {
          clearTimeout(timer)
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        }
        if (init.signal?.aborted) abort()
        else init.signal?.addEventListener('abort', abort, { once: true })
      })
    }
    return Response.json({ ok: true, value: { unchanged: true } })
  }
  const ctx = await start({ BOTCAMP_ADMIN_EMAIL: ADMIN_EMAIL, BOTCAMP_ADMIN_PASSWORD: ADMIN_PASSWORD }, { fetchImpl })
  try {
    const login = await api(ctx.base, '/api/auth/login', { method: 'POST', body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
    const state = await api(ctx.base, '/api/bot', {
      method: 'POST',
      cookie: cookieHeader(login.setCookie),
      body: { endpoint: 'state', payload: { since: -1, models: '' } },
    })
    assert.equal(state.status, 200)
    assert.equal(state.json.ok, true)
    assert.equal(state.json.value.companyMode, 'company-local')
    assert.deepEqual(state.json.value.bots.map(bot => bot.name), ['主编', '写稿', '数据'])
    assert.equal(state.json.value.mainBotId, 'co_chief')
    assert.equal(state.json.value.bots.some(bot => bot.id === 'co_writer'), true)
    assert.equal(state.json.value.bots.some(bot => bot.id === 'co_ops'), true)
    assert.equal(state.json.value.defaultModel, 'qoder/deepseek-v4-flash')
    assert.ok(state.json.value.models.some(model => model.provider === 'qoder' && model.id === 'deepseek-v4-flash'))
    assert.equal(state.json.value.bots.every(bot => bot.model === 'qoder/deepseek-v4-flash'), true)
  } finally {
    await ctx.close()
  }
})

test('company send stores a model reply and keeps the relay bot off the roster', async () => {
  const chats = new Map()
  let relay = null
  const fetchImpl = async (url, init = {}) => {
    const href = String(url)
    if (!href.includes('/api/bot')) return new Response('ok', { status: 200 })
    const body = JSON.parse(init.body ?? '{}')
    if (body.endpoint === 'state') {
      return Response.json({
        ok: true,
        value: {
          revision: 4,
          bots: relay ? [relay] : [],
          rooms: [],
          models: [],
          defaultModel: null,
        },
      })
    }
    if (body.endpoint === 'create-bot') {
      assert.equal(body.payload?.name, 'botcamp-model')
      assert.equal(body.payload?.model, 'qoder/deepseek-v4-flash')
      relay = {
        id: 'relay-1',
        name: 'botcamp-model',
        sessionId: 'sess-relay',
        model: body.payload.model,
        brief: body.payload.brief,
      }
      chats.set(relay.sessionId, [{ kind: 'bot', text: '先打个招呼。', time: 1 }])
      return Response.json({ ok: true, value: relay })
    }
    if (body.endpoint === 'send') {
      const sessionId = body.payload?.sessionId
      const text = body.payload?.text
      const items = chats.get(sessionId) ?? []
      items.push({ kind: 'user', text, time: Date.now() })
      items.push({ kind: 'bot', text: '我是主编，用的是 qoder/deepseek-v4-flash。', time: Date.now() + 1 })
      chats.set(sessionId, items)
      return Response.json({ ok: true, value: true })
    }
    if (body.endpoint === 'chat') {
      const sessionId = body.payload?.sessionId
      return Response.json({ ok: true, value: { sessionId, items: chats.get(sessionId) ?? [], cursor: null } })
    }
    return Response.json({ ok: true, value: null })
  }
  const ctx = await start({ BOTCAMP_ADMIN_EMAIL: ADMIN_EMAIL, BOTCAMP_ADMIN_PASSWORD: ADMIN_PASSWORD }, { fetchImpl })
  try {
    const login = await api(ctx.base, '/api/auth/login', { method: 'POST', body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
    const cookie = cookieHeader(login.setCookie)
    const noted = await api(ctx.base, '/api/bot', {
      method: 'POST',
      cookie,
      body: { endpoint: 'send', payload: { botId: 'co_chief', text: '记下来：只改标题' } },
    })
    assert.equal(noted.status, 200)
    assert.equal(noted.json.ok, true)
    assert.equal(relay?.model, 'qoder/deepseek-v4-flash')
    const notedPage = await api(ctx.base, '/api/bot', {
      method: 'POST',
      cookie,
      body: { endpoint: 'chat', payload: { botId: 'co_chief' } },
    })
    const notedLast = notedPage.json.value.items.at(-1)
    assert.equal(notedLast.kind, 'bot')
    assert.match(notedLast.text, /qoder\/deepseek-v4-flash/)
    assert.doesNotMatch(notedLast.text, /doc:\/\//)
    assert.equal(notedPage.json.value.items.some(item => item.kind === 'user' && item.text === '记下来：只改标题'), true)
    const prompt = '用一句话介绍你自己'
    const sent = await api(ctx.base, '/api/bot', {
      method: 'POST',
      cookie,
      body: { endpoint: 'send', payload: { botId: 'co_chief', text: prompt } },
    })
    assert.equal(sent.status, 200)
    assert.equal(sent.json.ok, true)
    const page = await api(ctx.base, '/api/bot', {
      method: 'POST',
      cookie,
      body: { endpoint: 'chat', payload: { botId: 'co_chief' } },
    })
    const user = page.json.value.items.find(item => item.kind === 'user' && item.text === prompt)
    const last = page.json.value.items.at(-1)
    assert.ok(user)
    assert.equal(last.kind, 'bot')
    assert.match(last.text, /qoder\/deepseek-v4-flash/)
    assert.doesNotMatch(last.text, /收到。写稿和数据都在侧栏/)
    const state = await api(ctx.base, '/api/bot', {
      method: 'POST',
      cookie,
      body: { endpoint: 'state', payload: { since: -1, models: '' } },
    })
    assert.equal(state.json.value.companyMode, 'company-local')
    assert.deepEqual(state.json.value.bots.map(bot => bot.name), ['主编', '写稿', '数据'])
    assert.equal(state.json.value.bots.some(bot => bot.name === 'botcamp-model'), false)
    assert.equal(state.json.value.defaultModel, 'qoder/deepseek-v4-flash')
  } finally {
    await ctx.close()
  }
})

test('company reply stays visible when the next read has an empty local disk', async () => {
  const chats = new Map()
  let relay = null
  const fetchImpl = async (url, init = {}) => {
    const href = String(url)
    if (!href.includes('/api/bot')) return new Response('ok', { status: 200 })
    const body = JSON.parse(init.body ?? '{}')
    if (body.endpoint === 'state') {
      return Response.json({
        ok: true,
        value: { revision: 4, bots: relay ? [relay] : [], rooms: [], models: [], defaultModel: null },
      })
    }
    if (body.endpoint === 'create-bot') {
      relay = {
        id: 'relay-1',
        name: 'botcamp-model',
        sessionId: 'sess-relay',
        model: body.payload?.model,
        brief: body.payload?.brief,
      }
      chats.set(relay.sessionId, [{ kind: 'bot', text: '先打个招呼。', time: 1 }])
      return Response.json({ ok: true, value: relay })
    }
    if (body.endpoint === 'send') {
      const sessionId = body.payload?.sessionId
      const text = body.payload?.text
      const items = chats.get(sessionId) ?? []
      items.push({ kind: 'user', text, time: Date.now() })
      items.push({ kind: 'bot', text: '第二台还能看见 qoder/deepseek-v4-flash。', time: Date.now() + 1 })
      chats.set(sessionId, items)
      return Response.json({ ok: true, value: true })
    }
    if (body.endpoint === 'chat') {
      const sessionId = body.payload?.sessionId
      return Response.json({ ok: true, value: { sessionId, items: chats.get(sessionId) ?? [], cursor: null } })
    }
    return Response.json({ ok: true, value: null })
  }
  const ledger = createMemoryLedger()
  const ctx = await start({ BOTCAMP_ADMIN_EMAIL: ADMIN_EMAIL, BOTCAMP_ADMIN_PASSWORD: ADMIN_PASSWORD }, { fetchImpl, ledger })
  const otherDir = await mkdtemp(path.join(tmpdir(), 'botcamp-co-other-'))
  const prevRoot = getDataRoot()
  let otherServer
  try {
    const other = await createBotcamp({ ...ctx.options, dataDir: otherDir })
    otherServer = createServer((req, res) => {
      other.handle(req, res, () => {
        res.statusCode = 404
        res.end()
      }).catch(() => {
        if (!res.writableEnded) {
          res.statusCode = 500
          res.end()
        }
      })
    })
    await new Promise(resolve => otherServer.listen(0, '127.0.0.1', resolve))
    const otherBase = `http://127.0.0.1:${otherServer.address().port}`
    configureDataRoot(path.join(ctx.dataDir, 'media-store'))
    const login = await api(ctx.base, '/api/auth/login', { method: 'POST', body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
    const cookie = cookieHeader(login.setCookie)
    const prompt = '请回答第二台'
    const sent = await api(ctx.base, '/api/bot', {
      method: 'POST',
      cookie,
      body: { endpoint: 'send', payload: { botId: 'co_chief', text: prompt } },
    })
    assert.equal(sent.status, 200)
    assert.equal(sent.json.ok, true)
    configureDataRoot(path.join(otherDir, 'empty-chat'))
    const page = await api(otherBase, '/api/bot', {
      method: 'POST',
      cookie,
      body: { endpoint: 'chat', payload: { botId: 'co_chief' } },
    })
    assert.equal(page.status, 200, JSON.stringify(page.json))
    assert.equal(page.json.ok, true)
    const user = page.json.value.items.find(item => item.kind === 'user' && item.text === prompt)
    const last = page.json.value.items.at(-1)
    assert.ok(user)
    assert.equal(last.kind, 'bot')
    assert.match(last.text, /第二台还能看见/)
    assert.match(last.text, /qoder\/deepseek-v4-flash/)
  } finally {
    configureDataRoot(prevRoot)
    if (otherServer) await new Promise(resolve => otherServer.close(resolve))
    await rm(otherDir, { recursive: true, force: true })
    await ctx.close()
  }
})

test('a progress document opens from the link on a fresh disk', async () => {
  const fetchImpl = async () => new Response('ok', { status: 200 })
  const ledger = createMemoryLedger()
  const ctx = await start({ BOTCAMP_ADMIN_EMAIL: ADMIN_EMAIL, BOTCAMP_ADMIN_PASSWORD: ADMIN_PASSWORD }, { fetchImpl, ledger })
  const otherDir = await mkdtemp(path.join(tmpdir(), 'botcamp-doc-other-'))
  const prevRoot = getDataRoot()
  let otherServer
  try {
    const other = await createBotcamp({ ...ctx.options, dataDir: otherDir })
    otherServer = createServer((req, res) => {
      other.handle(req, res, () => {
        res.statusCode = 404
        res.end()
      }).catch(() => {
        if (!res.writableEnded) {
          res.statusCode = 500
          res.end()
        }
      })
    })
    await new Promise(resolve => otherServer.listen(0, '127.0.0.1', resolve))
    const otherBase = `http://127.0.0.1:${otherServer.address().port}`
    configureDataRoot(path.join(ctx.dataDir, 'media-store'))
    const login = await api(ctx.base, '/api/auth/login', { method: 'POST', body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
    const cookie = cookieHeader(login.setCookie)
    const sent = await api(ctx.base, '/api/bot', {
      method: 'POST',
      cookie,
      body: { endpoint: 'library/create', payload: { kind: 'file', name: '进度备忘', content: '小稿进度备忘\n' } },
    })
    assert.equal(sent.status, 200)
    assert.equal(sent.json.ok, true)
    const id = sent.json.node?.id
    assert.match(id, /^doc_[a-f0-9]+$/)
    configureDataRoot(path.join(otherDir, 'empty-library'))
    const opened = await api(otherBase, '/api/bot', {
      method: 'POST',
      cookie,
      body: { endpoint: 'library/get', payload: { id } },
    })
    assert.equal(opened.status, 200, JSON.stringify(opened.json))
    assert.equal(opened.json.ok, true)
    assert.equal(opened.json.node.id, id)
    assert.equal(opened.json.node.kind, 'file')
    assert.match(opened.json.node.content, /进度|自媒体号/)
  } finally {
    configureDataRoot(prevRoot)
    if (otherServer) await new Promise(resolve => otherServer.close(resolve))
    await rm(otherDir, { recursive: true, force: true })
    await ctx.close()
  }
})

test('workspace list returns host items with company sessions and does not wait on sync', async () => {
  let releaseSync
  const syncGate = new Promise((resolve) => { releaseSync = resolve })
  let blockSync = false
  const fetchImpl = async () => new Response('ok', { status: 200 })
  const ledger = createMemoryLedger()
  const original = ledger.saveFiles.bind(ledger)
  ledger.saveFiles = async (...args) => {
    if (blockSync) await syncGate
    return original(...args)
  }
  const ctx = await start({ BOTCAMP_ADMIN_EMAIL: ADMIN_EMAIL, BOTCAMP_ADMIN_PASSWORD: ADMIN_PASSWORD }, { fetchImpl, ledger })
  try {
    const login = await api(ctx.base, '/api/auth/login', { method: 'POST', body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
    blockSync = true
    const started = Date.now()
    const listed = await Promise.race([
      api(ctx.base, '/api/bot', {
        method: 'POST',
        cookie: cookieHeader(login.setCookie),
        body: { endpoint: 'workspace-list', payload: {} },
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('workspace-list blocked on sync')), 800)),
    ])
    const elapsed = Date.now() - started
    assert.equal(listed.status, 200)
    assert.equal(listed.json.ok, true)
    assert.ok(elapsed < 800, `workspace-list waited ${elapsed}ms`)
    const item = listed.json.value.items[0]
    assert.equal(item.workspaceId, item.id)
    assert.ok(item.sessionIds.includes('co_chief'))
    assert.ok(item.sessionIds.includes('co_writer'))
    assert.ok(item.sessionIds.includes('co_ops'))
    assert.equal(item.sessionIds.includes('co_room_mac_01JHEYBOXXIAOGUAO0001'), false)
    assert.deepEqual(listed.json.value.workspaces[0].sessionIds, item.sessionIds)
  } finally {
    releaseSync()
    await ctx.close()
  }
})

test('unowned kernel bots fall back to the company roster after filterState', async () => {
  const fetchImpl = async (url, init = {}) => {
    const href = String(url)
    if (!href.includes('/api/bot')) return new Response('ok', { status: 200 })
    const body = JSON.parse(init.body ?? '{}')
    if (body.endpoint === 'state') {
      return Response.json({
        ok: true,
        value: {
          revision: 9,
          modelsKey: 'foreign-models',
          bots: [{ id: 'foreign-bot', name: '外人', sessionId: 'foreign-sess' }],
          rooms: [{ id: 'foreign-room', name: '外群' }],
        },
      })
    }
    if (body.endpoint === 'create-bot') {
      return Response.json({ ok: true, value: { id: `bot-${body.payload?.name}`, name: body.payload?.name, sessionId: `sess-${body.payload?.name}` } })
    }
    return Response.json({ ok: true, value: null })
  }
  const ctx = await start({ BOTCAMP_ADMIN_EMAIL: ADMIN_EMAIL, BOTCAMP_ADMIN_PASSWORD: ADMIN_PASSWORD }, { fetchImpl })
  try {
    const login = await api(ctx.base, '/api/auth/login', { method: 'POST', body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
    const state = await api(ctx.base, '/api/bot', {
      method: 'POST',
      cookie: cookieHeader(login.setCookie),
      body: { endpoint: 'state', payload: {} },
    })
    assert.equal(state.status, 200)
    assert.equal(state.json.ok, true)
    assert.equal(state.json.value.companyMode, 'company-local')
    assert.deepEqual(state.json.value.bots.map(bot => bot.name), ['主编', '写稿', '数据'])
    assert.equal(state.json.value.mainBotId, 'co_chief')
    assert.equal(state.json.value.bots.some(bot => bot.id === 'foreign-bot'), false)
  } finally {
    await ctx.close()
  }
})

test('state gets a kernel cookie from the exchange header and does not show it', async () => {
  const seen = []
  const fetchImpl = async (url, init = {}) => {
    const href = String(url)
    const headers = init.headers ?? {}
    seen.push({ href, exchange: headers['x-botcamp-exchange'] ?? '' })
    if (!href.includes('/api/')) {
      if (headers['x-botcamp-exchange'] !== 'exchange-secret') {
        return new Response('API-only', { status: 404, headers: { 'content-type': 'text/plain' } })
      }
      if (String(headers.cookie ?? '').includes('dsh-auth-test=')) return new Response('ok', { status: 200 })
      return new Response('', {
        status: 303,
        headers: { location: './', 'set-cookie': 'dsh-auth-test=kernel-cookie; HttpOnly; Path=/' },
      })
    }
    if (headers['x-botcamp-exchange']) return new Response('exchange header leaked', { status: 500 })
    if (!String(headers.cookie ?? '').includes('dsh-auth-test=kernel-cookie')) {
      return new Response('unauthorized', { status: 401, headers: { 'content-type': 'text/plain; charset=utf-8' } })
    }
    return Response.json({ ok: true, value: { revision: 1, bots: [], rooms: [] } })
  }
  const ctx = await start({
    BOTCAMP_ADMIN_EMAIL: ADMIN_EMAIL,
    BOTCAMP_ADMIN_PASSWORD: ADMIN_PASSWORD,
    BOTCAMP_KERNEL_EXCHANGE: 'exchange-secret',
  }, { fetchImpl })
  try {
    const login = await api(ctx.base, '/api/auth/login', {
      method: 'POST',
      body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    })
    assert.equal(login.status, 200)
    const cookie = cookieHeader(login.setCookie)
    const state = await api(ctx.base, '/api/bot', {
      method: 'POST',
      cookie,
      body: { endpoint: 'state', payload: {} },
    })
    assert.equal(state.status, 200)
    assert.equal(state.json.ok, true)
    assert.equal(state.text.includes('kernel-cookie'), false)
    assert.equal(state.text.includes('exchange-secret'), false)
    assert.equal(login.text.includes('kernel-cookie'), false)
    assert.equal(seen.some(call => call.href === 'http://kernel.test/' && call.exchange === 'exchange-secret'), true)
    assert.equal(seen.some(call => call.href.endsWith('/api/bot') && call.exchange !== ''), false)
  } finally {
    await ctx.close()
  }
})

test('a client keeps a bearer session across the first password change', async () => {
  const ctx = await start({ BOTCAMP_ADMIN_EMAIL: ADMIN_EMAIL, BOTCAMP_ADMIN_PASSWORD: ADMIN_PASSWORD })
  const clientHeaders = { 'x-botcamp-client': '1' }
  try {
    const website = await api(ctx.base, '/api/bot', {
      method: 'POST',
      body: { endpoint: 'auth/login', payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } },
    })
    assert.equal(website.status, 200)
    assert.equal(Object.hasOwn(website.json, 'token'), false)
    assert.equal(website.allowOrigin, '*')

    const created = await api(ctx.base, '/api/bot', {
      method: 'POST',
      cookie: cookieHeader(website.setCookie),
      body: { endpoint: 'admin/create', payload: { email: 'client@example.com', quota: 0 } },
    })
    assert.equal(created.status, 201)
    const initial = created.json.password
    const login = await api(ctx.base, '/api/bot', {
      method: 'POST',
      headers: clientHeaders,
      body: { endpoint: 'auth/login', payload: { email: 'client@example.com', password: initial } },
    })
    assert.equal(login.status, 200)
    assert.equal(typeof login.json.token, 'string')
    assert.equal(login.json.token.length >= 20, true)
    assert.equal(login.json.user.mustChangePassword, true)
    const bearer = { authorization: `Bearer ${login.json.token}` }

    const blocked = await api(ctx.base, '/api/bot', {
      method: 'POST',
      headers: bearer,
      body: { endpoint: 'state', payload: {} },
    })
    assert.equal(blocked.status, 403)
    assert.equal(blocked.json.error.code, 'auth/password')
    assert.equal(ctx.calls.some(call => String(call.body ?? '').includes('"state"')), false)

    const changed = await api(ctx.base, '/api/bot', {
      method: 'POST',
      headers: bearer,
      body: { endpoint: 'auth/password', payload: { current: initial, next: 'client-password-1' } },
    })
    assert.equal(changed.status, 200)
    assert.equal(changed.json.user.mustChangePassword, false)

    const me = await api(ctx.base, '/api/bot', {
      method: 'POST',
      headers: bearer,
      body: { endpoint: 'auth/me' },
    })
    assert.equal(me.status, 200)
    assert.equal(me.json.user.email, 'client@example.com')
    assert.equal(me.json.user.mustChangePassword, false)

    const state = await api(ctx.base, '/api/bot', {
      method: 'POST',
      headers: bearer,
      body: { endpoint: 'state', payload: {} },
    })
    assert.equal(state.status, 200)
    const forwarded = ctx.calls.find(call => String(call.body ?? '').includes('"state"'))
    assert.equal(String(forwarded?.headers.cookie ?? '').includes('botcamp_session='), true)
    assert.equal(String(forwarded?.headers.cookie ?? '').includes(login.json.token), true)

    const preflight = await api(ctx.base, '/api/bot', { method: 'OPTIONS' })
    assert.equal(preflight.status, 204)
    assert.equal(preflight.allowOrigin, '*')
    assert.match(preflight.allowHeaders, /authorization/)
    assert.match(preflight.allowHeaders, /x-botcamp-client/)

    await api(ctx.base, '/api/bot', {
      method: 'POST',
      headers: bearer,
      body: { endpoint: 'auth/logout' },
    })
    const after = await api(ctx.base, '/api/bot', {
      method: 'POST',
      headers: bearer,
      body: { endpoint: 'auth/me' },
    })
    assert.equal(after.status, 401)
  } finally {
    await ctx.close()
  }
})

test('media CONTROL serves workbench auth, workspace, and owner isolation', async () => {
  const ctx = await start({ BOTCAMP_ADMIN_EMAIL: ADMIN_EMAIL, BOTCAMP_ADMIN_PASSWORD: ADMIN_PASSWORD })
  try {
    const users = await api(ctx.base, '/api/bot', {
      method: 'POST',
      body: { endpoint: 'media/demo-users', payload: null },
    })
    assert.equal(users.status, 200)
    assert.equal(users.json.ok, true)
    assert.equal(users.json.users.some(u => u.username === 'phosa'), true)

    const denied = await api(ctx.base, '/api/bot', {
      method: 'POST',
      body: { endpoint: 'media/workspace', payload: null },
    })
    assert.equal(denied.status, 401)

    const loginA = await api(ctx.base, '/api/bot', {
      method: 'POST',
      body: { endpoint: 'media/login', payload: { username: 'phosa' } },
    })
    assert.equal(loginA.status, 200)
    assert.equal(loginA.json.ok, true)
    assert.equal(typeof loginA.json.token, 'string')
    assert.match(String(loginA.setCookie?.[0] || ''), /botcamp_media_session=/)

    const wsA = await api(ctx.base, '/api/bot', {
      method: 'POST',
      headers: { authorization: `Bearer ${loginA.json.token}` },
      body: { endpoint: 'media/workspace', payload: null },
    })
    assert.equal(wsA.status, 200)
    assert.equal(wsA.json.workspace.account.display_name, '小稿的AI日记')
    assert.equal(wsA.json.workspace.account.platform, 'xiaoheihe')
    assert.equal(wsA.json.workspace.posts.length > 0, true)

    const loginB = await api(ctx.base, '/api/bot', {
      method: 'POST',
      body: { endpoint: 'media/login', payload: { username: 'other_creator' } },
    })
    assert.equal(loginB.status, 200)
    const wsB = await api(ctx.base, '/api/bot', {
      method: 'POST',
      headers: { authorization: `Bearer ${loginB.json.token}` },
      body: { endpoint: 'media/workspace', payload: null },
    })
    assert.equal(wsB.status, 200)
    assert.equal(wsB.json.workspace.account.display_name, '别家效率号')
    assert.equal(
      wsB.json.workspace.posts.some(p => p.title === wsA.json.workspace.posts[0]?.title),
      false,
    )

    const cross = await api(ctx.base, '/api/bot', {
      method: 'POST',
      headers: { authorization: `Bearer ${loginB.json.token}` },
      body: {
        endpoint: 'media/manuscript',
        payload: {
          accountId: wsA.json.workspace.account.id,
          manuscriptId: wsA.json.workspace.manuscripts[0]?.id,
        },
      },
    })
    assert.equal(cross.status, 403)

    const accounts = await api(ctx.base, '/api/bot', {
      method: 'POST',
      headers: { authorization: `Bearer ${loginA.json.token}` },
      body: { endpoint: 'media/accounts', payload: null },
    })
    assert.equal(accounts.status, 200)
    assert.equal(accounts.json.accounts.some(a => a.id === wsA.json.workspace.account.id), true)

    const created = await api(ctx.base, '/api/bot', {
      method: 'POST',
      headers: { authorization: `Bearer ${loginA.json.token}` },
      body: { endpoint: 'media/create-account', payload: { display_name: '测试新号' } },
    })
    assert.equal(created.status, 200)
    assert.equal(created.json.workspace.account.display_name, '测试新号')

    const focused = await api(ctx.base, '/api/bot', {
      method: 'POST',
      headers: { authorization: `Bearer ${loginA.json.token}` },
      body: { endpoint: 'media/focus', payload: { accountId: wsA.json.workspace.account.id } },
    })
    assert.equal(focused.status, 200)
    assert.equal(focused.json.workspace.account.id, wsA.json.workspace.account.id)

    const postId = wsA.json.workspace.posts[0]?.id
    const noted = await api(ctx.base, '/api/bot', {
      method: 'POST',
      headers: { authorization: `Bearer ${loginA.json.token}` },
      body: {
        endpoint: 'media/note',
        payload: {
          accountId: wsA.json.workspace.account.id,
          kind: 'post',
          entityId: postId,
          title: wsA.json.workspace.posts[0]?.title,
          text: '主编写回测试',
        },
      },
    })
    assert.equal(noted.status, 200)
    const updated = noted.json.workspace.posts.find(p => p.id === postId)
    assert.match(String(updated?.remark || ''), /主编写回测试/)
    assert.equal(noted.json.workspace.platform_events.some(e => e.event_type === 'chat_writeback'), true)

    const stolen = await api(ctx.base, '/api/bot', {
      method: 'POST',
      headers: { authorization: `Bearer ${loginB.json.token}` },
      body: {
        endpoint: 'media/note',
        payload: {
          accountId: wsA.json.workspace.account.id,
          kind: 'event',
          text: '不应写入',
        },
      },
    })
    assert.equal(stolen.status, 403)
  } finally {
    await ctx.close()
  }
})
