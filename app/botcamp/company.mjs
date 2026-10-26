/**
 * Company-chat mode: enter = see employees (主编 / 写稿 / 数据).
 * When a bot keeps something, it writes a markdown file and links it in chat.
 */
import { kvGet, kvSet } from '../../server/kv.mjs'
import { loadMediaAccountBundle } from '../../server/accountStore.mjs'
import { ensureMediaSeeded } from './mediaControl.mjs'
import { keepMarkdown } from './library.mjs'
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

function seedWelcome(ownerId, sessionId, accounts) {
  const items = loadChat(ownerId, sessionId)
  if (items.length > 0) return items
  const names = accounts.map((a) => a.display_name).join('、') || '（尚无账号）'
  let text
  if (sessionId === CHIEF_ID) {
    text = [
      '我是主编，也是总负责人。进门不用先选号——写稿和数据都在侧栏。',
      `目前在管：${names}。`,
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

/** Free-form markdown note. Not a schema and not a required outline. */
export function statusNote(ownerId, accountHint) {
  const picked = pickAccounts(ownerId, accountHint)
  if (picked.length === 0) {
    return { title: '进度', summary: '目前还没有自媒体号。', body: '目前还没有自媒体号。\n' }
  }
  const lines = []
  const bits = []
  for (const account of picked) {
    const bundle = loadMediaAccountBundle(account.id)
    lines.push(account.display_name)
    lines.push('')
    if (!bundle) {
      lines.push('暂时读不到这份记录。')
      lines.push('')
      continue
    }
    const funnel = bundle.board?.post_funnel || {}
    const followers = bundle.board?.followers_latest?.followers
    const parts = []
    if (followers != null) parts.push(`粉丝 ${fmt(followers)}`)
    for (const [key, count] of Object.entries(funnel)) {
      if (count) parts.push(`${key} ${count}`)
    }
    if (parts.length) {
      lines.push(`${parts.join('，')}。`)
      bits.push(`${account.display_name}：${parts.join('，')}`)
    }
    const titles = []
    for (const post of bundle.posts || []) {
      if (post?.title) titles.push(`- ${post.title}${post.status ? `（${post.status}）` : ''}`)
    }
    for (const manuscript of bundle.manuscripts || []) {
      if (manuscript?.title && (manuscript.status === '写稿中' || manuscript.status === '待确认')) {
        titles.push(`- ${manuscript.title}（${manuscript.status}）`)
      }
    }
    if (titles.length) lines.push(...titles.slice(0, 12))
    lines.push('')
  }
  const title = picked.length === 1 ? `${picked[0].display_name} 进度` : '全部号进度'
  return { title, summary: bits.join('\n') || '记了一笔进度。', body: `${lines.join('\n').trim()}\n` }
}

function wantsRemember(text) {
  return /记下来|记住|留档|写进文档|存成文档|帮我记/.test(text || '')
}

function stripRemember(text) {
  return String(text || '')
    .replace(/^(请)?(帮我)?(把这句|把这段|把)?(话)?(记下来|记住|保存一下|保存|留档|写进文档|存成文档)[了]?[：:，,\s]*/, '')
    .trim()
}

function wantsStatus(text) {
  return /进度|状态|漏斗|待你处理|怎么样了|概况|总览|帖子|稿件|看板/.test(text || '')
}

function replyWithDoc(ownerId, { title, body, summary }) {
  try {
    const kept = keepMarkdown(ownerId, { folderName: '笔记', name: title, content: body })
    if (!kept.link) return `${summary || '记下了。'}\n\n（文档没写成：${kept.error || '请稍后再试。'}）`
    return [summary, `[${kept.link.label}](${kept.link.href})`].filter(Boolean).join('\n\n')
  } catch {
    return `${summary || '记下了。'}\n\n（文档没写成，请稍后再试。）`
  }
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
  let docLink = null
  const roomAccountId = accountIdFromRoom(sessionId)
  if (wantsRemember(text)) {
    const body = stripRemember(text) || text
    const keptTitle = body.slice(0, 24) || '笔记'
    reply = replyWithDoc(ownerId, { title: keptTitle, body: `${body}\n`, summary: '记下了。' })
  } else if (wantsStatus(text) || (sessionId === CHIEF_ID && /号/.test(text))) {
    const hint = roomAccountId
      ? (accounts.find((a) => a.id === roomAccountId)?.display_name || null)
      : accountHintFromText(text, accounts)
    const note = statusNote(ownerId, hint)
    reply = replyWithDoc(ownerId, note)
  } else if (roomAccountId) {
    const account = accounts.find((a) => a.id === roomAccountId)
    const bundle = account ? loadMediaAccountBundle(account.id) : null
    const writing = (bundle?.board?.writing || []).slice(0, 3).map((p) => p.title).join('、') || '暂无进行中帖子'
    reply = [
      `收到。这个项目群跟进「${account?.display_name || '本号'}」。`,
      `写稿这边：${writing}。`,
      '要留下进度，直接说「本号进度」。',
    ].join('\n')
  } else if (sessionId === WRITER_ID) {
    reply = '好。改标题、补脚本找我。要留底就说「记下来」。全号进度可以问主编。'
  } else if (sessionId === OPS_ID) {
    reply = '好。排期、发布和数字我跟。要总览，跟主编说「全部号进度」。'
  } else {
    reply = '收到。写稿和数据都在侧栏。要留底就说「记下来」，要进度就说「全部号进度」。'
  }
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
