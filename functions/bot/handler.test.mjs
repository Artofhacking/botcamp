import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createBotcamp } from '../../app/botcamp/http.mjs'
import { handleDemoxRequest, handler, resetDemoxCamp } from './entry.mjs'

const require = createRequire(import.meta.url)
const SECRET = 'super-secret-cookie-value'
const TOKEN = 'launch-token-secret'
const ADMIN_EMAIL = 'admin@example.com'
const ADMIN_PASSWORD = 'admin-password-1'

function kernelFactory() {
  const bots = []
  return async function kernel(href, init = {}) {
    const url = String(href)
    if (!url.includes('/api/')) {
      return new Response(null, {
        status: 303,
        headers: {
          location: `./?token=${TOKEN}`,
          'set-cookie': `dsh-auth-test=${SECRET}; Path=/; HttpOnly`,
        },
      })
    }
    if (url.endsWith('/api/bot/feed')) {
      const encoder = new TextEncoder()
      let release
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(`event: hello\ndata: {"revision":1}\n\n`))
        },
        pull() {
          return new Promise((resolve) => { release = resolve })
        },
        cancel() { release?.() },
      })
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'set-cookie': `dsh-auth-test=${SECRET}; HttpOnly` },
      })
    }
    const body = JSON.parse(init.body ?? '{}')
    if (body.endpoint === 'create-bot') {
      const slot = bots.length === 0 ? 'a' : 'b'
      const bot = { id: `bot-${slot}`, name: body.payload?.name ?? slot, sessionId: `sess-${slot}` }
      bots.push(bot)
      return Response.json({ ok: true, value: bot }, { headers: { 'set-cookie': `dsh-auth-test=${SECRET}; HttpOnly` } })
    }
    if (body.endpoint === 'state') {
      return Response.json({
        ok: true,
        value: { revision: 1, modelsKey: 'm', bots, rooms: [], prefs: {}, secrets: [{ name: SECRET }], questions: {}, work: { bots: {}, approvals: [] } },
      })
    }
    if (body.endpoint === 'chat') {
      return Response.json({ ok: true, value: { sessionId: 'sess-b', items: [{ kind: 'user', text: SECRET, time: 1 }] } })
    }
    if (body.endpoint === 'send') return Response.json({ ok: true, value: { sent: true } })
    return Response.json({ ok: true, value: null })
  }
}

async function openCamp() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'botcamp-fn-'))
  const calls = []
  const kernel = kernelFactory()
  const fetchImpl = async (url, init = {}) => {
    calls.push({ href: String(url), method: init.method ?? 'GET', headers: { ...(init.headers ?? {}) }, body: init.body })
    return kernel(String(url), init)
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
  return {
    camp,
    calls,
    close: () => rm(dataDir, { recursive: true, force: true }),
  }
}

function cookieOf(result) {
  return result.headers['set-cookie']?.split(';', 1)[0] ?? ''
}

function botCalls(calls, endpoint) {
  return calls.filter((call) => {
    if (!call.href.endsWith('/api/bot')) return false
    try { return JSON.parse(call.body ?? '{}').endpoint === endpoint } catch { return false }
  })
}

async function post(camp, endpoint, payload, cookie) {
  return handleDemoxRequest({
    method: 'POST',
    path: '/api/bot',
    headers: cookie ? { cookie } : {},
    body: JSON.stringify({ endpoint, payload: payload ?? null }),
  }, {}, { camp })
}

test('a missing session is rejected before the kernel, including the built handler', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botcamp-built-'))
  const built = require('./index.js')
  const original = globalThis.fetch
  let called = false
  globalThis.fetch = async () => {
    called = true
    throw new Error('kernel should not be called')
  }
  const savedEmail = process.env.BOTCAMP_ADMIN_EMAIL
  const savedPassword = process.env.BOTCAMP_ADMIN_PASSWORD
  delete process.env.BOTCAMP_ADMIN_EMAIL
  delete process.env.BOTCAMP_ADMIN_PASSWORD
  resetDemoxCamp()
  built.resetDemoxCamp()
  try {
    const env = { BOTCAMP_DATA_DIR: dir }
    const entryHit = await handler({ method: 'POST', path: '/api/bot', body: '{"endpoint":"state","payload":{}}' }, env)
    assert.equal(entryHit.statusCode, 401)
    assert.match(entryHit.body, /请先登录/)
    const builtHit = await built.handler({ method: 'GET', path: '/api/bot' }, { BOTCAMP_DATA_DIR: `${dir}-built` })
    assert.equal(builtHit.statusCode, 401)
    assert.match(builtHit.body, /请先登录/)
    const devLogin = await built.handler({
      method: 'POST',
      path: '/api/bot',
      body: JSON.stringify({ endpoint: 'botcamp/login', payload: { email: 'admin@localhost', password: 'botcamp-dev' } }),
    }, { BOTCAMP_DATA_DIR: `${dir}-built` })
    assert.equal(devLogin.statusCode, 401)
    assert.equal(called, false)
    assert.equal(JSON.stringify(entryHit).includes(SECRET), false)
  } finally {
    globalThis.fetch = original
    if (savedEmail === undefined) delete process.env.BOTCAMP_ADMIN_EMAIL
    else process.env.BOTCAMP_ADMIN_EMAIL = savedEmail
    if (savedPassword === undefined) delete process.env.BOTCAMP_ADMIN_PASSWORD
    else process.env.BOTCAMP_ADMIN_PASSWORD = savedPassword
    resetDemoxCamp()
    built.resetDemoxCamp()
    await rm(dir, { recursive: true, force: true })
    await rm(`${dir}-built`, { recursive: true, force: true })
  }
})

test('vite and the demox function share a session, and user A cannot spend user B', { timeout: 20000 }, async () => {
  const ctx = await openCamp()
  const logs = []
  const original = console.error
  console.error = (...args) => { logs.push(args.map(String).join(' ')) }
  try {
    const server = createServer((req, res) => {
      ctx.camp.handle(req, res, () => {
        res.statusCode = 404
        res.end()
      }).catch(() => {
        if (!res.writableEnded) res.end()
      })
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${server.address().port}`
    try {
      const direct = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
      })
      const session = direct.headers.getSetCookie()[0].split(';', 1)[0]
      const before = ctx.calls.length
      const anonymous = await handleDemoxRequest({
        method: 'POST',
        path: '/api/bot',
        body: JSON.stringify({ endpoint: 'state', payload: {} }),
      }, {}, { camp: ctx.camp })
      assert.equal(anonymous.statusCode, 401)
      assert.equal(ctx.calls.length, before)

      const asAdmin = await handleDemoxRequest({
        method: 'POST',
        path: '/api/bot',
        headers: { cookie: session },
        body: JSON.stringify({ endpoint: 'state', payload: {} }),
      }, {}, { camp: ctx.camp })
      assert.equal(asAdmin.statusCode, 200)
      assert.equal(JSON.parse(asAdmin.body).ok, true)
      assert.equal(JSON.stringify(asAdmin).includes(SECRET), false)
      assert.equal(JSON.stringify(asAdmin).includes(TOKEN), false)
      assert.equal(asAdmin.headers['set-cookie'], undefined)

      const createdA = await post(ctx.camp, 'botcamp/admin-create', { email: 'a@example.com', password: 'password-user-a', quota: 1 }, session)
      const createdB = await post(ctx.camp, 'botcamp/admin-create', { email: 'b@example.com', password: 'password-user-b', quota: 5 }, session)
      assert.equal(createdA.statusCode, 201)
      const loginA = await post(ctx.camp, 'botcamp/login', { email: 'a@example.com', password: 'password-user-a' })
      const loginB = await post(ctx.camp, 'botcamp/login', { email: 'b@example.com', password: 'password-user-b' })
      const cookieA = cookieOf(loginA)
      const cookieB = cookieOf(loginB)
      assert.match(cookieA, /^botcamp_session=/)
      assert.match(loginA.headers['set-cookie'], /HttpOnly/)
      assert.equal(loginA.body.includes(ADMIN_PASSWORD), false)

      const botA = await post(ctx.camp, 'create-bot', { name: '甲' }, cookieA)
      const botB = await post(ctx.camp, 'create-bot', { name: '乙' }, cookieB)
      assert.equal(JSON.parse(botA.body).value.id, 'bot-a')
      assert.equal(JSON.parse(botB.body).value.id, 'bot-b')
      const namespaces = botCalls(ctx.calls, 'create-bot').map(call => call.headers['x-botcamp-namespace'])
      assert.equal(namespaces.length, 2)
      assert.notEqual(namespaces[0], namespaces[1])
      assert.equal(botCalls(ctx.calls, 'create-bot').some(call => String(call.headers.cookie ?? '').includes('botcamp_session')), false)
      assert.equal(botCalls(ctx.calls, 'create-bot').every(call => String(call.headers.cookie ?? '').includes(SECRET)), true)

      const stolen = await post(ctx.camp, 'chat', { botId: 'bot-b' }, cookieA)
      assert.equal(JSON.parse(stolen.body).ok, false)
      assert.equal(stolen.body.includes(SECRET), false)
      assert.equal(botCalls(ctx.calls, 'chat').length, 0)

      const stateA = await post(ctx.camp, 'state', {}, cookieA)
      const stateB = await post(ctx.camp, 'state', {}, cookieB)
      assert.deepEqual(JSON.parse(stateA.body).value.bots.map(bot => bot.id), ['bot-a'])
      assert.deepEqual(JSON.parse(stateB.body).value.bots.map(bot => bot.id), ['bot-b'])
      assert.equal(stateA.body.includes(SECRET), false)

      const sent = await post(ctx.camp, 'send', { sessionId: 'sess-a', text: '一条' }, cookieA)
      assert.equal(JSON.parse(sent.body).ok, true)
      const blocked = await post(ctx.camp, 'send', { sessionId: 'sess-a', text: '第二条' }, cookieA)
      assert.equal(JSON.parse(blocked.body).ok, false)
      assert.match(JSON.parse(blocked.body).error.message, /配额已用完/)
      assert.equal(botCalls(ctx.calls, 'send').length, 1)
      const spentByB = await post(ctx.camp, 'send', { sessionId: 'sess-b', text: '乙的一条' }, cookieB)
      assert.equal(JSON.parse(spentByB.body).ok, true)

      const feed = await handleDemoxRequest({ method: 'GET', path: '/api/bot/feed', headers: { cookie: cookieA } }, {}, { camp: ctx.camp })
      assert.equal(feed.statusCode, 200)
      assert.match(feed.body, /event: hello/)
      assert.equal(feed.body.includes(SECRET), false)
      assert.equal(feed.headers['set-cookie'], undefined)
      const quiet = await handleDemoxRequest({ method: 'GET', path: '/api/bot/feed' }, {}, { camp: ctx.camp })
      assert.equal(quiet.statusCode, 401)
      assert.equal(logs.join('\n').includes(SECRET), false)
      assert.equal(logs.join('\n').includes(TOKEN), false)
      assert.equal(createdB.statusCode, 201)
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  } finally {
    console.error = original
    await ctx.close()
  }
})
