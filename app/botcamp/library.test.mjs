import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { configureDataRoot, getDataRoot } from '../../server/kv.mjs'
import { createBotcamp } from './http.mjs'
import { renderLibraryMarkdown } from '../ui/src/libraryMarkdown.js'
import {
  createLibraryNode,
  deleteLibraryNode,
  getLibraryNode,
  handleLibraryControl,
  listLibrary,
  updateLibraryNode,
} from './library.mjs'

const A = { id: 'user-a', role: 'member', email: 'a@example.com' }
const B = { id: 'user-b', role: 'member', email: 'b@example.com' }

test('library is nested markdown with no required sections, isolated by owner', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botcamp-lib-'))
  const prev = getDataRoot()
  try {
    configureDataRoot(path.join(dir, 'store'))
    const folder = await handleLibraryControl(null, 'library/create', { kind: 'folder', name: '随手记' }, A)
    assert.equal(folder.status, 200)
    const nested = await handleLibraryControl(null, 'library/create', {
      kind: 'folder', parentId: folder.body.node.id, name: '子目录',
    }, A)
    const file = await handleLibraryControl(null, 'library/create', {
      kind: 'file',
      parentId: nested.body.node.id,
      name: '没有格式',
      content: '随便写一行。\n',
    }, A)
    assert.equal(file.status, 200)
    assert.equal(file.body.node.name, '没有格式.md')
    assert.equal(file.body.node.content, '随便写一行。\n')
    assert.equal(Object.hasOwn(file.body.node, 'sections'), false)

    const updated = updateLibraryNode(`usr_botcamp_${A.id}`, {
      id: file.body.node.id,
      content: '改过了。\n',
    })
    assert.equal(updated.node.content, '改过了。\n')

    const listed = listLibrary(`usr_botcamp_${A.id}`)
    assert.equal(listed.nodes.length, 3)
    assert.equal(listLibrary(`usr_botcamp_${B.id}`).nodes.length, 0)
    assert.equal(getLibraryNode(`usr_botcamp_${B.id}`, file.body.node.id), null)

    const stolen = await handleLibraryControl(null, 'library/get', {
      id: file.body.node.id,
      ownerId: `usr_botcamp_${A.id}`,
    }, B)
    assert.equal(stolen.status, 404)
    const spoofed = await handleLibraryControl(null, 'library/create', {
      kind: 'file',
      name: '不该给别人',
      content: '只属于 A\n',
      ownerId: `usr_botcamp_${B.id}`,
    }, A)
    assert.equal(getLibraryNode(`usr_botcamp_${B.id}`, spoofed.body.node.id), null)
    assert.equal(getLibraryNode(`usr_botcamp_${A.id}`, spoofed.body.node.id).content, '只属于 A\n')

    const removed = deleteLibraryNode(`usr_botcamp_${A.id}`, folder.body.node.id)
    assert.equal(removed.ok, true)
    assert.equal(getLibraryNode(`usr_botcamp_${A.id}`, file.body.node.id), null)
    assert.equal(createLibraryNode(`usr_botcamp_${A.id}`, { kind: 'file', name: '..', content: 'x' }).error, '名字无效。')
  } finally {
    configureDataRoot(prev)
    await rm(dir, { recursive: true, force: true })
  }
})

async function boot() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'botcamp-lib-http-'))
  const fetchImpl = async (url, init = {}) => {
    const href = String(url)
    if (!href.includes('/api/bot')) return new Response('ok', { status: 200 })
    const body = JSON.parse(init.body ?? '{}')
    if (body.endpoint === 'create-bot') {
      return Response.json({ ok: true, value: { id: `bot-${body.payload?.name}`, name: body.payload?.name, sessionId: `s-${body.payload?.name}` } })
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
      BOTCAMP_ADMIN_EMAIL: 'admin@example.com',
      BOTCAMP_ADMIN_PASSWORD: 'admin-password-1',
    },
  })
  const server = createServer((req, res) => {
    camp.handle(req, res, () => { res.statusCode = 404; res.end() }).catch(() => {
      if (!res.writableEnded) { res.statusCode = 500; res.end() }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    base,
    close: async () => {
      await new Promise((resolve) => server.close(resolve))
      await rm(dataDir, { recursive: true, force: true })
    },
  }
}

async function api(base, body, cookie) {
  const response = await fetch(`${base}/api/bot`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  })
  const json = await response.json().catch(() => null)
  const setCookie = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
  return { status: response.status, json, cookie: setCookie[0]?.split(';', 1)[0] ?? '' }
}

test('library routes refuse other owners over HTTP', async () => {
  const ctx = await boot()
  try {
    const anon = await api(ctx.base, { endpoint: 'library/list', payload: {} })
    assert.equal(anon.status, 401)

    const admin = await api(ctx.base, { endpoint: 'auth/login', payload: { email: 'admin@example.com', password: 'admin-password-1' } })
    assert.equal(admin.status, 200)
    const created = await api(ctx.base, {
      endpoint: 'admin/create',
      payload: { email: 'a@example.com', password: 'password-user-a', quota: 1 },
    }, admin.cookie)
    assert.equal(created.status, 201)
    const other = await api(ctx.base, {
      endpoint: 'admin/create',
      payload: { email: 'b@example.com', password: 'password-user-b', quota: 1 },
    }, admin.cookie)
    assert.equal(other.status, 201)

    const loginA = await api(ctx.base, { endpoint: 'auth/login', payload: { email: 'a@example.com', password: created.json.password } })
    const changedA = await api(ctx.base, { endpoint: 'auth/password', payload: { current: created.json.password, next: 'password-user-a' } }, loginA.cookie)
    assert.equal(changedA.status, 200)
    const sessionA = (await api(ctx.base, { endpoint: 'auth/login', payload: { email: 'a@example.com', password: 'password-user-a' } })).cookie

    const loginB = await api(ctx.base, { endpoint: 'auth/login', payload: { email: 'b@example.com', password: other.json.password } })
    await api(ctx.base, { endpoint: 'auth/password', payload: { current: other.json.password, next: 'password-user-b' } }, loginB.cookie)
    const sessionB = (await api(ctx.base, { endpoint: 'auth/login', payload: { email: 'b@example.com', password: 'password-user-b' } })).cookie

    const made = await api(ctx.base, {
      endpoint: 'library/create',
      payload: { kind: 'file', name: '只有甲', content: '甲的正文\n', ownerId: 'usr_botcamp_someone_else' },
    }, sessionA)
    assert.equal(made.status, 200)
    const id = made.json.node.id
    const seenB = await api(ctx.base, { endpoint: 'library/get', payload: { id } }, sessionB)
    assert.equal(seenB.status, 404)
    const listB = await api(ctx.base, { endpoint: 'library/list', payload: {} }, sessionB)
    assert.equal(listB.status, 200)
    assert.equal(listB.json.nodes.some((node) => node.id === id), false)
    const seenA = await api(ctx.base, { endpoint: 'library/get', payload: { id } }, sessionA)
    assert.equal(seenA.json.node.content, '甲的正文\n')

    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const mp4 = Buffer.alloc(16)
    mp4.writeUInt32BE(16, 0)
    mp4.write('ftyp', 4)
    mp4.write('isom', 8)
    const source = [
      '# 标题',
      '',
      '> [!内部]',
      '> 不外发。',
      '',
      '高亮 ==这里==。',
      '',
      '行内 $E=mc^2$。',
      '',
      '$$',
      '\\frac{a}{b}',
      '$$',
      '',
      '见来源[^src]。',
      '',
      '[^src]: 出处。',
      '',
      `![](data:image/png;base64,${png})`,
      '',
      `<video src="data:video/mp4;base64,${mp4.toString('base64')}" controls></video>`,
      '',
    ].join('\n')
    const rich = await api(ctx.base, {
      endpoint: 'library/create',
      payload: { kind: 'file', name: '带媒体', content: source },
    }, sessionA)
    assert.equal(rich.status, 200)
    const stored = rich.json.node.content
    assert.match(stored, /> \[!内部\]\n> 不外发。/)
    assert.match(stored, /==这里==/)
    assert.match(stored, /\$E=mc\^2\$/)
    assert.match(stored, /\\frac\{a\}\{b\}/)
    assert.match(stored, /\[\^src\]: 出处。/)
    assert.doesNotMatch(stored, /data:/)
    assert.doesNotMatch(stored, /blob:/)
    const urls = [...stored.matchAll(/https?:\/\/[^)\s"]+\/api\/library\/asset\/[a-f0-9]{32}/g)].map((match) => match[0])
    assert.equal(urls.length, 2)
    const bare = await fetch(urls[0])
    assert.equal(bare.status, 200)
    assert.equal(bare.headers.get('access-control-allow-origin'), '*')
    assert.equal(bare.headers.get('set-cookie'), null)
    assert.equal(bare.headers.get('content-type'), 'image/png')
    const pngBytes = Buffer.from(await bare.arrayBuffer())
    assert.equal(pngBytes[0], 0x89)
    const video = await fetch(urls[1], { headers: { range: 'bytes=0-3' } })
    assert.equal(video.status, 206)
    assert.equal(video.headers.get('content-type'), 'video/mp4')
    assert.equal(video.headers.get('content-range'), 'bytes 0-3/16')
    assert.equal((await video.arrayBuffer()).byteLength, 4)
    const head = await fetch(urls[1], { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(head.headers.get('content-length'), '16')
    assert.equal((await head.arrayBuffer()).byteLength, 0)
    for (const suffix of ['', 's', '/zzzz']) {
      const missing = await fetch(`${ctx.base}/api/library/asset${suffix}`)
      assert.equal(missing.status, 404)
    }
    const hidden = await api(ctx.base, { endpoint: 'library/get', payload: { id: rich.json.node.id } }, sessionB)
    assert.equal(hidden.status, 404)
    const listB2 = await api(ctx.base, { endpoint: 'library/list', payload: {} }, sessionB)
    assert.equal(JSON.stringify(listB2.json).includes(urls[0].slice(-32)), false)
    const blobbed = await api(ctx.base, {
      endpoint: 'library/update',
      payload: { id: rich.json.node.id, content: '![x](blob:http://localhost/abc)\n' },
    }, sessionA)
    assert.equal(blobbed.status, 400)
    const anonAsset = await api(ctx.base, { endpoint: 'library/asset', payload: { contentType: 'image/png', data: png } })
    assert.equal(anonAsset.status, 401)
  } finally {
    await ctx.close()
  }
})

test('library preview renders commonmark, the three callouts, footnotes, mark, and math', () => {
  const source = [
    '## 节',
    '',
    '- 外',
    '  - 内',
    '',
    '[链接](https://example.com/a)',
    '',
    'https://example.com/auto',
    '',
    '> [!内部]',
    '> 不外发。',
    '',
    '> [!对外]',
    '> 可以发。',
    '',
    '> [!待核实]',
    '> 还不确定。',
    '',
    '> [!NOTE]',
    '> 普通引用。',
    '',
    '高亮 ==这里== 和 ~~划掉~~ 以及 `code`。',
    '',
    '行内 $a+b$。',
    '',
    '$$',
    'c+d',
    '$$',
    '',
    '见来源[^src]。',
    '',
    '[^src]: 出处。',
    '',
    '| 列 | 右 |',
    '| --- | ---: |',
    '| 一 | 二 |',
    '',
    '- [x] 完成',
    '- [ ] 未做',
    '',
    '```js',
    'const n = 1',
    '```',
    '',
    '```mermaid',
    'graph TD',
    '```',
    '',
    '<script>alert(1)</script>',
    '',
    '[点我](javascript:alert(1))',
    '',
    '<video src="blob:http://localhost/x" controls></video>',
    '',
    '<video src="https://cdn.example.com/a.mp4" controls></video>',
    '',
    '---',
    '',
  ].join('\n')
  const html = renderLibraryMarkdown(source)
  assert.equal(source.includes('> [!内部]'), true)
  assert.match(html, /<h2/)
  assert.match(html, /<ul/)
  assert.match(html, /href="https:\/\/example.com\/a"/)
  assert.match(html, /example.com\/auto/)
  assert.match(html, /lib-callout-in/)
  assert.match(html, /lib-callout-out/)
  assert.match(html, /lib-callout-check/)
  assert.match(html, /lib-callout-label">内部</)
  assert.match(html, /不外发/)
  assert.doesNotMatch(html, /\[!内部\]/)
  assert.equal((html.match(/class="lib-callout /g) || []).length, 3)
  assert.match(html, /\[!NOTE\]/)
  assert.match(html, /<mark>这里<\/mark>/)
  assert.match(html, /<s>划掉<\/s>/)
  assert.match(html, /class="katex"/)
  assert.match(html, /katex-block/)
  assert.match(html, /class="footnotes"/)
  assert.match(html, /出处/)
  assert.match(html, /<table/)
  assert.match(html, /type="checkbox"/)
  assert.match(html, /language-js/)
  assert.match(html, /const n = 1/)
  assert.match(html, /graph TD/)
  assert.match(html, /<pre/)
  assert.doesNotMatch(html, /<svg/i)
  assert.doesNotMatch(html, /<script/i)
  assert.doesNotMatch(html, /<a[^>]+javascript:/i)
  const hostile = renderLibraryMarkdown('<a href="javascript:alert(1)" onclick="alert(1)">x</a><img src="javascript:alert(1)"><script>alert(1)</script>\n')
  assert.doesNotMatch(hostile, /javascript:/i)
  assert.doesNotMatch(hostile, /<script/i)
  assert.doesNotMatch(hostile, /onclick/i)
  assert.doesNotMatch(html, /blob:/i)
  assert.match(html, /src="https:\/\/cdn.example.com\/a.mp4"/)
  assert.match(html, /<hr/)
  const linked = renderLibraryMarkdown('[笔记](doc://doc_abc)\n')
  assert.match(linked, /href="doc:\/\/doc_abc"/)
  assert.match(linked, /lib-doc-link/)
})
