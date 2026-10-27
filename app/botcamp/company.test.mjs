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
  OPS_ID,
  WRITER_ID,
} from './company.mjs'
import { COMPANY_MODEL_REF, COMPANY_RELAY_NAME, modelReplyAfter, withoutRelayBots } from './companyModel.mjs'
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
    assert.equal(COMPANY_MODEL_REF, 'qoder/deepseek-v4-flash')
    assert.equal(state.defaultModel, COMPANY_MODEL_REF)
    assert.ok(state.models.length > 0)
    assert.ok(state.models.some((model) => model.provider === 'qoder' && model.id === 'deepseek-v4-flash' && model.ref === COMPANY_MODEL_REF))
    assert.equal(state.models.some((model) => model.provider === 'deepseek-official'), false)
    assert.equal(state.bots.every((bot) => bot.model === COMPANY_MODEL_REF), true)
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

    const sent = await companySend(PHOSA_OWNER_ID, { botId: CHIEF_ID, text: '全部号进度' })
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

    let modelCalls = 0
    const remembered = await companySend(
      PHOSA_OWNER_ID,
      { botId: CHIEF_ID, text: '记下来：明天只改标题' },
      undefined,
      async () => { modelCalls += 1; return '模型不该写这篇笔记' },
    )
    assert.equal(modelCalls, 0)
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

test('an ordinary company message stores the model reply', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botcamp-co-'))
  const prev = getDataRoot()
  try {
    configureDataRoot(path.join(dir, 'media-store'))
    seed()
    const before = companyChatPage(PHOSA_OWNER_ID, { botId: CHIEF_ID })
    const failed = await companySend(
      PHOSA_OWNER_ID,
      { botId: CHIEF_ID, text: '用一句话介绍你自己' },
      undefined,
      async () => { throw new Error('down') },
    )
    assert.equal(failed.ok, false)
    assert.match(failed.error.message, /模型这次没有答上来/)
    const unchanged = companyChatPage(PHOSA_OWNER_ID, { botId: CHIEF_ID })
    assert.equal(unchanged.value.items.length, before.value.items.length)

    const sent = await companySend(
      PHOSA_OWNER_ID,
      { botId: CHIEF_ID, text: '用一句话介绍你自己' },
      undefined,
      async (turn) => {
        assert.equal(turn.name, '主编')
        assert.equal(turn.text, '用一句话介绍你自己')
        return '这是模型的回答'
      },
    )
    assert.equal(sent.ok, true)
    const after = companyChatPage(PHOSA_OWNER_ID, { botId: CHIEF_ID })
    const user = after.value.items.find((item) => item.kind === 'user')
    const last = after.value.items.at(-1)
    assert.equal(user.text, '用一句话介绍你自己')
    assert.equal(last.kind, 'bot')
    assert.equal(last.text, '这是模型的回答')
    assert.doesNotMatch(last.text, /收到。写稿和数据都在侧栏/)

    const writer = await companySend(
      PHOSA_OWNER_ID,
      { botId: WRITER_ID, text: '写一段开头' },
      undefined,
      async (turn) => {
        assert.equal(turn.name, '写稿')
        return '模型写的开头'
      },
    )
    assert.equal(writer.ok, true)
    const ops = await companySend(
      PHOSA_OWNER_ID,
      { botId: OPS_ID, text: '今天的数字' },
      undefined,
      async (turn) => {
        assert.equal(turn.name, '数据')
        return '模型记下的数字'
      },
    )
    assert.equal(ops.ok, true)
  } finally {
    configureDataRoot(prev)
    await rm(dir, { recursive: true, force: true })
  }
})

test('model reply is the bot line after the user line, and the relay stays off the roster', () => {
  const prompt = 'Reply with the single word pong.'
  const reply = modelReplyAfter([
    { kind: 'bot', text: '你好，我先打个招呼。' },
    { kind: 'user', text: prompt },
    { kind: 'bot', text: 'pong' },
  ], prompt)
  assert.equal(reply, 'pong')
  assert.equal(modelReplyAfter([{ kind: 'bot', text: 'pong' }], prompt), '')
  const stripped = withoutRelayBots({
    bots: [
      { id: 'relay', name: COMPANY_RELAY_NAME },
      { id: 'kept', name: '主编' },
    ],
  })
  assert.deepEqual(stripped.bots.map((bot) => bot.name), ['主编'])
  assert.equal(withoutRelayBots({ unchanged: true }).unchanged, true)
})
