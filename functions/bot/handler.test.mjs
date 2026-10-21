import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const SECRET = 'super-secret-cookie-value'
const TOKEN = 'launch-token-secret'
const KERNEL = 'https://camp.aigc.sx.cn'
const ADMIN_EMAIL = 'admin@example.com'
const ADMIN_PASSWORD = 'admin-password-1'

function loadHandler() {
  const file = fileURLToPath(new URL('./index.js', import.meta.url))
  delete require.cache[file]
  return require(file)
}

function kernelFetch(calls) {
  return async (url, init = {}) => {
    calls.push({ url: String(url), origin: init.headers?.origin, method: init.method || 'GET', body: init.body })
    const href = String(url)
    if (href.includes('/api/bot')) {
      const body = JSON.parse(init.body ?? '{}')
      if (body.endpoint === 'create-bot') {
        const slot = calls.filter(call => {
          try { return JSON.parse(call.body ?? '{}').endpoint === 'create-bot' } catch { return false }
        }).length === 1 ? 'a' : 'b'
        return new Response(JSON.stringify({ ok: true, value: { id: `bot-${slot}`, sessionId: `sess-${slot}` } }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'set-cookie': `dsh-auth-test=${SECRET}; HttpOnly` },
        })
      }
      if (body.endpoint === 'send') {
        return new Response(JSON.stringify({ ok: true, value: { sent: true } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ ok: true, value: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const cookie = init.headers?.cookie || ''
    if (!cookie) {
      return new Response(null, {
        status: 303,
        headers: { location: `./?token=${TOKEN}`, 'set-cookie': `dsh-auth-test=${SECRET}; Path=/; HttpOnly` },
      })
    }
    return new Response(`<html>${SECRET} ${TOKEN}</html>`, {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })
  }
}

async function envWithDir() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'botcamp-fn-'))
  return {
    dataDir,
    env: {
      NODE_ENV: 'production',
      BOTCAMP_PRODUCTION: '1',
      BOTCAMP_DATA_DIR: dataDir,
      BOTCAMP_ADMIN_EMAIL: ADMIN_EMAIL,
      BOTCAMP_ADMIN_PASSWORD: ADMIN_PASSWORD,
    },
  }
}

function cookiePair(result) {
  const raw = result.headers?.['set-cookie']
  const value = Array.isArray(raw) ? raw[0] : raw
  return String(value ?? '').split(';', 1)[0]
}

test('the bundled gate matches app/botcamp', async () => {
  for (const name of ['http.mjs', 'isolate.mjs', 'store.mjs', 'passwords.mjs', 'workspace.mjs']) {
    const bundled = await readFile(fileURLToPath(new URL(`./botcamp/${name}`, import.meta.url)), 'utf8')
    const source = await readFile(fileURLToPath(new URL(`../../app/botcamp/${name}`, import.meta.url)), 'utf8')
    assert.equal(bundled, source, name)
  }
})

test('unauthenticated /api/bot is 401 and does not call the kernel', async () => {
  const calls = []
  globalThis.fetch = kernelFetch(calls)
  const { dataDir, env } = await envWithDir()
  try {
    const { handler } = loadHandler()
    const result = await handler({ method: 'POST', path: '/api/bot', body: JSON.stringify({ endpoint: 'state', payload: {} }) }, env)
    assert.equal(result.statusCode, 401)
    assert.match(result.body, /请先登录/)
    assert.equal(result.body.includes(SECRET), false)
    assert.equal(result.body.includes(TOKEN), false)
    assert.equal(calls.length, 0)
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('handler keeps kernel cookies off the response and isolates workspaces', async () => {
  const calls = []
  const logs = []
  const original = console.log
  console.log = (...args) => { logs.push(args.map(String).join(' ')) }
  globalThis.fetch = kernelFetch(calls)
  const { dataDir, env } = await envWithDir()
  try {
    const { handler } = loadHandler()
    const login = await handler({
      method: 'POST',
      path: '/api/auth/login',
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    }, env)
    const adminCookie = cookiePair(login)
    assert.match(adminCookie, /^botcamp_session=/)
    const createdA = await handler({
      method: 'POST',
      path: '/api/admin/users',
      headers: { cookie: adminCookie },
      body: JSON.stringify({ email: 'a@example.com', password: 'password-user-a', quota: 3 }),
    }, env)
    const createdB = await handler({
      method: 'POST',
      path: '/api/admin/users',
      headers: { cookie: adminCookie },
      body: JSON.stringify({ email: 'b@example.com', password: 'password-user-b', quota: 3 }),
    }, env)
    assert.equal(createdA.statusCode, 201)
    assert.equal(createdB.statusCode, 201)
    const loginA = await handler({
      method: 'POST', path: '/api/auth/login',
      body: JSON.stringify({ email: 'a@example.com', password: 'password-user-a' }),
    }, env)
    const loginB = await handler({
      method: 'POST', path: '/api/auth/login',
      body: JSON.stringify({ email: 'b@example.com', password: 'password-user-b' }),
    }, env)
    const cookieA = cookiePair(loginA)
    const cookieB = cookiePair(loginB)

    const botA = await handler({
      method: 'POST', path: '/api/bot', headers: { cookie: cookieA },
      body: JSON.stringify({ endpoint: 'create-bot', payload: { name: '甲' } }),
    }, env)
    const botB = await handler({
      method: 'POST', path: '/api/bot', headers: { cookie: cookieB },
      body: JSON.stringify({ endpoint: 'create-bot', payload: { name: '乙' } }),
    }, env)
    assert.equal(JSON.parse(botA.body).value.sessionId, 'sess-a')
    assert.equal(JSON.parse(botB.body).value.sessionId, 'sess-b')
    for (const call of calls) assert.equal(call.origin, KERNEL)
    const packedLogin = JSON.stringify(botA) + logs.join('\n')
    assert.equal(packedLogin.includes(SECRET), false)
    assert.equal(packedLogin.includes(TOKEN), false)
    assert.equal(botA.headers['set-cookie'], undefined)

    const accounts = JSON.parse(await readFile(path.join(dataDir, 'accounts.json'), 'utf8'))
    const userA = accounts.users.find(user => user.email === 'a@example.com')
    const userB = accounts.users.find(user => user.email === 'b@example.com')
    const secret = 'beta-workspace-secret'
    const wrote = await handler({
      method: 'POST', path: '/api/bot', headers: { cookie: cookieB },
      body: JSON.stringify({ endpoint: 'file-write', payload: { file: 'secret.txt', text: secret } }),
    }, env)
    assert.equal(JSON.parse(wrote.body).ok, true)

    const listA = await handler({
      method: 'POST', path: '/api/bot', headers: { cookie: cookieA },
      body: JSON.stringify({ endpoint: 'workspace-list', payload: {} }),
    }, env)
    const listed = JSON.parse(listA.body)
    assert.deepEqual(listed.value.workspaces.map(item => item.id), [userA.kernelKey])
    assert.equal(listA.body.includes(userB.kernelKey), false)
    assert.equal(listA.body.includes(secret), false)

    const openB = await handler({
      method: 'POST', path: '/api/bot', headers: { cookie: cookieA },
      body: JSON.stringify({ endpoint: 'workspace-open', payload: { workspaceId: userB.kernelKey } }),
    }, env)
    assert.equal(JSON.parse(openB.body).ok, false)
    assert.match(openB.body, /无权/)
    assert.equal(openB.body.includes(secret), false)

    const sendOther = await handler({
      method: 'POST', path: '/api/bot', headers: { cookie: cookieA },
      body: JSON.stringify({ endpoint: 'send', payload: { sessionId: 'sess-b', text: '写进乙的会话' } }),
    }, env)
    assert.equal(JSON.parse(sendOther.body).ok, false)
    const traversal = await handler({
      method: 'POST', path: '/api/bot', headers: { cookie: cookieA },
      body: JSON.stringify({ endpoint: 'file-text', payload: { file: `../${userB.kernelKey}/secret.txt` } }),
    }, env)
    assert.equal(JSON.parse(traversal.body).ok, false)
    assert.equal(traversal.body.includes(secret), false)
    await symlink(path.join(dataDir, 'workspaces', userB.kernelKey, 'secret.txt'), path.join(dataDir, 'workspaces', userA.kernelKey, 'alias.txt'))
    const linked = await handler({
      method: 'POST', path: '/api/bot', headers: { cookie: cookieA },
      body: JSON.stringify({ endpoint: 'file-text', payload: { file: 'alias.txt' } }),
    }, env)
    assert.equal(JSON.parse(linked.body).ok, false)
    assert.equal(linked.body.includes(secret), false)

    const forwarded = calls.filter((call) => {
      try {
        const body = JSON.parse(call.body ?? '{}')
        return body.endpoint === 'send' || body.endpoint === 'file-text' || body.endpoint === 'workspace-open' || body.endpoint === 'file-write'
      } catch { return false }
    })
    assert.equal(forwarded.length, 0)
  } finally {
    console.log = original
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('feed handler returns the first event and cancels the upstream', async () => {
  let cancelled = false
  let release
  const encoder = new TextEncoder()
  globalThis.fetch = async (url) => {
    const href = String(url)
    if (!href.includes('/api/bot/feed')) {
      return new Response(null, {
        status: 303,
        headers: { location: './', 'set-cookie': `dsh-auth-test=${SECRET}; HttpOnly` },
      })
    }
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('event: hello\ndata: {"ok":true}\n\n'))
      },
      pull() {
        return new Promise((resolve) => { release = resolve })
      },
      cancel() {
        cancelled = true
        release?.()
      },
    })
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'set-cookie': `dsh-auth-test=${SECRET}; HttpOnly` },
    })
  }
  const { dataDir, env } = await envWithDir()
  try {
    const { handler } = loadHandler()
    const login = await handler({
      method: 'POST', path: '/api/auth/login',
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    }, env)
    const started = Date.now()
    const result = await handler({
      method: 'GET',
      path: '/api/bot/feed',
      headers: { cookie: cookiePair(login) },
    }, env)
    assert.ok(Date.now() - started < 4000)
    assert.equal(result.statusCode, 200)
    assert.match(result.body, /event: hello/)
    assert.equal(result.body.includes(SECRET), false)
    assert.equal(JSON.stringify(result.headers).includes(SECRET), false)
    assert.equal(cancelled, true)
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})
