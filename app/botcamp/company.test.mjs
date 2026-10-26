import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { configureDataRoot, getDataRoot } from '../../server/kv.mjs'
import { seed } from '../../scripts/seed.mjs'
import { PHOSA_OWNER_ID } from '../../scripts/seed-ids.mjs'
import {
  buildCompanyState,
  CHIEF_ID,
  companyChatPage,
  companySend,
  isCompanySessionId,
} from './company.mjs'
import { getLibraryNode } from './library.mjs'
import { OTHER_OWNER_ID } from '../../scripts/seed-ids.mjs'

test('company state lists employees and project rooms without an account gate', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botcamp-co-'))
  const prev = getDataRoot()
  try {
    configureDataRoot(path.join(dir, 'media-store'))
    seed()
    const state = buildCompanyState(PHOSA_OWNER_ID, { prefs: {} })
    assert.equal(state.mainBotId, CHIEF_ID)
    assert.deepEqual(state.bots.map((b) => b.name), ['主编', '写稿', '数据'])
    assert.ok(state.rooms.some((r) => /小稿/.test(r.name)))
    const room = state.rooms.find((r) => /小稿/.test(r.name))
    assert.ok(Array.isArray(room.members) && room.members.includes(CHIEF_ID), 'rooms must expose members for DS Bot UI')
    assert.equal(isCompanySessionId(CHIEF_ID), true)
  } finally {
    configureDataRoot(prev)
    await rm(dir, { recursive: true, force: true })
  }
})

test('chief send keeps a markdown note and links it', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botcamp-co-'))
  const prev = getDataRoot()
  try {
    configureDataRoot(path.join(dir, 'media-store'))
    seed()
    const page = companyChatPage(PHOSA_OWNER_ID, { botId: CHIEF_ID })
    assert.equal(page.ok, true)
    assert.match(page.value.items[0].text, /主编/)
    assert.doesNotMatch(page.value.items[0].text, /报表|看板|白板/)

    const sent = companySend(PHOSA_OWNER_ID, { botId: CHIEF_ID, text: '全部号进度' })
    assert.equal(sent.ok, true)
    const after = companyChatPage(PHOSA_OWNER_ID, { botId: CHIEF_ID })
    const last = after.value.items.at(-1)
    assert.equal(last.kind, 'bot')
    assert.match(last.text, /doc:\/\/doc_[a-f0-9]+/)
    assert.doesNotMatch(last.text, /报表|看板|白板|board:\/\//)
    const id = last.text.match(/doc:\/\/(doc_[a-f0-9]+)/)[1]
    const node = getLibraryNode(PHOSA_OWNER_ID, id)
    assert.equal(node.kind, 'file')
    assert.equal(typeof node.content, 'string')
    assert.ok(node.content.length > 0)
    assert.equal(getLibraryNode(OTHER_OWNER_ID, id), null)
    assert.equal(sent.value.docLink.href, `doc://${id}`)

    const remembered = companySend(PHOSA_OWNER_ID, { botId: CHIEF_ID, text: '记下来：明天只改标题' })
    assert.equal(remembered.ok, true)
    const again = companyChatPage(PHOSA_OWNER_ID, { botId: CHIEF_ID })
    const note = again.value.items.at(-1)
    const noteId = note.text.match(/doc:\/\/(doc_[a-f0-9]+)/)[1]
    const kept = getLibraryNode(PHOSA_OWNER_ID, noteId)
    assert.match(kept.content, /明天只改标题/)
    assert.equal(kept.name, '明天只改标题.md')
    assert.equal(getLibraryNode(OTHER_OWNER_ID, noteId), null)
  } finally {
    configureDataRoot(prev)
    await rm(dir, { recursive: true, force: true })
  }
})
