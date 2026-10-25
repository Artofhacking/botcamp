import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { configureDataRoot } from '../../server/kv.mjs'
import { seed } from '../../scripts/seed.mjs'
import { PHOSA_OWNER_ID } from '../../scripts/seed-ids.mjs'
import {
  buildCompanyState,
  buildProgressReport,
  CHIEF_ID,
  companyChatPage,
  companySend,
  isCompanySessionId,
} from './company.mjs'

test('company state lists employees and project rooms without an account gate', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botcamp-co-'))
  try {
    configureDataRoot(path.join(dir, 'media-store'))
    seed()
    const state = buildCompanyState(PHOSA_OWNER_ID, { prefs: {} })
    assert.equal(state.mainBotId, CHIEF_ID)
    assert.deepEqual(state.bots.map((b) => b.name), ['总负责人', '写手', '运营'])
    assert.ok(state.rooms.some((r) => /小稿/.test(r.name)))
    assert.equal(isCompanySessionId(CHIEF_ID), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('chief send returns a real SoT progress report', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botcamp-co-'))
  try {
    configureDataRoot(path.join(dir, 'media-store'))
    seed()
    const report = buildProgressReport(PHOSA_OWNER_ID, {})
    assert.match(report, /进度汇报/)
    assert.match(report, /小稿/)
    assert.match(report, /漏斗/)
    const page = companyChatPage(PHOSA_OWNER_ID, { botId: CHIEF_ID })
    assert.equal(page.ok, true)
    const sent = companySend(PHOSA_OWNER_ID, { botId: CHIEF_ID, text: '全部号出个报表' })
    assert.equal(sent.ok, true)
    const after = companyChatPage(PHOSA_OWNER_ID, { botId: CHIEF_ID })
    const last = after.value.items.at(-1)
    assert.equal(last.kind, 'bot')
    assert.match(last.text, /漏斗/)
    assert.match(last.text, /MediaAccount SoT/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
