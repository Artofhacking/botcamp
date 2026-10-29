import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const engine = require('../lib/client.cjs')

test('frontmatter becomes page metadata and the H1 is stripped', () => {
  const source = `---
title: 一条口播视频的完整生产包
icon: 🎬
cover: assets/cover.jpg
description: 从选题到终稿
tags: [口播, SOP]
updated: 2026-10-29
---

# 一条口播视频的完整生产包

正文。
`
  const { meta, body } = engine.splitFrontmatter(source)
  assert.equal(meta.title, '一条口播视频的完整生产包')
  assert.equal(meta.icon, '🎬')
  assert.deepEqual(meta.tags, ['口播', 'SOP'])
  assert.doesNotMatch(body, /^# /m)
  assert.match(body, /正文/)
  assert.equal(engine.resolveDocCover(meta, 'docs/post/index.md'), 'docs/post/assets/cover.jpg')
})

test('video block resolves to the raw route and keeps a player', () => {
  const source = `:::video
src: assets/clip.mp4
poster: assets/cover.jpg
caption: 3 分钟版本
:::

正文。
`
  const { html } = engine.renderDocument(source, { root: 'library', mdPath: 'docs/post/index.md' })
  assert.match(html, /<figure class="mr-video">/)
  assert.match(html, /<video[^>]*controls/)
  assert.match(html, /<source src="\/md-reader\/raw\?root=library&amp;path=docs%2Fpost%2Fassets%2Fclip.mp4"/)
  assert.match(html, /poster="\/md-reader\/raw\?root=library&amp;path=docs%2Fpost%2Fassets%2Fcover.jpg"/)
  assert.match(html, /3 分钟版本/)
})

test('relative images still resolve through the raw route', () => {
  const { html } = engine.renderDocument('![封面](assets/cover.jpg)\n', { root: 'library', mdPath: 'docs/post/index.md' })
  assert.match(html, /<img src="\/md-reader\/raw\?root=library&amp;path=docs%2Fpost%2Fassets%2Fcover.jpg"/)
})

test('absolute covers pass through mediaUrl', () => {
  assert.equal(engine.mediaUrl('library', 'https://example.com/a.jpg'), 'https://example.com/a.jpg')
  assert.match(engine.mediaUrl('library', 'docs/a.jpg'), /^\/md-reader\/raw\?/)
})
