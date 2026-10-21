import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const SECRET = 'super-secret-cookie-value'
const TOKEN = 'launch-token-secret'
const KERNEL = 'https://camp.aigc.sx.cn'

function loadHandler() {
  const file = fileURLToPath(new URL('./index.js', import.meta.url))
  delete require.cache[file]
  return require(file)
}

function headers(map, cookies = []) {
  const lower = new Map(Object.entries(map).map(([key, value]) => [key.toLowerCase(), value]))
  return {
    get(name) { return lower.get(String(name).toLowerCase()) ?? null },
    getSetCookie() { return cookies },
  }
}

test('handler calls the kernel with its Origin and does not echo the cookie or token', async () => {
  const calls = []
  const logs = []
  const original = console.log
  console.log = (...args) => { logs.push(args.map(String).join(' ')) }
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), origin: init.headers?.origin, method: init.method || 'GET' })
    const href = String(url)
    if (href.startsWith(`${KERNEL}/api/bot`)) {
      return {
        status: 200,
        headers: headers({ 'content-type': 'application/json' }, [`dsh-auth-test=${SECRET}; HttpOnly`]),
        async text() { return JSON.stringify({ ok: true, value: { note: 'no secrets here' } }) },
        body: null,
      }
    }
    const cookie = init.headers?.cookie || ''
    if (!cookie) {
      return {
        status: 303,
        headers: headers({ location: `./?token=${TOKEN}` }, [`dsh-auth-test=${SECRET}; Path=/; HttpOnly`]),
        body: { async cancel() {} },
      }
    }
    return {
      status: 200,
      headers: headers({ 'content-type': 'text/html' }),
      async text() { return `<html>${SECRET} ${TOKEN}</html>` },
      body: { async cancel() {} },
    }
  }
  try {
    const { handler } = loadHandler()
    const result = await handler({
      method: 'POST',
      path: '/api/bot',
      body: JSON.stringify({ endpoint: 'bot/list', payload: null }),
    }, {})
    const packed = JSON.stringify(result) + logs.join('\n')
    assert.equal(packed.includes(SECRET), false)
    assert.equal(packed.includes(TOKEN), false)
    assert.equal(result.headers['set-cookie'], undefined)
    assert.equal(result.statusCode, 200)
    assert.equal(JSON.parse(result.body).ok, true)
    assert.ok(calls.length >= 2)
    for (const call of calls) assert.equal(call.origin, KERNEL)
    assert.ok(calls.some(call => call.url.startsWith(`${KERNEL}/api/bot`)))
  } finally {
    console.log = original
  }
})

test('feed handler returns the first event and cancels the upstream', async () => {
  let cancelled = false
  let release
  const encoder = new TextEncoder()
  globalThis.fetch = async (url) => {
    const href = String(url)
    if (!href.includes('/api/bot/feed')) {
      return {
        status: 303,
        headers: headers({ location: './' }, [`dsh-auth-test=${SECRET}; HttpOnly`]),
        body: { async cancel() {} },
      }
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
    return {
      status: 200,
      headers: headers({ 'content-type': 'text/event-stream' }, [`dsh-auth-test=${SECRET}; HttpOnly`]),
      body: stream,
    }
  }
  const { handler } = loadHandler()
  const started = Date.now()
  const result = await handler({ method: 'GET', path: '/api/bot/feed' }, {})
  assert.ok(Date.now() - started < 4000)
  assert.equal(result.statusCode, 200)
  assert.match(result.body, /event: hello/)
  assert.equal(result.body.includes(SECRET), false)
  assert.equal(JSON.stringify(result.headers).includes(SECRET), false)
  assert.equal(cancelled, true)
})
