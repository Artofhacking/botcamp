/**
 * Company-chat mode: enter = see employees; SoT stays under MediaAccount.
 * Local roster + transcripts when the kernel is unavailable; reports use real SoT.
 */
import { kvGet, kvSet } from '../../server/kv.mjs'
import { loadMediaAccountBundle } from '../../server/accountStore.mjs'
import { DEFAULT_TEAM } from './team.mjs'

export const COMPANY_MODE = 'company-local'
export const CHIEF_ID = 'co_chief'
export const WRITER_ID = 'co_writer'
export const OPS_ID = 'co_ops'

const EMPLOYEES = Object.freeze([
  {
    id: CHIEF_ID,
    name: '总负责人',
    brief: DEFAULT_TEAM[0]?.brief
      || '协调写手与运营；你问某个号或全部号的状态，我整理报表与进度汇报。',
    color: 'blue',
    avatar: { shape: 'star' },
  },
  {
    id: WRITER_ID,
    name: '写手',
    brief: DEFAULT_TEAM[1]?.brief || '负责生产文稿与脚本。',
    color: 'green',
    avatar: { shape: 'moon' },
  },
  {
    id: OPS_ID,
    name: '运营',
    brief: DEFAULT_TEAM[2]?.brief || '负责排期、发布与账号数据。',
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
    model: null,
    waiting: false,
    createdAt: 1,
  }
}

function roomShape(account) {
  const id = roomIdForAccount(account.id)
  const platform = account.platform === 'xiaoheihe' ? '小黑盒' : (account.platform || '')
  return {
    id,
    name: account.display_name,
    brief: `项目群 · ${platform} · 跟进本号进度与报表`,
    sessionId: id,
    memberIds: [CHIEF_ID, WRITER_ID, OPS_ID],
    createdAt: 2,
    named: true,
  }
}

function chatKey(ownerId, sessionId) {
  return `company:${ownerId}:chat:${sessionId}`
}

function loadChat(ownerId, sessionId) {
  const saved = kvGet(chatKey(ownerId, sessionId))
  return Array.isArray(saved?.items) ? saved.items : []
}

function saveChat(ownerId, sessionId, items) {
  kvSet(chatKey(ownerId, sessionId), {
    sessionId,
    owner_user_id: ownerId,
    items,
    updated_at: new Date().toISOString(),
  })
}

function seedWelcome(ownerId, sessionId, accounts) {
  const items = loadChat(ownerId, sessionId)
  if (items.length > 0) return items
  const names = accounts.map((a) => a.display_name).join('、') || '（尚无账号）'
  let text
  if (sessionId === CHIEF_ID) {
    text = [
      '我是总负责人。进公司不用先选号——写手和运营都在侧栏。',
      `目前在管：${names}。`,
      '你可以直接问「全部号进度」「小稿出个报表」，或点开某个项目群看该号跟进。',
    ].join('\n')
  } else if (sessionId === WRITER_ID) {
    text = '我是写手。定稿、改标题、补脚本找我；跨号进度也可以让总负责人汇总。'
  } else if (sessionId === OPS_ID) {
    text = '我是运营。排期、发布闸门、粉丝与互动数据我这边跟；要总览找总负责人出报表。'
  } else {
    const account = accounts.find((a) => roomIdForAccount(a.id) === sessionId)
    const bundle = account ? loadMediaAccountBundle(account.id) : null
    const funnel = bundle?.board?.post_funnel || {}
    const bits = Object.entries(funnel).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(' · ')
    text = [
      `【项目群】${account?.display_name || '未命名号'}`,
      bits ? `当前漏斗：${bits}` : '漏斗暂无帖子。',
      '在这个群里追问进度，或让总负责人出本号报表。',
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

function reportForAccount(account) {
  const bundle = loadMediaAccountBundle(account.id)
  if (!bundle) return `## ${account.display_name}\n（读不到 SoT）`
  const { board, posts, manuscripts } = bundle
  const funnel = board.post_funnel || {}
  const funnelLine = ['选题', '写稿中', '待确认', '已发布', '被隐藏', '搁置']
    .map((k) => `${k} ${funnel[k] || 0}`)
    .join(' · ')
  const needs = []
  for (const p of posts || []) {
    if (p.status === '待确认' || p.status === '选题') needs.push(`- 帖「${p.title}」· ${p.status}`)
  }
  for (const m of manuscripts || []) {
    if (!m.final_review_passed && (m.status === '写稿中' || m.status === '待确认')) {
      needs.push(`- 稿「${m.title}」· 终审未过`)
    }
  }
  const writing = (board.writing || []).slice(0, 5).map((p) => `- ${p.title} · ${p.status}`).join('\n')
  return [
    `## ${account.display_name}`,
    `${account.platform === 'xiaoheihe' ? '小黑盒' : account.platform} · ${account.status}`,
    `粉丝 ${fmt(board.followers_latest?.followers)} · KPI ¥${board.revenue_kpi_cny}`,
    `漏斗：${funnelLine}`,
    needs.length ? `Needs you（${needs.length}）\n${needs.slice(0, 8).join('\n')}` : 'Needs you：无',
    writing ? `进行中\n${writing}` : '进行中：无',
  ].join('\n')
}

export function buildProgressReport(ownerId, { accountHint } = {}) {
  const accounts = listOwnerAccounts(ownerId)
  if (accounts.length === 0) return '目前还没有任何自媒体号落在 SoT 里。'
  let picked = accounts
  if (accountHint) {
    const hint = String(accountHint).toLowerCase()
    const match = accounts.filter((a) =>
      a.display_name.toLowerCase().includes(hint)
      || a.id.toLowerCase().includes(hint)
      || (a.handle && String(a.handle).toLowerCase().includes(hint)))
    if (match.length) picked = match
  }
  const header = picked.length === accounts.length
    ? `【进度汇报 · 全部 ${picked.length} 个号】`
    : `【进度汇报 · ${picked.map((a) => a.display_name).join('、')}】`
  return [header, '', ...picked.map((a) => reportForAccount(a))].join('\n\n')
}

function wantsReport(text) {
  return /报表|进度|汇报|状态|漏斗|needs\s*you|怎么样了|概况|总览/i.test(text || '')
}

function accountHintFromText(text, accounts) {
  const raw = String(text || '')
  if (/全部|所有号|全盘|整体/.test(raw)) return null
  for (const a of accounts) {
    if (a.display_name && raw.includes(a.display_name)) return a.display_name
    if (a.handle && raw.includes(a.handle)) return a.handle
  }
  if (/小稿/.test(raw)) {
    const hit = accounts.find((a) => /小稿/.test(a.display_name || ''))
    if (hit) return hit.display_name
  }
  return null
}

export function claimCompanyAccess(access, ownerId) {
  for (const member of EMPLOYEES) {
    access.claim(member.id, 'bot')
    access.claim(member.id, 'session', member.id)
  }
  for (const account of listOwnerAccounts(ownerId)) {
    const id = roomIdForAccount(account.id)
    access.claim(id, 'room')
    access.claim(id, 'session', id)
  }
}

export function buildCompanyState(ownerId, user) {
  const accounts = listOwnerAccounts(ownerId)
  const bots = EMPLOYEES.map(botShape)
  const rooms = accounts.map(roomShape)
  // Warm welcome threads so the company feels occupied on first open.
  for (const bot of bots) seedWelcome(ownerId, bot.id, accounts)
  for (const room of rooms) seedWelcome(ownerId, room.id, accounts)
  const mainBotIds = [CHIEF_ID]
  return {
    revision: Date.now(),
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
    models: [],
    defaultModel: null,
    modelsKey: `company:${COMPANY_MODE}`,
    prefs: { ...(user?.prefs ?? {}) },
    activity: {},
    memoryNews: {},
    work: { bots: {}, approvals: [] },
    connectors: [],
    companyMode: COMPANY_MODE,
  }
}

export function companyChatPage(ownerId, payload) {
  const sessionId = payload?.botId || payload?.sessionId
  if (!isCompanySessionId(sessionId)) {
    return { ok: false, error: { message: '不是公司会话。' } }
  }
  const accounts = listOwnerAccounts(ownerId)
  const items = seedWelcome(ownerId, sessionId, accounts)
  return { ok: true, value: { sessionId, items, cursor: null } }
}

export function companySend(ownerId, payload) {
  const sessionId = payload?.botId || payload?.sessionId
  const text = typeof payload?.text === 'string' ? payload.text.trim() : ''
  if (!isCompanySessionId(sessionId) || !text) {
    return { ok: false, error: { message: '无法发送。' } }
  }
  const accounts = listOwnerAccounts(ownerId)
  const items = seedWelcome(ownerId, sessionId, accounts)
  const now = Date.now()
  items.push({ kind: 'user', text, time: now })

  let reply
  const roomAccountId = accountIdFromRoom(sessionId)
  if (wantsReport(text) || sessionId === CHIEF_ID && /号/.test(text)) {
    const hint = roomAccountId
      ? (accounts.find((a) => a.id === roomAccountId)?.display_name || null)
      : accountHintFromText(text, accounts)
    reply = buildProgressReport(ownerId, { accountHint: hint })
    reply += '\n\n——\n（公司本地汇报：数字来自 MediaAccount SoT。内核模型通路接通后，总负责人可改为模型编排+同一套 SoT。）'
  } else if (roomAccountId) {
    const account = accounts.find((a) => a.id === roomAccountId)
    const bundle = account ? loadMediaAccountBundle(account.id) : null
    const writing = (bundle?.board?.writing || []).slice(0, 3).map((p) => p.title).join('、') || '暂无进行中帖子'
    reply = [
      `收到。这个项目群跟进「${account?.display_name || '本号'}」。`,
      `写手侧：${writing}。`,
      '要完整漏斗与 Needs you，直接说「出个报表」或「进度汇报」。',
    ].join('\n')
  } else if (sessionId === WRITER_ID) {
    reply = '好。跨号产量我可以按稿状态列，但全盘进度还是让总负责人出报表更清楚。你也可以说「我负责的号进度」。'
  } else if (sessionId === OPS_ID) {
    reply = '好。发布闸门和数据我跟。要粉丝/收益/事件总览，跟总负责人说「全部号报表」即可。'
  } else {
    reply = [
      '收到。写手和运营都在侧栏；某个号可以进对应项目群跟进。',
      '需要数字时直接说「全部号进度」或「小稿出个报表」。',
    ].join('\n')
  }

  items.push({ kind: 'bot', text: reply, time: now + 1 })
  saveChat(ownerId, sessionId, items)
  return { ok: true, value: { sent: true, sessionId } }
}

/** Rename legacy duty bot label when kernel still returns 主编. */
export function presentChiefName(bots) {
  if (!Array.isArray(bots)) return bots
  return bots.map((bot) => {
    if (bot?.name === '主编') return { ...bot, name: '总负责人', brief: bot.brief || EMPLOYEES[0].brief }
    return bot
  })
}

export function mergeProjectRooms(state, ownerId, access) {
  if (!state || typeof state !== 'object' || state.unchanged) return state
  const accounts = listOwnerAccounts(ownerId)
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
  const bots = presentChiefName(state.bots)
  let mainBotIds = Array.isArray(state.mainBotIds) ? [...state.mainBotIds] : []
  const chief = bots.find((b) => b.name === '总负责人')
  if (chief && !mainBotIds.includes(chief.id)) mainBotIds = [chief.id, ...mainBotIds]
  return {
    ...state,
    bots,
    rooms,
    mainBotId: mainBotIds[0] ?? state.mainBotId ?? null,
    mainBotIds,
  }
}
