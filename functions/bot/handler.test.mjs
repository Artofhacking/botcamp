import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createBotcamp } from '../../app/botcamp/http.mjs'
import { handleDemox, resetDemoxCamp } from '../../app/botcamp/demoxGate.mjs'

const require = createRequire(import.meta.url)

function kernel() {
  const bots = []
  return async function respond(href, init = {}) {
    if (String(href).includes('camp.aigc.sx.cn')) throw new Error('refusing production kernel')
    if (!String(href).endsWith('/api/bot')) return new Response('ok', { status: 200 })
    const body = JSON.parse(init.body ?? '{}')
    if (body.endpoint === 'create-bot') {
      const slot = bots.length === 0 ? 'a' : 'b'
      const bot = { id: `bot-${slot}`, name: slot, sessionId: `sess-${slot}` }
      bots.push(bot)
      return Response.json({ ok: true, value: bot })
    }
    if (body.endpoint === 'usage') {
      return Response.json({
        ok: true,
        value: {
          now: '2026-10-21 12',
          owners: [
            { id: 'bot-a', key: 'bot-a', kind: 'bot', name: '甲' },
            { id: 'bot-b', key: 'bot-b', kind: 'bot', name: '乙' },
          ],
          models: [{ key: 'deepseek', name: 'DeepSeek' }],
          rows: [
            ['2026-10-21 10', 0, 0, 0, 10, 0, 0, 4, 1],
            ['2026-10-21 11', 1, 0, 0, 999, 0, 0, 888, 6],
          ],
          totalTokens: 1901,
        },
      })
    }
    if (body.payload?.key || body.payload?.value) throw new Error('model secret reached the kernel')
    return Response.json({ ok: true, value: null })
  }
}

async function camp() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'botcamp-fn-'))
  const calls = []
  const respond = kernel()
  const fetchImpl = async (url, init = {}) => {
    calls.push({ href: String(url), body: init.body ?? '' })
    return respond(String(url), init)
  }
  const gate = await createBotcamp({
    dataDir,
    kernelOrigin: 'http://kernel.test',
    fetchImpl,
    env: {
      NODE_ENV: 'production',
      BOTCAMP_PRODUCTION: '1',
      BOTCAMP_ADMIN_EMAIL: 'admin@example.com',
      BOTCAMP_ADMIN_PASSWORD: 'admin-password-1',
    },
  })
  return {
    gate,
    calls,
    close: () => rm(dataDir, { recursive: true, force: true }),
  }
}

function cookieFrom(result) {
  const raw = result.headers['set-cookie']
  const first = Array.isArray(raw) ? raw[0] : raw
  return String(first ?? '').split(';', 1)[0]
}

async function post(ctx, pathname, body, cookie) {
  const result = await handleDemox({
    method: 'POST',
    path: pathname,
    headers: cookie ? { cookie } : {},
    body: JSON.stringify(body),
  }, {}, { camp: ctx.gate })
  let json = null
  try { json = result.body ? JSON.parse(result.body) : null } catch { json = null }
  return { ...result, json }
}

test('demox bot function requires a session and rejects model writes', async () => {
  const ctx = await camp()
  try {
    const bare = await post(ctx, '/api/bot', { endpoint: 'provider-add', payload: { provider: 'deepseek', key: 'sk-forged' } })
    assert.equal(bare.statusCode, 401)
    assert.equal(ctx.calls.some(call => call.href.endsWith('/api/bot')), false)
    assert.equal(bare.body.includes('sk-forged'), false)

    const login = await post(ctx, '/api/auth/login', { email: 'admin@example.com', password: 'admin-password-1' })
    assert.equal(login.statusCode, 200)
    const adminCookie = cookieFrom(login)
    const created = await post(ctx, '/api/admin/users', {
      email: 'a@example.com', password: 'password-user-a', quota: 3,
    }, adminCookie)
    assert.equal(created.statusCode, 201)
    const userLogin = await post(ctx, '/api/auth/login', { email: 'a@example.com', password: 'password-user-a' })
    const cookieA = cookieFrom(userLogin)
    await post(ctx, '/api/bot', { endpoint: 'create-bot', payload: { name: '甲' } }, cookieA)
    await post(ctx, '/api/bot', { endpoint: 'create-bot', payload: { name: '乙' } }, adminCookie)

    const refused = await post(ctx, '/api/bot', {
      endpoint: 'provider-add',
      payload: { provider: 'deepseek', key: 'sk-forged' },
    }, cookieA)
    assert.equal(refused.json.ok, false)
    assert.match(refused.json.error.message, /不能配置模型/)
    assert.equal(ctx.calls.some(call => String(call.body).includes('provider-add')), false)
    assert.equal(ctx.calls.some(call => String(call.body).includes('sk-forged')), false)

    const usage = await post(ctx, '/api/bot', {
      endpoint: 'usage',
      payload: { userId: 'someone-else', botId: 'bot-b' },
    }, cookieA)
    assert.equal(usage.json.ok, true)
    assert.equal(usage.body.includes('999'), false)
    assert.equal(usage.body.includes('888'), false)
    assert.equal(usage.json.value.rows.length, 1)
    assert.equal(usage.json.value.rows[0][4], 10)
    assert.deepEqual(usage.json.value.owners.map(owner => owner.id), ['bot-a'])
  } finally {
    await ctx.close()
  }
})

test('unauthenticated function entry stays 401 and does not call the kernel', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'botcamp-entry-'))
  const previous = {
    data: process.env.BOTCAMP_DATA_DIR,
    origin: process.env.DSH_KERNEL_ORIGIN,
    node: process.env.NODE_ENV,
    production: process.env.BOTCAMP_PRODUCTION,
  }
  process.env.BOTCAMP_DATA_DIR = dataDir
  process.env.DSH_KERNEL_ORIGIN = 'http://kernel.test'
  process.env.NODE_ENV = 'production'
  process.env.BOTCAMP_PRODUCTION = '1'
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const href = String(url)
    calls.push(href)
    if (href.includes('camp.aigc.sx.cn')) throw new Error('refusing production kernel')
    return new Response('ok', { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    resetDemoxCamp()
    const { handler } = require('./index.js')
    const result = await handler({ method: 'POST', path: '/api/bot', body: JSON.stringify({ endpoint: 'send', payload: { text: '不要发给内核' } }) })
    assert.equal(result.statusCode, 401)
    assert.match(result.body, /请先登录/)
    assert.equal(calls.some(href => href.includes('/api/bot')), false)
    assert.equal(calls.some(href => href.includes('camp.aigc.sx.cn')), false)
    assert.equal(result.body.includes('不要发给内核'), false)
  } finally {
    globalThis.fetch = originalFetch
    resetDemoxCamp()
    for (const [key, value] of Object.entries({
      BOTCAMP_DATA_DIR: previous.data,
      DSH_KERNEL_ORIGIN: previous.origin,
      NODE_ENV: previous.node,
      BOTCAMP_PRODUCTION: previous.production,
    })) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(dataDir, { recursive: true, force: true })
  }
})
