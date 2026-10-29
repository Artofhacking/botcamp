import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import { apply } from '../lib/index.js'

function makeResponse() {
  let resolve
  const done = new Promise((r) => { resolve = r })
  const chunks = []
  const response = {
    status: 0,
    headers: {},
    headersSent: false,
    writeHead(status, headers = {}) {
      this.status = status
      this.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]))
      this.headersSent = true
    },
    write(chunk) {
      if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
      return true
    },
    end(chunk) {
      if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
      if (typeof resolve === 'function') {
        const finish = resolve
        resolve = null
        finish({ status: this.status, headers: this.headers, body: Buffer.concat(chunks) })
      }
    },
    on() { return this },
    once() { return this },
    emit() { return true },
    destroy() {},
  }
  return { response, done }
}

async function request(route, { method = 'GET', url, headers = {}, body = '' }) {
  const req = Readable.from(body === '' ? [] : [Buffer.from(body)])
  req.method = method
  req.url = url
  req.headers = headers
  const { response, done } = makeResponse()
  await route.handler(req, response)
  return done
}

test('BotCamp library host: fixed root, cards, and range streaming', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'botcamp-library-'))
  const library = join(parent, 'library')
  await mkdir(join(library, 'docs', 'post', 'assets'), { recursive: true })
  await mkdir(join(library, 'media'), { recursive: true })
  const markdown = `---
title: 一条口播视频的完整生产包
icon: 🎬
cover: assets/cover.jpg
description: 从选题到终稿的完整示例
tags: [口播, SOP]
updated: 2026-10-29
---

# 一条口播视频的完整生产包

正文第一段。
`
  await writeFile(join(library, 'docs', 'post', 'index.md'), markdown)
  await writeFile(join(library, 'docs', 'post', 'assets', 'cover.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
  await writeFile(join(library, 'docs', 'post', 'assets', 'clip.mp4'), Buffer.from('0123456789abcdef'))
  await writeFile(join(parent, 'outside.txt'), 'outside')
  process.env.BOTCAMP_LIBRARY_ROOT = library

  const routes = []
  const effects = []
  const ctx = {
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    systemPrompt: { section: () => () => {} },
    effect(factory) {
      const dispose = factory()
      if (typeof dispose === 'function') effects.push(dispose)
    },
  }
  apply(ctx)
  t.after(() => {
    for (const dispose of effects) dispose()
    delete process.env.BOTCAMP_LIBRARY_ROOT
    return rm(parent, { recursive: true, force: true })
  })

  assert.deepEqual(routes.map((route) => route.path), ['/md-reader', '/library', '/aionui-panel/katex', '/aionui-panel/hljs'])
  const route = routes[0]
  const standalone = routes[1]

  await t.test('config reports the fixed library root', async () => {
    const res = await request(route, { url: '/md-reader/config' })
    assert.equal(res.status, 200)
    const envelope = JSON.parse(res.body.toString('utf8'))
    assert.equal(envelope.ok, true)
    assert.equal(envelope.value.root, library)
    assert.equal(envelope.value.readonly, false)
  })

  await t.test('list returns frontmatter cards and the cover', async () => {
    const res = await request(route, { url: '/md-reader/list' })
    assert.equal(res.status, 200)
    const envelope = JSON.parse(res.body.toString('utf8'))
    assert.equal(envelope.ok, true)
    assert.equal(envelope.value.items.length, 1)
    const item = envelope.value.items[0]
    assert.equal(item.title, '一条口播视频的完整生产包')
    assert.equal(item.description, '从选题到终稿的完整示例')
    assert.equal(item.icon, '🎬')
    assert.equal(item.cover, 'docs/post/assets/cover.jpg')
    assert.deepEqual(item.tags, ['口播', 'SOP'])
    assert.equal(item.path, 'docs/post/index.md')
  })

  await t.test('read ignores a foreign root and stays inside the library', async () => {
    const res = await request(route, {
      method: 'POST',
      url: '/md-reader/read',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root: '/tmp/not-the-library', path: 'docs/post/index.md' }),
    })
    assert.equal(res.status, 200)
    const envelope = JSON.parse(res.body.toString('utf8'))
    assert.equal(envelope.ok, true)
    assert.match(envelope.value.content, /一条口播视频的完整生产包/)
  })

  await t.test('workspace creates, writes, uploads, renames and trashes a doc', async () => {
    const jsonHeaders = { 'content-type': 'application/json' }
    const createdRes = await request(route, {
      method: 'POST', url: '/md-reader/create', headers: jsonHeaders,
      body: JSON.stringify({ title: '测试新建文档' }),
    })
    assert.equal(createdRes.status, 200)
    const created = JSON.parse(createdRes.body.toString('utf8')).value
    assert.match(created.path, /^docs\/测试新建文档\/index\.md$/)
    const createdFile = join(library, created.path)
    assert.match((await stat(createdFile)).size > 0 ? 'yes' : 'no', /yes/)

    const writeRes = await request(route, {
      method: 'POST', url: '/md-reader/write', headers: jsonHeaders,
      body: JSON.stringify({ path: created.path, content: '# 测试新建文档\n\n工作区写入。\n' }),
    })
    assert.equal(writeRes.status, 200)
    const readRes = await request(route, {
      method: 'POST', url: '/md-reader/read', headers: jsonHeaders,
      body: JSON.stringify({ path: created.path }),
    })
    assert.match(JSON.parse(readRes.body.toString('utf8')).value.content, /工作区写入/)

    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlGQAAAAASUVORK5CYII='
    const uploadRes = await request(route, {
      method: 'POST', url: '/md-reader/upload', headers: jsonHeaders,
      body: JSON.stringify({ path: created.path, name: 'pixel.png', data: `data:image/png;base64,${png}` }),
    })
    assert.equal(uploadRes.status, 200)
    const uploaded = JSON.parse(uploadRes.body.toString('utf8')).value
    assert.match(uploaded.path, /^assets\/pixel\.png$/)
    const rawRes = await request(route, { url: `/md-reader/raw?path=${encodeURIComponent(`docs/测试新建文档/${uploaded.path}`)}` })
    assert.equal(rawRes.status, 200)
    assert.equal(rawRes.headers['content-type'], 'image/png')

    const renameRes = await request(route, {
      method: 'POST', url: '/md-reader/rename', headers: jsonHeaders,
      body: JSON.stringify({ path: created.path, title: '测试改名文档' }),
    })
    assert.equal(renameRes.status, 200)
    const renamed = JSON.parse(renameRes.body.toString('utf8')).value
    assert.match(renamed.path, /^docs\/测试改名文档\/index\.md$/)

    const treeRes = await request(route, { url: '/md-reader/tree' })
    assert.equal(treeRes.status, 200)
    const tree = JSON.parse(treeRes.body.toString('utf8')).value
    assert.equal(tree.docs.some((doc) => doc.path === renamed.path), true)

    const deleteRes = await request(route, {
      method: 'POST', url: '/md-reader/delete', headers: jsonHeaders,
      body: JSON.stringify({ path: renamed.path }),
    })
    assert.equal(deleteRes.status, 200)
    const after = await request(route, { url: '/md-reader/tree' })
    const afterTree = JSON.parse(after.body.toString('utf8')).value
    assert.equal(afterTree.docs.some((doc) => doc.path === renamed.path), false)
  })

  await t.test('raw media answers a byte range for video seeking', async () => {
    const res = await request(route, {
      url: '/md-reader/raw?path=docs/post/assets/clip.mp4',
      headers: { range: 'bytes=4-7' },
    })
    assert.equal(res.status, 206)
    assert.equal(res.headers['content-type'], 'video/mp4')
    assert.equal(res.headers['accept-ranges'], 'bytes')
    assert.equal(res.headers['content-range'], 'bytes 4-7/16')
    assert.equal(res.body.toString('utf8'), '4567')
  })

  await t.test('standalone page serves the same client bundle', async () => {
    const page = await request(standalone, { url: '/library/' })
    assert.equal(page.status, 200)
    assert.match(page.body.toString('utf8'), /BotCamp 文档库/)
    const client = await request(standalone, { url: '/library/client.js' })
    assert.equal(client.status, 200)
    assert.match(client.body.toString('utf8'), /__ModuleLoader__/)
  })

  await t.test('traversal outside the library is rejected', async () => {
    const res = await request(route, { url: '/md-reader/raw?path=../outside.txt' })
    assert.equal(res.status, 403)
  })
})

test('first list creates docs/ and media/ under a missing library root', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'botcamp-library-new-'))
  const library = join(parent, 'library')
  process.env.BOTCAMP_LIBRARY_ROOT = library
  const routes = []
  const ctx = {
    webServer: { register(route) { routes.push(route); return () => {} } },
    systemPrompt: { section: () => () => {} },
    effect(factory) { const dispose = factory(); return typeof dispose === 'function' ? dispose : () => {} },
  }
  apply(ctx)
  t.after(() => {
    delete process.env.BOTCAMP_LIBRARY_ROOT
    return rm(parent, { recursive: true, force: true })
  })
  const res = await request(routes[0], { url: '/md-reader/list' })
  assert.equal(res.status, 200)
  const envelope = JSON.parse(res.body.toString('utf8'))
  assert.equal(envelope.ok, true)
  assert.deepEqual(envelope.value.items, [])
  assert.equal((await stat(join(library, 'docs'))).isDirectory(), true)
  assert.equal((await stat(join(library, 'media'))).isDirectory(), true)
})
