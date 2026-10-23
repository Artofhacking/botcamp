import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { handler } from './entry.mjs'

const require = createRequire(new URL('../../app/package.json', import.meta.url))
const esbuild = require('esbuild')
const entry = fileURLToPath(new URL('./entry.mjs', import.meta.url))
const SECRET = 'super-secret-cookie-value'
const TOKEN = 'launch-token-secret'
const ADMIN_EMAIL = 'admin@example.com'
const ADMIN_PASSWORD = 'admin-password-1'

async function settleHandler(env, fetchImpl, email, body, next) {
  const initial = JSON.parse(body).password
  const login = await handler({
    method: 'POST',
    path: '/api/bot',
    body: JSON.stringify({ endpoint: 'auth/login', payload: { email, password: initial } }),
  }, env, { fetchImpl })
  assert.equal(login.statusCode, 200, email)
  const cookie = login.headers['set-cookie'].split(';', 1)[0]
  const changed = await handler({
    method: 'POST',
    path: '/api/bot',
    headers: { cookie },
    body: JSON.stringify({ endpoint: 'auth/password', payload: { current: initial, next } }),
  }, env, { fetchImpl })
  assert.equal(changed.statusCode, 200, email)
  assert.equal(JSON.parse(changed.body).user.mustChangePassword, false)
}

function envFor(dataDir, extra = {}) {
  return {
    BOTCAMP_DATA_DIR: dataDir,
    BOTCAMP_ADMIN_EMAIL: '',
    BOTCAMP_ADMIN_PASSWORD: '',
    DSH_KERNEL_ORIGIN: 'http://kernel.test',
    ...extra,
  }
}

test('deployed handler rejects bot and feed before the kernel', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'botcamp-fn-'))
  let fetched = 0
  const fetchImpl = async () => {
    fetched += 1
    return new Response('no', { status: 500 })
  }
  try {
    const post = await handler({
      method: 'POST',
      path: '/api/bot',
      body: JSON.stringify({ endpoint: 'state', payload: {} }),
    }, envFor(dataDir), { fetchImpl })
    assert.equal(post.statusCode, 401)
    assert.match(post.body, /请先登录/)
    const feed = await handler({ method: 'GET', path: '/api/bot/feed' }, envFor(dataDir), { fetchImpl })
    assert.equal(feed.statusCode, 401)
    assert.equal(fetched, 0)
    const dev = await handler({
      method: 'POST',
      path: '/api/bot',
      body: JSON.stringify({ endpoint: 'auth/login', payload: { email: 'admin@localhost', password: 'botcamp-dev' } }),
    }, envFor(dataDir), { fetchImpl })
    assert.equal(dev.statusCode, 401)
    assert.equal(dev.body.includes('botcamp-dev'), false)
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('deployed handler logs in, isolates, blocks a zero quota, and hides the kernel cookie', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'botcamp-fn-'))
  const calls = []
  const bots = []
  let createdBots = 0
  const fetchImpl = async (url, init = {}) => {
    calls.push({
      href: String(url),
      body: init.body,
      origin: init.headers?.origin,
      cookie: init.headers?.cookie,
      namespace: init.headers?.['x-botcamp-namespace'],
    })
    const href = String(url)
    if (!href.includes('/api/bot')) {
      return new Response('', { status: 303, headers: { location: `./?token=${TOKEN}`, 'set-cookie': `dsh-auth-test=${SECRET}; HttpOnly` } })
    }
    if (href.endsWith('/api/bot/feed')) {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('event: hello\ndata: {"ok":true}\n\n'))
        },
        cancel() {},
      })
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream', 'set-cookie': `dsh-auth-test=${SECRET}; HttpOnly` } })
    }
    const body = JSON.parse(init.body ?? '{}')
    if (body.endpoint === 'create-bot') {
      createdBots += 1
      const bot = { id: `bot-${createdBots}`, name: body.payload?.name ?? 'a', sessionId: `sess-${createdBots}` }
      bots.push(bot)
      return Response.json({ ok: true, value: bot })
    }
    if (body.endpoint === 'state') {
      return Response.json({ ok: true, value: { revision: 1, bots, rooms: [], prefs: {}, note: SECRET, launch: TOKEN } })
    }
    if (body.endpoint === 'send') return Response.json({ ok: true, value: { sent: true } })
    return Response.json({ ok: true, value: null })
  }
  const env = envFor(dataDir, { BOTCAMP_ADMIN_EMAIL: ADMIN_EMAIL, BOTCAMP_ADMIN_PASSWORD: ADMIN_PASSWORD })
  try {
    const login = await handler({
      method: 'POST',
      path: '/api/bot',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: 'auth/login', payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } }),
    }, env, { fetchImpl })
    assert.equal(login.statusCode, 200)
    assert.match(login.headers['set-cookie'], /botcamp_session=/)
    assert.match(login.headers['set-cookie'], /HttpOnly/i)
    assert.equal(login.headers['set-cookie'].includes(SECRET), false)
    assert.equal(login.body.includes(ADMIN_PASSWORD), false)
    const cookie = login.headers['set-cookie'].split(';', 1)[0]

    const created = await handler({
      method: 'POST',
      path: '/api/bot',
      headers: { cookie },
      body: JSON.stringify({ endpoint: 'admin/create', payload: { email: 'zero@example.com', password: 'password-zero', quota: 0 } }),
    }, env, { fetchImpl })
    assert.equal(created.statusCode, 201)
    assert.deepEqual(JSON.parse(created.body).team.created, ['主编', '写手', '运营'])
    assert.deepEqual(JSON.parse(created.body).team.failed, [])
    const other = await handler({
      method: 'POST',
      path: '/api/bot',
      headers: { cookie },
      body: JSON.stringify({ endpoint: 'admin/create', payload: { email: 'other@example.com', password: 'password-other', quota: 2 } }),
    }, env, { fetchImpl })
    assert.equal(other.statusCode, 201)
    const accounts = JSON.parse(await readFile(path.join(dataDir, 'accounts.json'), 'utf8'))
    const zeroUser = accounts.users.find(user => user.email === 'zero@example.com')
    const otherUser = accounts.users.find(user => user.email === 'other@example.com')
    const adminUser = accounts.users.find(user => user.email === ADMIN_EMAIL)
    const teamCalls = calls.filter(call => {
      try { return JSON.parse(call.body ?? '{}').endpoint === 'create-bot' } catch { return false }
    })
    assert.deepEqual(teamCalls.slice(0, 3).map(call => call.namespace), [zeroUser.kernelKey, zeroUser.kernelKey, zeroUser.kernelKey])
    assert.deepEqual(teamCalls.slice(3).map(call => call.namespace), [otherUser.kernelKey, otherUser.kernelKey, otherUser.kernelKey])
    assert.equal(teamCalls.some(call => call.namespace === adminUser.kernelKey), false)
    assert.equal(calls.some(call => String(call.body ?? '').includes('"create-room"') || String(call.body ?? '').includes('"set-main"') || String(call.body ?? '').includes('"send"')), false)
    await settleHandler(env, fetchImpl, 'zero@example.com', created.body, 'password-zero')
    await settleHandler(env, fetchImpl, 'other@example.com', other.body, 'password-other')

    const loginOther = await handler({
      method: 'POST',
      path: '/api/bot',
      body: JSON.stringify({ endpoint: 'auth/login', payload: { email: 'other@example.com', password: 'password-other' } }),
    }, env, { fetchImpl })
    const otherCookie = loginOther.headers['set-cookie'].split(';', 1)[0]
    const loginZero = await handler({
      method: 'POST',
      path: '/api/bot',
      body: JSON.stringify({ endpoint: 'auth/login', payload: { email: 'zero@example.com', password: 'password-zero' } }),
    }, env, { fetchImpl })
    const zeroCookie = loginZero.headers['set-cookie'].split(';', 1)[0]
    assert.equal(JSON.parse(loginZero.body).user.used, 0)

    const made = await handler({
      method: 'POST',
      path: '/api/bot',
      headers: { cookie: otherCookie },
      body: JSON.stringify({ endpoint: 'create-bot', payload: { name: '乙' } }),
    }, env, { fetchImpl })
    const madeBot = JSON.parse(made.body).value
    assert.equal(madeBot.name, '乙')
    assert.equal(made.body.includes(SECRET), false)
    assert.equal(made.body.includes(TOKEN), false)

    const seen = await handler({
      method: 'POST',
      path: '/api/bot',
      headers: { cookie: zeroCookie },
      body: JSON.stringify({ endpoint: 'state', payload: {} }),
    }, env, { fetchImpl })
    assert.deepEqual(JSON.parse(seen.body).value.bots.map(bot => bot.name), ['主编', '写手', '运营'])
    assert.equal(JSON.parse(seen.body).value.bots.some(bot => bot.id === madeBot.id), false)
    const blocked = await handler({
      method: 'POST',
      path: '/api/bot',
      headers: { cookie: zeroCookie },
      body: JSON.stringify({ endpoint: 'chat', payload: { botId: madeBot.id } }),
    }, env, { fetchImpl })
    assert.equal(JSON.parse(blocked.body).ok, false)
    assert.equal(calls.some(call => call.href.endsWith('/api/bot') && String(call.body).includes('"chat"')), false)

    const model = await handler({
      method: 'POST',
      path: '/api/bot',
      headers: { cookie: otherCookie },
      body: JSON.stringify({ endpoint: 'provider-add', payload: { provider: 'deepseek', key: 'sk-should-not-forward' } }),
    }, env, { fetchImpl })
    assert.equal(JSON.parse(model.body).ok, false)
    assert.match(model.body, /不能配置模型/)
    assert.equal(calls.some(call => String(call.body ?? '').includes('sk-should-not-forward')), false)

    const stopped = await handler({
      method: 'POST',
      path: '/api/bot',
      headers: { cookie: zeroCookie },
      body: JSON.stringify({ endpoint: 'send', payload: { text: '不会进内核' } }),
    }, env, { fetchImpl })
    assert.equal(JSON.parse(stopped.body).ok, false)
    assert.match(stopped.body, /配额已用完/)
    assert.equal(calls.some(call => call.href.endsWith('/api/bot') && String(call.body).includes('"send"')), false)

    const feed = await handler({ method: 'GET', path: '/api/bot/feed', headers: { cookie: otherCookie } }, env, { fetchImpl })
    assert.equal(feed.statusCode, 200)
    assert.match(feed.body, /event: hello/)
    assert.equal(feed.body.includes(SECRET), false)
    assert.equal(JSON.stringify(feed.headers).includes(SECRET), false)
    for (const call of calls.filter(item => item.href.includes('/api/bot'))) {
      assert.equal(call.origin, 'http://kernel.test')
      assert.match(String(call.cookie ?? ''), /botcamp_session=/)
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('production entry refuses the wiped default directory', async () => {
  const response = await handler(
    { method: 'GET', path: '/api/bot/feed' },
    { BOTCAMP_DATA_DIR: '/tmp/botcamp-data' },
    { fetchImpl: async () => new Response('no') },
  )
  assert.equal(response.statusCode, 502)
  assert.equal(response.body.includes('/tmp/botcamp-data'), false)
})

test('the single file Demox uploads rejects an anonymous bot call', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botcamp-bundle-'))
  const dataDir = await mkdtemp(path.join(tmpdir(), 'botcamp-bundle-data-'))
  const outfile = path.join(dir, 'index.js')
  const runner = path.join(dir, 'run.cjs')
  try {
    await writeFile(path.join(dir, 'package.json'), '{"type":"commonjs"}\n')
    await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile,
      logLevel: 'silent',
    })
    const source = await readFile(outfile, 'utf8')
    assert.equal(source.includes('auth/required'), true)
    assert.equal(source.includes('botcamp_session'), true)
    assert.equal(source.includes(ADMIN_PASSWORD), false)
    await writeFile(runner, `
      const { handler } = require(${JSON.stringify(outfile)})
      let fetched = 0
      global.fetch = async () => { fetched += 1; return new Response('no', { status: 500 }) }
      async function main() {
        const result = await handler({
          method: 'POST',
          path: '/api/bot',
          body: JSON.stringify({ endpoint: 'state', payload: {} }),
        }, {
          BOTCAMP_DATA_DIR: ${JSON.stringify(dataDir)},
          BOTCAMP_ADMIN_EMAIL: '',
          BOTCAMP_ADMIN_PASSWORD: '',
          DSH_KERNEL_ORIGIN: 'http://kernel.test',
        })
        if (result.statusCode !== 401) process.exit(2)
        if (fetched !== 0) process.exit(3)
        if (String(result.body).includes('botcamp-dev')) process.exit(4)
      }
      main().catch((error) => { console.error(error); process.exit(1) })
    `)
    const child = spawn(process.execPath, [runner], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk })
    const code = await new Promise(resolve => child.on('close', resolve))
    assert.equal(stderr.includes(ADMIN_PASSWORD), false)
    assert.equal(code, 0, stderr.slice(0, 400))
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('deployed handler gives a client a bearer token and CORS headers', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'botcamp-fn-client-'))
  const env = envFor(dataDir, { BOTCAMP_ADMIN_EMAIL: ADMIN_EMAIL, BOTCAMP_ADMIN_PASSWORD: ADMIN_PASSWORD })
  try {
    const login = await handler({
      method: 'POST',
      path: '/api/bot',
      headers: { 'content-type': 'application/json', 'x-botcamp-client': '1' },
      body: JSON.stringify({ endpoint: 'auth/login', payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } }),
    }, env)
    assert.equal(login.statusCode, 200)
    assert.equal(login.headers['access-control-allow-origin'], '*')
    const token = JSON.parse(login.body).token
    assert.equal(typeof token, 'string')
    assert.equal(token.length >= 20, true)
    assert.equal(login.body.includes(ADMIN_PASSWORD), false)
    const me = await handler({
      method: 'POST',
      path: '/api/bot',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ endpoint: 'auth/me' }),
    }, env)
    assert.equal(me.statusCode, 200)
    assert.equal(JSON.parse(me.body).user.email, ADMIN_EMAIL)
    const preflight = await handler({ method: 'OPTIONS', path: '/api/bot' }, env)
    assert.equal(preflight.statusCode, 204)
    assert.match(preflight.headers['access-control-allow-headers'], /authorization/)
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})
