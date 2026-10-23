import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createHttpLedger, createMemoryLedger } from './projectLedger.mjs'
import { createBotcamp } from './http.mjs'
import { openStore } from './store.mjs'

const ENV = {
  NODE_ENV: 'production',
  BOTCAMP_PRODUCTION: '1',
  BOTCAMP_ADMIN_EMAIL: 'admin@example.com',
  BOTCAMP_ADMIN_PASSWORD: 'admin-password-1',
}

function memoryApi() {
  const tables = new Map()
  return {
    async call(action, body) {
      const name = body.table || body.name
      if (action === 'create_project_table') {
        if (tables.has(name)) {
          const error = new Error('这个表已经存在')
          error.code = 'exists'
          throw error
        }
        tables.set(name, new Map())
        return { success: true }
      }
      const table = tables.get(name)
      if (!table) {
        const error = new Error('没有这张表')
        error.code = 'not_found'
        throw error
      }
      if (action === 'list_project_rows') {
        const keys = [...table.keys()].sort()
        const after = body.after || ''
        const size = body.limit || 100
        const page = keys.filter(key => key > after).slice(0, size + 1)
        const rows = page.slice(0, size).map(pk => ({ pk, values: table.get(pk) }))
        return { success: true, rows, next: page.length > size ? rows[rows.length - 1].pk : null }
      }
      if (action === 'put_project_row') {
        const encoded = JSON.stringify(body.values)
        if (Buffer.byteLength(encoded) > 32 * 1024) {
          const error = new Error('这一行太大')
          error.code = 'bad_row'
          throw error
        }
        table.set(body.values.id, { ...body.values })
        return { success: true }
      }
      if (action === 'delete_project_row') {
        if (!table.delete(body.pk)) {
          const error = new Error('没有这一行')
          error.code = 'not_found'
          throw error
        }
        return { success: true }
      }
      throw new Error(action)
    },
  }
}

async function listen(api) {
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    try {
      const payload = await api.call(body.action, body)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    } catch (error) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ success: false, code: error.code || 'bad', message: error.message }))
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

test('accounts and workspace files survive a second store on the project ledger', async () => {
  const ledger = createMemoryLedger()
  const firstDir = await mkdtemp(path.join(tmpdir(), 'botcamp-ledger-a-'))
  const secondDir = await mkdtemp(path.join(tmpdir(), 'botcamp-ledger-b-'))
  try {
    const first = await openStore(firstDir, { ledger })
    await first.bootstrap(ENV)
    const created = await first.createUser({ email: 'a@example.com', password: 'password-user-a', role: 'user', quota: 3 })
    const session = await first.createSession(created.user.id)
    await first.writeSettings(created.user.id, { workspace: '/kept', secrets: [{ name: 'k', value: 'secret-kept', scope: 'all', purpose: '' }] })
    const root = await first.ensureUserWorkspace(created.user.id)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(path.join(root, 'secret.txt'), 'workspace-kept')
    await writeFile(path.join(root, 'wide.txt'), '汉'.repeat(20_000))
    await first.syncWorkspace(created.user.id)

    const second = await openStore(secondDir, { ledger })
    await second.bootstrap(ENV)
    const users = await second.listUsers()
    assert.equal(users.some(user => user.email === 'a@example.com'), true)
    assert.equal(users.find(user => user.email === 'a@example.com').mustChangePassword, true)
    assert.equal(users.find(user => user.role === 'admin').mustChangePassword, false)
    assert.equal((await second.userForToken(session.token))?.email, 'a@example.com')
    const settings = await second.readSettings(created.user.id)
    assert.equal(settings.workspace, '/kept')
    assert.equal(settings.secrets[0].value, 'secret-kept')
    const again = await second.ensureUserWorkspace(created.user.id)
    assert.equal(await readFile(path.join(again, 'secret.txt'), 'utf8'), 'workspace-kept')
    assert.equal(await readFile(path.join(again, 'wide.txt'), 'utf8'), '汉'.repeat(20_000))
    const fresh = await readFile(path.join(secondDir, 'accounts.json'), 'utf8')
    assert.match(fresh, /a@example.com/)
    assert.equal(fresh.includes('admin-password-1'), false)
  } finally {
    await rm(firstDir, { recursive: true, force: true })
    await rm(secondDir, { recursive: true, force: true })
  }
})

test('an earlier http ledger store still authenticates a zero-quota user and cannot erase them', async () => {
  const api = memoryApi()
  const server = await listen(api)
  const ledger = createHttpLedger({
    fetchImpl: globalThis.fetch,
    apiUrl: server.url,
    token: 'test-token-value-not-a-secret',
    projectId: 'PQBDTM6GLZ',
  })
  const firstDir = await mkdtemp(path.join(tmpdir(), 'botcamp-zero-a-'))
  const secondDir = await mkdtemp(path.join(tmpdir(), 'botcamp-zero-b-'))
  const thirdDir = await mkdtemp(path.join(tmpdir(), 'botcamp-zero-c-'))
  try {
    const first = await openStore(firstDir, { ledger })
    await first.bootstrap(ENV)
    const second = await openStore(secondDir, { ledger })
    await second.bootstrap(ENV)
    const created = await first.createUser({ email: 'zero@example.com', password: 'password-zero', role: 'user', quota: 0 })
    assert.equal(created.user.quota, 0)
    assert.equal(created.user.used, 0)
    const logged = await second.authenticate('zero@example.com', 'password-zero')
    assert.equal(logged?.email, 'zero@example.com')
    assert.equal(logged?.quota, 0)
    assert.equal(logged?.mustChangePassword, true)
    assert.equal((await second.tryConsume(logged.id)).ok, false)
    assert.equal((await second.listUsers()).some(user => user.email === 'zero@example.com'), true)
    const other = await second.createUser({ email: 'five@example.com', password: 'password-five', role: 'user', quota: 5 })
    assert.equal(other.user.quota, 5)
    const third = await openStore(thirdDir, { ledger })
    const emails = (await third.listUsers()).map(user => user.email).sort()
    assert.deepEqual(emails, ['admin@example.com', 'five@example.com', 'zero@example.com'])
    const admin = (await third.listUsers()).find(user => user.role === 'admin')
    const removed = await second.deleteUser(created.user.id, admin.id)
    assert.equal(removed.ok, true)
    assert.equal(await third.authenticate('zero@example.com', 'password-zero'), null)
    assert.equal((await third.authenticate('five@example.com', 'password-five'))?.quota, 5)
  } finally {
    await server.close()
    await rm(firstDir, { recursive: true, force: true })
    await rm(secondDir, { recursive: true, force: true })
    await rm(thirdDir, { recursive: true, force: true })
  }
})

test('http project ledger round-trips rows without keeping the disk', async () => {
  const api = memoryApi()
  const server = await listen(api)
  const ledger = createHttpLedger({
    fetchImpl: globalThis.fetch,
    apiUrl: server.url,
    token: 'test-token-value-not-a-secret',
    projectId: 'PQBDTM6GLZ',
  })
  const dir = await mkdtemp(path.join(tmpdir(), 'botcamp-http-ledger-'))
  try {
    const store = await openStore(dir, { ledger })
    await store.bootstrap(ENV)
    const created = await store.createUser({ email: 'b@example.com', password: 'password-user-b', role: 'user', quota: 1 })
    const root = await store.ensureUserWorkspace(created.user.id)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(path.join(root, 'note.txt'), 'durable-note')
    await store.syncWorkspace(created.user.id)
    await rm(dir, { recursive: true, force: true })
    const nextDir = await mkdtemp(path.join(tmpdir(), 'botcamp-http-ledger-'))
    const next = await openStore(nextDir, { ledger })
    const users = await next.listUsers()
    assert.equal(users.some(user => user.email === 'b@example.com'), true)
    const again = await next.ensureUserWorkspace(created.user.id)
    assert.equal(await readFile(path.join(again, 'note.txt'), 'utf8'), 'durable-note')
    await rm(nextDir, { recursive: true, force: true })
  } finally {
    await server.close()
  }
})

test('opening the bot list reloads each account table once and does not rewrite files', async () => {
  const api = memoryApi()
  const seen = []
  const inner = api.call
  api.call = async (action, body) => {
    seen.push(`${action}:${body.table || body.name || ''}`)
    return inner(action, body)
  }
  const server = await listen(api)
  const dir = await mkdtemp(path.join(tmpdir(), 'botcamp-state-once-'))
  const fetchImpl = async (url, init) => {
    const target = typeof url === 'string' ? url : url.toString()
    if (target.startsWith(server.url)) return fetch(url, init)
    if (new URL(target).pathname === '/api/bot') {
      return Response.json({ ok: true, value: { bots: [], rooms: [], revision: 1, modelsKey: 'm' } })
    }
    return new Response(null, { status: 204, headers: { 'set-cookie': 'dsh-auth=probe' } })
  }
  try {
    const gate = await createBotcamp({
      env: { ...ENV, DSH_KERNEL_ORIGIN: 'https://kernel.test' },
      dataDir: dir,
      fetchImpl,
      ledger: createHttpLedger({
        fetchImpl,
        apiUrl: server.url,
        token: 'test-token-value-not-a-secret',
        projectId: 'PQBDTM6GLZ',
      }),
    })
    const login = fakeRes()
    await gate.handle(fakeReq('POST', '/api/bot', {
      body: JSON.stringify({ endpoint: 'auth/login', payload: { email: ENV.BOTCAMP_ADMIN_EMAIL, password: ENV.BOTCAMP_ADMIN_PASSWORD } }),
      headers: { 'content-type': 'application/json', 'x-botcamp-client': '1' },
    }), login, () => {})
    const token = JSON.parse(login.body()).token
    assert.equal(typeof token, 'string')
    const before = seen.length
    for (let i = 0; i < 2; i += 1) {
      const res = fakeRes()
      await gate.handle(fakeReq('POST', '/api/bot', {
        body: JSON.stringify({ endpoint: 'state', payload: { since: null, models: '', locale: 'zh-CN' } }),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      }), res, () => {})
      assert.equal(res.statusCode, 200)
      assert.equal(JSON.parse(res.body()).ok, true)
    }
    const during = seen.slice(before)
    for (const table of ['botcamp_users', 'botcamp_sessions', 'botcamp_resources', 'botcamp_revoked']) {
      assert.equal(during.filter(item => item === `list_project_rows:${table}`).length, 2, table)
    }
    assert.equal(during.some(item => item.startsWith('put_project_row:')), false)
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

function fakeRes() {
  const chunks = []
  return {
    statusCode: 200,
    writableEnded: false,
    destroyed: false,
    setHeader() {},
    on() { return this },
    off() { return this },
    end(chunk) {
      if (chunk) chunks.push(Buffer.from(chunk))
      this.writableEnded = true
    },
    body: () => Buffer.concat(chunks).toString('utf8'),
  }
}

function fakeReq(method, url, { body = '', headers = {} } = {}) {
  const payload = Buffer.from(body)
  return {
    method,
    url,
    headers,
    socket: {},
    async *[Symbol.asyncIterator]() {
      if (payload.length) yield payload
    },
  }
}
