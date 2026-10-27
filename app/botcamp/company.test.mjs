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
import { COMPANY_MODEL_REF, COMPANY_RELAY_NAME, modelReplyAfter, modelTurnText, withoutRelayBots } from './companyModel.mjs'

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
    assert.deepEqual(state.accountHosts, ['xiaoheihe.cn'])
    assert.ok(state.rooms.some((r) => /小稿/.test(r.name)))
    const room = state.rooms.find((r) => /小稿/.test(r.name))
    assert.ok(Array.isArray(room.members) && room.members.includes(CHIEF_ID), 'rooms must expose members for DS Bot UI')
    assert.equal(isCompanySessionId(CHIEF_ID), true)
  } finally {
    configureDataRoot(prev)
    await rm(dir, { recursive: true, force: true })
  }
})

test('account and progress questions are passed to the model', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botcamp-co-'))
  const prev = getDataRoot()
  try {
    configureDataRoot(path.join(dir, 'media-store'))
    seed()
    const page = companyChatPage(PHOSA_OWNER_ID, { botId: CHIEF_ID })
    assert.equal(page.ok, true)
    assert.match(page.value.items[0].text, /主编/)
    assert.doesNotMatch(page.value.items[0].text, /报表|看板|白板/)

    const missed = await companySend(PHOSA_OWNER_ID, { botId: CHIEF_ID, text: '全部号进度' })
    assert.equal(missed.ok, false)
    assert.match(missed.error.message, /模型这次没有答上来/)

    const asked = []
    const complete = async (turn) => {
      asked.push(turn)
      return `模型回答：${turn.text}`
    }
    const prompts = [
      '全部号进度',
      '记下来：明天只改标题',
      '看一下进度',
      '我的账号是哪个平台',
      '现在什么数据',
      '你能看看我的账号现在什么数据给我截个图吗',
      '我的账号是什么',
      '我说现在',
    ]
    for (const text of prompts) {
      const sent = await companySend(PHOSA_OWNER_ID, { botId: CHIEF_ID, text }, undefined, complete)
      assert.equal(sent.ok, true)
      assert.equal(sent.value.docLink, null)
      const after = companyChatPage(PHOSA_OWNER_ID, { botId: CHIEF_ID })
      const user = after.value.items.at(-2)
      const last = after.value.items.at(-1)
      assert.equal(user.kind, 'user')
      assert.equal(user.text, text)
      assert.equal(last.kind, 'bot')
      assert.equal(last.text, `模型回答：${text}`)
      assert.doesNotMatch(last.text, /粉丝|doc:\/\/|小黑盒/)
    }
    assert.deepEqual(asked.map((turn) => turn.text), prompts)
    assert.equal(asked.length, prompts.length)
    for (const turn of asked) {
      assert.equal(turn.name, '主编')
      assert.match(turn.facts, /小稿的AI日记/)
      assert.match(turn.facts, /小黑盒/)
      assert.equal(turn.facts, asked[0].facts)
      const forwarded = modelTurnText(turn)
      assert.match(forwarded, new RegExp(turn.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      assert.match(forwarded, /账号事实/)
      assert.equal(modelReplyAfter([
        { kind: 'user', text: forwarded },
        { kind: 'bot', text: '模型写的平台说明' },
      ], forwarded), '模型写的平台说明')
    }
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

test('a desktop tool request stays off the transcript until the model answers', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botcamp-co-'))
  const prev = getDataRoot()
  try {
    configureDataRoot(path.join(dir, 'media-store'))
    seed()
    const tool = '{"tool":"browser_open","url":"https://www.xiaoheihe.cn/"}'
    const asked = []
    const pending = await companySend(
      PHOSA_OWNER_ID,
      { botId: CHIEF_ID, text: '帮我看一下后台', desktop: true },
      undefined,
      async (turn) => {
        asked.push(turn)
        return tool
      },
    )
    assert.equal(pending.ok, true)
    assert.equal(pending.value.tool.tool, 'browser_open')
    assert.deepEqual(pending.value.tool.hosts, ['xiaoheihe.cn'])
    assert.match(modelTurnText(asked[0]), /用户原话：\n帮我看一下后台/)
    assert.match(modelTurnText(asked[0]), /xiaoheihe\.cn/)
    assert.equal(asked[0].desktop, true)
    const stored = companyChatPage(PHOSA_OWNER_ID, { botId: CHIEF_ID })
    assert.equal(stored.value.items.at(-1).kind, 'user')
    assert.equal(stored.value.items.at(-1).text, '帮我看一下后台')
    assert.equal(stored.value.items.some((item) => item.text === tool), false)

    const done = await companySend(
      PHOSA_OWNER_ID,
      {
        botId: CHIEF_ID,
        text: '帮我看一下后台',
        desktop: true,
        resume: true,
        toolResult: { text: '页面 创作者中心\nhttps://www.xiaoheihe.cn/\n粉丝 12' },
      },
      undefined,
      async (turn) => {
        assert.match(turn.toolResult, /粉丝 12/)
        assert.match(modelTurnText(turn), /本机工具结果/)
        return '后台现在粉丝 12。'
      },
    )
    assert.equal(done.ok, true)
    assert.equal(done.value.tool, undefined)
    const after = companyChatPage(PHOSA_OWNER_ID, { botId: CHIEF_ID })
    const users = after.value.items.filter((item) => item.kind === 'user')
    assert.equal(users.length, 1)
    assert.equal(after.value.items.at(-1).text, '后台现在粉丝 12。')

    const website = await companySend(
      PHOSA_OWNER_ID,
      { botId: CHIEF_ID, text: '普通窗口' },
      undefined,
      async (turn) => (turn.toolResult ? '直接说：这是网页。' : tool),
    )
    assert.equal(website.ok, true)
    assert.equal(website.value.tool, undefined)
    const webItems = companyChatPage(PHOSA_OWNER_ID, { botId: CHIEF_ID }).value.items
    assert.equal(webItems.at(-1).text, '直接说：这是网页。')
    assert.equal(webItems.some((item) => item.text === tool), false)
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
