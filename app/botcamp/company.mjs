/**
 * Company-chat mode: enter = see employees; SoT stays under MediaAccount.
 * Status goes onto the whiteboard as table / article / icon kanban components.
 */
import { kvGet, kvSet } from '../../server/kv.mjs'
import { loadMediaAccountBundle } from '../../server/accountStore.mjs'
import { ensureMediaSeeded } from './mediaControl.mjs'
import { DEFAULT_TEAM } from './team.mjs'
import { placeKanban } from './whiteboard.mjs'

export const COMPANY_MODE = 'company-local'
export const CHIEF_ID = 'co_chief'
export const WRITER_ID = 'co_writer'
export const OPS_ID = 'co_ops'

const EMPLOYEES = Object.freeze([
  {
    id: CHIEF_ID,
    name: '总负责人',
    brief: DEFAULT_TEAM[0]?.brief
      || '协调写手与运营；问某个号或全部号的进度，我会把表格和文章落到看板上。',
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
  const members = [CHIEF_ID, WRITER_ID, OPS_ID]
  return {
    id,
    name: account.display_name,
    brief: `项目群 · ${platform} · 跟进本号进度与看板`,
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
    .replaceAll('进度汇报', '看板更新')
    .replaceAll('出个报表', '更新看板')
    .replaceAll('出报表', '更新看板')
    .replaceAll('本号报表', '本号看板')
    .replaceAll('全部号报表', '全部号进度')
    .replaceAll('报表面板', '白板')
    .replaceAll('号报表', '看板')
    .replaceAll('报表', '看板')
}

function loadChat(ownerId, sessionId) {
  const saved = kvGet(chatKey(ownerId, sessionId))
  if (!Array.isArray(saved?.items)) return []
  let dirty = false
  const items = saved.items.map((item) => {
    if (typeof item?.text !== 'string' || !item.text.includes('报表')) return item
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

function seedWelcome(ownerId, sessionId, accounts) {
  const items = loadChat(ownerId, sessionId)
  if (items.length > 0) return items
  const names = accounts.map((a) => a.display_name).join('、') || '（尚无账号）'
  let text
  if (sessionId === CHIEF_ID) {
    text = [
      '我是总负责人。进公司不用先选号——写手和运营都在侧栏。',
      `目前在管：${names}。`,
      '问「全部号进度」或「小稿看板」，我会把漏斗表、待你处理文章落到右侧白板上。',
    ].join('\n')
  } else if (sessionId === WRITER_ID) {
    text = '我是写手。定稿、改标题、补脚本找我；跨号进度也可以让总负责人汇总到看板。'
  } else if (sessionId === OPS_ID) {
    text = '我是运营。排期、发布闸门、粉丝与互动数据我这边跟；要总览找总负责人更新看板。'
  } else {
    const account = accounts.find((a) => roomIdForAccount(a.id) === sessionId)
    const bundle = account ? loadMediaAccountBundle(account.id) : null
    const funnel = bundle?.board?.post_funnel || {}
    const bits = Object.entries(funnel).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(' · ')
    text = [
      `【项目群】${account?.display_name || '未命名号'}`,
      bits ? `当前漏斗：${bits}` : '漏斗暂无帖子。',
      '在这个群里追问进度，或让总负责人把本号落到看板上。',
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

function pickAccounts(ownerId, accountHint) {
  ensureMediaSeeded()
  const accounts = listOwnerAccounts(ownerId)
  if (!accountHint) return accounts
  const hint = String(accountHint).toLowerCase()
  const match = accounts.filter((a) =>
    a.display_name.toLowerCase().includes(hint)
    || a.id.toLowerCase().includes(hint)
    || (a.handle && String(a.handle).toLowerCase().includes(hint)))
  return match.length ? match : accounts
}

/** Build kanban columns + summary table from MediaAccount SoT. */
export function buildStatusKanban(ownerId, { accountHint } = {}) {
  const picked = pickAccounts(ownerId, accountHint)
  if (picked.length === 0) {
    return {
      heading: '公司看板',
      columns: [],
      table: { title: '汇总表', columns: ['说明'], rows: [['目前还没有任何自媒体号落在 SoT 里。']] },
      summary: '目前还没有任何自媒体号落在 SoT 里。',
    }
  }

  const needsItems = []
  const writingItems = []
  const publishedItems = []
  const topicItems = []
  const tableRows = []

  for (const account of picked) {
    const bundle = loadMediaAccountBundle(account.id)
    if (!bundle) {
      tableRows.push([account.display_name, '—', '读不到 SoT', '—', '—'])
      continue
    }
    const { board, posts, manuscripts } = bundle
    const funnel = board.post_funnel || {}
    tableRows.push([
      account.display_name,
      account.platform === 'xiaoheihe' ? '小黑盒' : (account.platform || '—'),
      fmt(board.followers_latest?.followers),
      String(funnel['已发布'] || 0),
      String((funnel['选题'] || 0) + (funnel['写稿中'] || 0) + (funnel['待确认'] || 0)),
    ])

    for (const p of posts || []) {
      if (p.status === '待确认' || p.status === '选题') {
        needsItems.push({
          title: p.title || '未命名帖',
          body: `${account.display_name} · 帖 · ${p.status}`,
        })
      }
      if (p.status === '选题') {
        topicItems.push({
          title: p.title || '未命名选题',
          body: `${account.display_name} · 选题`,
        })
      }
      if (p.status === '已发布') {
        publishedItems.push({
          title: p.title || '已发布帖',
          body: `${account.display_name} · 已发布`,
        })
      }
    }
    for (const m of manuscripts || []) {
      if (!m.final_review_passed && (m.status === '写稿中' || m.status === '待确认')) {
        needsItems.push({
          title: m.title || '未命名稿',
          body: `${account.display_name} · 稿 · 终审未过`,
        })
      }
    }
    for (const p of (board.writing || []).slice(0, 8)) {
      writingItems.push({
        title: p.title || '写稿中',
        body: `${account.display_name} · ${p.status || '写稿中'}`,
      })
    }
  }

  const heading = picked.length === listOwnerAccounts(ownerId).length
    ? `全部 ${picked.length} 个号 · 看板`
    : `${picked.map((a) => a.display_name).join('、')} · 看板`

  return {
    heading,
    columns: [
      { name: '待你处理', icon: 'alert', items: needsItems.slice(0, 8) },
      { name: '选题', icon: 'draft', items: topicItems.slice(0, 8) },
      { name: '写稿中', icon: 'post', items: writingItems.slice(0, 8) },
      { name: '已发布', icon: 'ok', items: publishedItems.slice(0, 8) },
    ],
    table: {
      title: '账号汇总表',
      columns: ['账号', '平台', '粉丝', '已发布', '在制'],
      rows: tableRows,
    },
    summary: `${heading}：待你处理 ${needsItems.length} · 选题 ${topicItems.length} · 写稿中 ${writingItems.length} · 已发布 ${publishedItems.length}`,
  }
}

function wantsBoardUpdate(text) {
  return /看板|进度|状态|漏斗|needs\s*you|待你处理|怎么样了|概况|总览|帖子|稿/i.test(text || '')
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
  ensureMediaSeeded()
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
  let boardLink = null
  const roomAccountId = accountIdFromRoom(sessionId)
  if (wantsBoardUpdate(text) || (sessionId === CHIEF_ID && /号|看板/.test(text))) {
    const hint = roomAccountId
      ? (accounts.find((a) => a.id === roomAccountId)?.display_name || null)
      : accountHintFromText(text, accounts)
    const kanban = buildStatusKanban(ownerId, { accountHint: hint })
    try {
      const placed = placeKanban(ownerId, {
        sessionId,
        category: hint || '公司',
        heading: kanban.heading,
        columns: kanban.columns,
        table: kanban.table,
        createdBy: '总负责人',
      })
      boardLink = placed.link
      reply = [
        kanban.summary,
        '已更新右侧白板：表格 + 文章卡片 + 栏目标记（图标）。',
        boardLink ? `[${boardLink.label}](${boardLink.href})` : '',
      ].filter(Boolean).join('\n\n')
    } catch {
      reply = `${kanban.summary}\n\n（看板落板失败，请稍后重试打开白板。）`
    }
  } else if (roomAccountId) {
    const account = accounts.find((a) => a.id === roomAccountId)
    const bundle = account ? loadMediaAccountBundle(account.id) : null
    const writing = (bundle?.board?.writing || []).slice(0, 3).map((p) => p.title).join('、') || '暂无进行中帖子'
    reply = [
      `收到。这个项目群跟进「${account?.display_name || '本号'}」。`,
      `写手侧：${writing}。`,
      '要看板视图，直接说「本号进度」或「更新看板」。',
    ].join('\n')
  } else if (sessionId === WRITER_ID) {
    reply = '好。跨号产量我可以按稿状态列，全盘进度让总负责人更新看板更清楚。你也可以说「我负责的号进度」。'
  } else if (sessionId === OPS_ID) {
    reply = '好。发布闸门和数据我跟。要粉丝与漏斗总览，跟总负责人说「全部号进度」即可。'
  } else {
    reply = [
      '收到。写手和运营都在侧栏；某个号可以进对应项目群跟进。',
      '需要看板时直接说「全部号进度」或「小稿看板」。',
    ].join('\n')
  }

  items.push({ kind: 'bot', text: reply, time: now + 1 })
  saveChat(ownerId, sessionId, items)
  return { ok: true, value: { sent: true, sessionId, boardLink } }
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
  return {
    ...state,
    bots: presentChiefName(state.bots),
    rooms,
  }
}
