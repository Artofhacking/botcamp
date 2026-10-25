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
  buildStatusKanban,
  CHIEF_ID,
  companyChatPage,
  companySend,
  isCompanySessionId,
} from './company.mjs'

test('company state lists employees and project rooms without an account gate', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botcamp-co-'))
  const prev = getDataRoot()
  try {
    configureDataRoot(path.join(dir, 'media-store'))
    seed()
    const state = buildCompanyState(PHOSA_OWNER_ID, { prefs: {} })
    assert.equal(state.mainBotId, CHIEF_ID)
    assert.deepEqual(state.bots.map((b) => b.name), ['总负责人', '写手', '运营'])
    assert.ok(state.rooms.some((r) => /小稿/.test(r.name)))
    const room = state.rooms.find((r) => /小稿/.test(r.name))
    assert.ok(Array.isArray(room.members) && room.members.includes(CHIEF_ID), 'rooms must expose members for DS Bot UI')
    assert.equal(isCompanySessionId(CHIEF_ID), true)
  } finally {
    configureDataRoot(prev)
    await rm(dir, { recursive: true, force: true })
  }
})

test('chief send places kanban table/article/icon components', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botcamp-co-'))
  const prev = getDataRoot()
  try {
    configureDataRoot(path.join(dir, 'media-store'))
    seed()
    const kanban = buildStatusKanban(PHOSA_OWNER_ID, {})
    assert.match(kanban.heading, /看板/)
    assert.ok(kanban.columns.some((c) => c.name === '待你处理'))
    assert.equal(kanban.table.columns.includes('账号'), true)
    assert.doesNotMatch(JSON.stringify(kanban), /报表/)

    const page = companyChatPage(PHOSA_OWNER_ID, { botId: CHIEF_ID })
    assert.equal(page.ok, true)
    const sent = companySend(PHOSA_OWNER_ID, { botId: CHIEF_ID, text: '全部号进度' })
    assert.equal(sent.ok, true)
    const after = companyChatPage(PHOSA_OWNER_ID, { botId: CHIEF_ID })
    const last = after.value.items.at(-1)
    assert.equal(last.kind, 'bot')
    assert.match(last.text, /看板/)
    assert.match(last.text, /board:\/\//)
    assert.doesNotMatch(last.text, /报表/)
    assert.ok(sent.value.boardLink?.href)
  } finally {
    configureDataRoot(prev)
    await rm(dir, { recursive: true, force: true })
  }
})
