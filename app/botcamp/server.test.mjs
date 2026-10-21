import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createBotcamp } from './http.mjs'

const ADMIN_EMAIL = 'admin@example.com'
const ADMIN_PASSWORD = 'admin-password-1'

function kernelFactory() {
  const bots = []
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
      const slot = bots.length === 0 ? 'a' : 'b'
      const bot = { id: `bot-${slot}`, name: body.payload?.name ?? slot, sessionId: `sess-${slot}`, parts: [] }
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
          secrets: [{ name: 'kernel-secret' }],
          questions: { 'sess-b': { q: 'hidden-question' } },
          work: { bots: { 'bot-b': { tool: 'foreign' } }, approvals: [] },
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

async function start(env = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'botcamp-'))
  const calls = []
  const kernel = kernelFactory()
  const fetchImpl = async (url, init = {}) => {
    calls.push({ href: String(url), method: init.method ?? 'GET', headers: { ...(init.headers ?? {}) }, body: init.body })
    return kernel(String(url), init)
  }
  const options = {
    dataDir,
    kernelOrigin: 'http://kernel.test',
    fetchImpl,
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

async function api(base, pathname, { method = 'GET', body, cookie } = {}) {
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
  return { status: response.status, json, text, setCookie }
}

function cookieHeader(setCookie) {
  return setCookie[0]?.split(';', 1)[0] ?? ''
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
    const namespaces = botCalls(ctx.calls, 'create-bot').map(call => call.headers['x-botcamp-namespace'])
    assert.equal(namespaces.length, 2)
    assert.notEqual(namespaces[0], namespaces[1])
    assert.match(namespaces[0], /^u_/)

    const stateA = await api(ctx.base, '/api/bot', { method: 'POST', cookie: cookieA, body: { endpoint: 'state', payload: { since: -1, models: '' } } })
    const stateB = await api(ctx.base, '/api/bot', { method: 'POST', cookie: cookieB, body: { endpoint: 'state', payload: { since: -1, models: '' } } })
    assert.deepEqual(stateA.json.value.bots.map(bot => bot.id), ['bot-a'])
    assert.deepEqual(stateB.json.value.bots.map(bot => bot.id), ['bot-b'])
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
    assert.match(blockedKey.json.error.message, /不能按账号修改/)
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
    const zeroLogin = await api(ctx.base, '/api/bot', { method: 'POST', body: { endpoint: 'auth/login', payload: { email: 'zero@example.com', password: 'password-zero' } } })
    const zeroCookie = cookieHeader(zeroLogin.setCookie)
    const other = await api(ctx.base, '/api/bot', {
      method: 'POST', cookie: adminCookie,
      body: { endpoint: 'admin/create', payload: { email: 'other@example.com', password: 'password-other', quota: 1 } },
    })
    assert.equal(other.status, 201)
    const otherLogin = await api(ctx.base, '/api/bot', { method: 'POST', body: { endpoint: 'auth/login', payload: { email: 'other@example.com', password: 'password-other' } } })
    const otherCookie = cookieHeader(otherLogin.setCookie)

    const botOther = await api(ctx.base, '/api/bot', { method: 'POST', cookie: otherCookie, body: { endpoint: 'create-bot', payload: { name: '乙' } } })
    assert.equal(botOther.json.value.id, 'bot-a')
    const denied = await api(ctx.base, '/api/bot', { method: 'POST', cookie: zeroCookie, body: { endpoint: 'chat', payload: { botId: 'bot-a' } } })
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
