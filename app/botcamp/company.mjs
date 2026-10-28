/**
 * Company-chat mode: enter = see employees (主编 / 写稿 / 数据).
 * When a bot keeps something, it writes a markdown file and links it in chat.
 */
import { kvGet, kvSet } from '../../server/kv.mjs'
import { loadMediaAccountBundle } from '../../server/accountStore.mjs'
import { accountsVisibleTo, ensureMediaSeeded, primaryChatOwnerId } from './mediaControl.mjs'
import { COMPANY_MODEL_REF, COMPANY_MODELS } from './companyModel.mjs'
import { clipToolResult, hostsForAccounts, parseDesktopTool } from './desktopTurn.mjs'
import { DEFAULT_TEAM } from './team.mjs'

export const COMPANY_MODE = 'company-local'
export const CHIEF_ID = 'co_chief'
export const WRITER_ID = 'co_writer'
export const OPS_ID = 'co_ops'

const EMPLOYEES = Object.freeze([
  {
    id: CHIEF_ID,
    name: '主编',
    brief: DEFAULT_TEAM[0]?.brief
      || '总负责人。负责判断，并把要留下的内容写成文档。',
    color: 'blue',
    avatar: { shape: 'star' },
  },
  {
    id: WRITER_ID,
    name: '写稿',
    brief: DEFAULT_TEAM[1]?.brief || '负责把选题写成稿。',
    color: 'green',
    avatar: { shape: 'moon' },
  },
  {
    id: OPS_ID,
    name: '数据',
    brief: DEFAULT_TEAM[2]?.brief || '负责排期、发布和账号数据。',
    color: 'orange',
    avatar: { shape: 'wave' },
  },
])

export function isCompanySessionId(id) {
  return typeof id === 'string' && (id.startsWith('co_') || id.startsWith('co_room_'))
}

function roomIdForAccount(accountId) {
  return `co_room_${accountId}`
}

function accountIdFromRoom(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId.startsWith('co_room_')) return null
  return sessionId.slice('co_room_'.length)
}

function listOwnerAccounts(ownerId) {
  const ids = kvGet(`owner:${ownerId}:media_accounts`) || []
  return ids
    .map((id) => kvGet(`media_account:${id}`))
    .filter((a) => a && !a.deleted_at && a.owner_user_id === ownerId)
}

function botShape(member) {
  return {
    id: member.id,
    name: member.name,
    brief: member.brief,
    instructions: member.brief,
    color: member.color,
    avatar: member.avatar,
    sessionId: member.id,
    parts: [member.id],
    model: COMPANY_MODEL_REF,
    waiting: false,
    createdAt: 1,
  }
}

function roomShape(account) {
  const id = roomIdForAccount(account.id)
  const platform = account.platform === 'xiaoheihe' ? '小黑盒' : (account.platform || '')
  const members = [CHIEF_ID, WRITER_ID, OPS_ID]
  return {
    id,
    name: account.display_name,
    brief: `项目群 · ${platform}`,
    sessionId: id,
    // DS Bot sidebar / RoomAvatar expect `members` (ids), not memberIds.
    members,
    memberIds: members,
    createdAt: 2,
    named: true,
  }
}

function chatKey(ownerId, sessionId) {
  return `company:${ownerId}:chat:${sessionId}`
}

function scrubLegacyCopy(text) {
  if (typeof text !== 'string') return text
  return text
    .replaceAll('进度汇报', '进度')
    .replaceAll('出个报表', '记一笔')
    .replaceAll('出报表', '记一笔')
    .replaceAll('本号报表', '本号进度')
    .replaceAll('全部号报表', '全部号进度')
    .replaceAll('报表面板', '文档库')
    .replaceAll('号报表', '进度')
    .replaceAll('报表', '文档')
    .replaceAll('右侧白板', '文档库')
    .replaceAll('打开白板', '打开文档')
    .replaceAll('白板', '文档库')
    .replaceAll('看板', '文档')
}

function loadChat(ownerId, sessionId) {
  const saved = kvGet(chatKey(ownerId, sessionId))
  if (!Array.isArray(saved?.items)) return []
  let dirty = false
  const items = saved.items.map((item) => {
    if (typeof item?.text !== 'string' || !/报表|看板|白板/.test(item.text)) return item
    dirty = true
    return { ...item, text: scrubLegacyCopy(item.text) }
  })
  if (dirty) saveChat(ownerId, sessionId, items)
  return items
}

function saveChat(ownerId, sessionId, items) {
  kvSet(chatKey(ownerId, sessionId), {
    sessionId,
    owner_user_id: ownerId,
    items,
    updated_at: new Date().toISOString(),
  })
}

function userTurns(items) {
  return (Array.isArray(items) ? items : []).filter((item) => item?.kind === 'user').length
}

/** Keep a transcript another instance already stored when this disk does not have it yet. */
export function adoptCompanyTranscript(ownerId, sessionId, items) {
  if (!isCompanySessionId(sessionId) || !Array.isArray(items) || items.length === 0) return false
  const local = loadChat(ownerId, sessionId)
  const remoteUsers = userTurns(items)
  const localUsers = userTurns(local)
  const newer = remoteUsers > localUsers
    || (remoteUsers === localUsers && items.length > local.length)
    || (remoteUsers === localUsers && items.length === local.length && (Number(items.at(-1)?.time) || 0) > (Number(local.at(-1)?.time) || 0))
  if (!newer && local.length > 0) return false
  saveChat(ownerId, sessionId, items.map((item) => ({ ...item })))
  return true
}

function managedLine(accounts) {
  const names = (Array.isArray(accounts) ? accounts : [])
    .map((account) => account?.display_name)
    .filter(Boolean)
    .join('、') || '（尚无账号）'
  return `目前在管：${names}。`
}

function seedWelcome(ownerId, sessionId, accounts) {
  const items = loadChat(ownerId, sessionId)
  if (items.length > 0) {
    if (sessionId !== CHIEF_ID) return items
    const first = items[0]
    if (first?.kind !== 'bot' || typeof first.text !== 'string' || !first.text.includes('目前在管：')) return items
    const next = first.text.replace(/目前在管：[^\n]*。/, managedLine(accounts))
    if (next === first.text) return items
    const updated = [{ ...first, text: next }, ...items.slice(1)]
    saveChat(ownerId, sessionId, updated)
    return updated
  }
  let text
  if (sessionId === CHIEF_ID) {
    text = [
      '我是主编，也是总负责人。进门不用先选号——写稿和数据都在侧栏。',
      managedLine(accounts),
      '问进度，或说「记下来」，我会写成文档。链接在这条对话里，点开就能看、能改。',
    ].join('\n')
  } else if (sessionId === WRITER_ID) {
    text = '我是写稿。定稿、改标题、补脚本找我。要留下的话，告诉我「记下来」。'
  } else if (sessionId === OPS_ID) {
    text = '我是数据。排期、发布和账号数字我这边跟。要总览，跟主编说「全部号进度」。'
  } else {
    const account = accounts.find((a) => roomIdForAccount(a.id) === sessionId)
    const bundle = account ? loadMediaAccountBundle(account.id) : null
    const funnel = bundle?.board?.post_funnel || {}
    const bits = Object.entries(funnel).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(' · ')
    text = [
      account?.display_name || '未命名号',
      bits ? `当前：${bits}` : '还没有帖子记录。',
      '在这里跟进这个号。要留下文字，跟主编说「记下来」。',
    ].join('\n')
  }
  const welcome = [{ kind: 'bot', text, time: Date.now() - 1000 }]
  saveChat(ownerId, sessionId, welcome)
  return welcome
}

function fmt(n) {
  if (n == null) return '—'
  return Number(n).toLocaleString('zh-CN')
}

function platformLabel(account) {
  if (account?.platform === 'xiaoheihe') return '小黑盒'
  return account?.platform || ''
}

/** Facts for the model instructions. Every turn gets them; nothing here picks a reply. */
export function accountFacts(accounts) {
  if (!Array.isArray(accounts) || accounts.length === 0) return '目前没有自媒体号。'
  return accounts.map((account) => {
    const bundle = loadMediaAccountBundle(account?.id)
    const funnel = bundle?.board?.post_funnel || {}
    const followers = bundle?.board?.followers_latest?.followers
    const parts = []
    if (followers != null) parts.push(`粉丝 ${fmt(followers)}`)
    for (const [key, count] of Object.entries(funnel)) {
      if (count) parts.push(`${key} ${count}`)
    }
    const where = platformLabel(account)
    const head = where ? `${account.display_name}，平台 ${where}` : account.display_name
    return parts.length ? `${head}。${parts.join('，')}。` : `${head}。`
  }).join('\n')
}

export function claimCompanyAccess(access, ownerId, accounts) {
  for (const id of companySessionIds(ownerId, accounts)) {
    if (id.startsWith('co_room_')) {
      access.claim(id, 'room')
      access.claim(id, 'session', id)
    } else {
      access.claim(id, 'bot')
      access.claim(id, 'session', id)
    }
  }
}

/** Sessions the host must see on the workspace, or it keeps listing. */
export function companySessionIds(ownerId, accounts) {
  ensureMediaSeeded()
  const visible = Array.isArray(accounts) ? accounts : listOwnerAccounts(ownerId)
  const ids = EMPLOYEES.map((member) => member.id)
  for (const account of visible) ids.push(roomIdForAccount(account.id))
  return ids
}

export function viewerCompany(user) {
  return {
    chatOwnerId: primaryChatOwnerId(user),
    accounts: accountsVisibleTo(user),
  }
}

function visibleAccounts(ownerId, accounts) {
  return Array.isArray(accounts) ? accounts : listOwnerAccounts(ownerId)
}

function sessionVisible(sessionId, accounts) {
  if (sessionId === CHIEF_ID || sessionId === WRITER_ID || sessionId === OPS_ID) return true
  const accountId = accountIdFromRoom(sessionId)
  if (!accountId) return false
  return accounts.some((account) => account.id === accountId)
}

export function buildCompanyState(ownerId, user, accounts) {
  ensureMediaSeeded()
  const visible = visibleAccounts(ownerId, accounts)
  const bots = EMPLOYEES.map(botShape)
  const rooms = visible.map(roomShape)
  // Warm welcome threads so the company feels occupied on first open.
  for (const bot of bots) seedWelcome(ownerId, bot.id, visible)
  for (const room of rooms) seedWelcome(ownerId, room.id, visible)
  const mainBotIds = [CHIEF_ID]
  return {
    // Stable so a later poll does not look like a new roster and retrigger listing.
    revision: 2 + rooms.length,
    unchanged: false,
    mainBotId: CHIEF_ID,
    mainBotIds,
    bots,
    rooms,
    agents: [],
    exchangeTurns: {},
    questions: {},
    secrets: [],
    capabilities: [],
    capabilityStatuses: {},
    secretRequests: {},
    models: COMPANY_MODELS.map(model => ({ ...model, input: [...model.input] })),
    defaultModel: COMPANY_MODEL_REF,
    modelsKey: `company:${COMPANY_MODE}:qoder`,
    accountHosts: hostsForAccounts(visible),
    prefs: { ...(user?.prefs ?? {}) },
    activity: {},
    memoryNews: {},
    work: { bots: {}, approvals: [] },
    connectors: [],
    companyMode: COMPANY_MODE,
  }
}

export function companyChatPage(ownerId, payload, accounts) {
  const sessionId = payload?.botId || payload?.sessionId
  if (!isCompanySessionId(sessionId)) {
    return { ok: false, error: { message: '不是公司会话。' } }
  }
  const visible = visibleAccounts(ownerId, accounts)
  if (!sessionVisible(sessionId, visible)) {
    return { ok: false, error: { message: '无法打开这个对话。' } }
  }
  const items = seedWelcome(ownerId, sessionId, visible)
  return { ok: true, value: { sessionId, items, cursor: null } }
}

function speakerFor(sessionId) {
  if (sessionId === WRITER_ID) return EMPLOYEES.find(member => member.id === WRITER_ID)
  if (sessionId === OPS_ID) return EMPLOYEES.find(member => member.id === OPS_ID)
  return EMPLOYEES.find(member => member.id === CHIEF_ID)
}

const MODEL_MISSED = '模型这次没有答上来。'

export async function companySend(ownerId, payload, accounts, complete) {
  const sessionId = payload?.botId || payload?.sessionId
  const text = typeof payload?.text === 'string' ? payload.text.trim() : ''
  if (!isCompanySessionId(sessionId) || !text) {
    return { ok: false, error: { message: '无法发送。' } }
  }
  const visible = visibleAccounts(ownerId, accounts)
  if (!sessionVisible(sessionId, visible)) {
    return { ok: false, error: { message: '无法打开这个对话。' } }
  }
  const items = seedWelcome(ownerId, sessionId, visible)
  const now = Date.now()
  const desktop = payload?.desktop === true
  const resume = desktop && payload?.resume === true
  const hosts = hostsForAccounts(visible)

  // Written before the model runs. A late or missing reply must not drop the line.
  if (!resume) {
    items.push({ kind: 'user', text, time: now })
    saveChat(ownerId, sessionId, items)
  }

  if (typeof complete !== 'function') {
    return { ok: false, error: { message: MODEL_MISSED } }
  }
  const speaker = speakerFor(sessionId)
  const ask = (extra) => complete({
    sessionId,
    text,
    name: speaker.name,
    brief: speaker.brief,
    facts: accountFacts(visible),
    desktop: extra.desktop,
    hosts,
    toolResult: extra.toolResult || '',
  })
  let reply
  try {
    reply = await ask({
      desktop,
      toolResult: resume ? clipToolResult(payload?.toolResult) : '',
    })
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    return { ok: false, error: { message: MODEL_MISSED } }
  }
  if (typeof reply !== 'string' || !reply.trim()) {
    return { ok: false, error: { message: MODEL_MISSED } }
  }
  reply = reply.trim()
  // A website window has no local browser. Ask once for a normal answer.
  if (!desktop && parseDesktopTool(reply)) {
    try {
      reply = await ask({
        desktop: false,
        toolResult: '当前窗口没有本机浏览器。请直接用文字回答，不要输出工具 JSON。',
      })
    } catch (error) {
      if (error?.name === 'AbortError') throw error
      return { ok: false, error: { message: MODEL_MISSED } }
    }
    if (typeof reply !== 'string' || !reply.trim() || parseDesktopTool(reply)) {
      return { ok: false, error: { message: MODEL_MISSED } }
    }
    reply = reply.trim()
  }
  const tool = desktop ? parseDesktopTool(reply) : null
  if (tool) {
    return { ok: true, value: { sent: true, sessionId, tool: { ...tool, hosts }, docLink: null } }
  }
  let docLink = null
  const linked = reply.match(/doc:\/\/(doc_[a-f0-9]+)/)
  if (linked) docLink = { href: `doc://${linked[1]}` }
  items.push({ kind: 'bot', text: reply, time: now + 1 })
  saveChat(ownerId, sessionId, items)
  return { ok: true, value: { sent: true, sessionId, docLink } }
}

const LEGACY_DUTY = {
  总负责人: '主编',
  写手: '写稿',
  运营: '数据',
}

/** Show the current duty names when the kernel still has the old labels. */
export function presentChiefName(bots) {
  if (!Array.isArray(bots)) return bots
  return bots.map((bot) => {
    const name = LEGACY_DUTY[bot?.name]
    if (!name) return bot
    const member = EMPLOYEES.find((item) => item.name === name)
    return { ...bot, name, brief: member?.brief || bot.brief }
  })
}

export function mergeProjectRooms(state, user, access) {
  if (!state || typeof state !== 'object' || state.unchanged) return state
  const accounts = user && typeof user === 'object' ? accountsVisibleTo(user) : []
  const rooms = Array.isArray(state.rooms) ? [...state.rooms] : []
  const have = new Set(rooms.map((r) => r.id))
  for (const account of accounts) {
    const room = roomShape(account)
    if (have.has(room.id)) continue
    access.claim(room.id, 'room')
    access.claim(room.id, 'session', room.id)
    rooms.push(room)
    have.add(room.id)
  }
  return {
    ...state,
    bots: presentChiefName(state.bots),
    rooms,
    accountHosts: hostsForAccounts(accounts),
  }
}
