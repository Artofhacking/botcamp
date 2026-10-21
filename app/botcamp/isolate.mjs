// Isolation sits in front of the single-tenant kernel. Resource ids are claimed
// only when this user creates them (or when they show up on a bot they already
// own). Reads of the shared roster are filtered before they reach the browser.
// Model configuration never reaches the kernel. Workspace files stay in this
// account's directory.

import { freezeProviders, isModelWrite, MODEL_MESSAGE, scopeConnectors, scopeUsage, stripModelSecrets } from './scope.mjs'
import { publicCapabilities, publicSecrets, USER_LOCAL } from './userSettings.mjs'
import { WORKSPACE_MESSAGE } from './workspace.mjs'

export { MODEL_MESSAGE }
export const CROSS_MESSAGE = '无权查看或操作其他用户的机器人、会话或设置。'
export const QUOTA_MESSAGE = '配额已用完，无法发送。请联系管理员提高可发送的消息数。'
export const SHARED_MESSAGE = '这项设置在共享内核上是全局的，不能按账号修改，以免影响其他用户。'
export const FILE_MESSAGE = '共享内核的文件和诊断日志不向单个账号开放。'

const METERED = new Set(['send', 'memory-ask'])
const LOCAL = USER_LOCAL
const FILE_WORKSPACE = new Set([
  'workspace-list', 'workspaces', 'workspace-open',
  'folder-pick', 'folder-list', 'file-text', 'file-write',
])
const BLOCKED = new Set(['update-install', 'dsh-update-install'])
const ID_KEYS = ['id', 'botId', 'sessionId', 'roomId', 'agentId']
const MARK = '~botcamp~'
const PREF_KEYS = new Set(['theme', 'accent', 'motion'])

export function createAccess(userId, resources) {
  const owners = new Map()
  for (const resource of resources) {
    if (!owners.has(resource.id)) owners.set(resource.id, resource.userId)
  }
  const owned = new Set(resources.filter(resource => resource.userId === userId).map(resource => resource.id))
  const pending = []
  const released = []
  return {
    userId,
    owns: id => typeof id === 'string' && owned.has(id),
    ownerOf: id => (typeof id === 'string' ? owners.get(id) ?? null : null),
    claim(id, kind, parentId = null) {
      if (typeof id !== 'string' || id.length === 0 || id.length > 200) return false
      const owner = owners.get(id)
      if (owner && owner !== userId) return false
      if (owner === userId) return true
      owners.set(id, userId)
      owned.add(id)
      pending.push({ id, kind, parentId })
      return true
    },
    release(id) {
      if (typeof id !== 'string' || !owned.has(id)) return
      released.push(id)
      owned.delete(id)
      owners.delete(id)
    },
    pending: () => pending,
    released: () => released,
  }
}

function accessPlan(endpoint, payload) {
  const mustOwn = []
  const claimIfFree = []
  const claimKind = 'secret'
  const skipResourceId = endpoint === 'usage'
    || endpoint === 'connector-connect'
    || endpoint === 'connector-disconnect'
    || endpoint === 'connector-retry'
    || endpoint === 'schedule-delete'
  if (payload && typeof payload === 'object' && !skipResourceId) {
    for (const key of ID_KEYS) {
      if (typeof payload[key] === 'string' && payload[key]) mustOwn.push(payload[key])
    }
    if (endpoint === 'exchange') {
      if (typeof payload.a === 'string') mustOwn.push(payload.a)
      if (typeof payload.b === 'string') mustOwn.push(payload.b)
    }
    if (Array.isArray(payload.members)) {
      for (const member of payload.members) {
        if (typeof member === 'string' && member) mustOwn.push(member)
        else if (member && typeof member.id === 'string') mustOwn.push(member.id)
      }
    }
    if (endpoint === 'schedule-create' && typeof payload.target === 'string') mustOwn.push(payload.target)
  }
  if ((endpoint.startsWith('connector-') || endpoint === 'schedule-delete') && payload && typeof payload === 'object') {
    for (const key of ['botId', 'sessionId', 'roomId', 'agentId']) {
      if (typeof payload[key] === 'string' && payload[key]) mustOwn.push(payload[key])
    }
  }
  return { mustOwn, claimIfFree, claimKind }
}

export function decide(endpoint, payload, access, context = {}) {
  const workspaceId = typeof context === 'string' ? context : context?.workspaceId
  if (typeof endpoint !== 'string' || endpoint.length === 0 || endpoint.length > 80) {
    return { action: 'refuse', message: '无效的请求。' }
  }
  if (isModelWrite(endpoint, payload)) return { action: 'refuse', message: MODEL_MESSAGE }
  if (payload && typeof payload === 'object' && typeof payload.workspaceId === 'string' && payload.workspaceId) {
    const requested = payload.workspaceId
    const ownsWorkspace = requested === workspaceId || access.owns(requested)
    if (!ownsWorkspace) return { action: 'refuse', message: WORKSPACE_MESSAGE }
  }
  if (BLOCKED.has(endpoint)) return { action: 'refuse', message: SHARED_MESSAGE }
  const plan = accessPlan(endpoint, payload)
  for (const id of plan.mustOwn) {
    if (!access.owns(id)) return { action: 'refuse', message: CROSS_MESSAGE }
  }
  for (const id of plan.claimIfFree) {
    const owner = access.ownerOf(id)
    if (owner && owner !== access.userId) return { action: 'refuse', message: CROSS_MESSAGE }
    if (!owner) access.claim(id, plan.claimKind)
  }
  if (FILE_WORKSPACE.has(endpoint)) return { action: 'workspace', endpoint }
  if (LOCAL.has(endpoint)) return { action: 'local', endpoint }
  if (METERED.has(endpoint)) return { action: 'metered' }
  return { action: 'forward' }
}

export function mergePrefs(current, patch) {
  const prefs = { ...(current ?? {}) }
  if (!patch || typeof patch !== 'object') return prefs
  for (const key of PREF_KEYS) {
    if (!Object.hasOwn(patch, key)) continue
    const value = patch[key]
    if (value == null || value === '') {
      delete prefs[key]
      continue
    }
    if (typeof value !== 'string' || value.length > 40) continue
    if (key === 'accent' && !/^#[0-9a-fA-F]{6}$/.test(value)) continue
    prefs[key] = value
  }
  return prefs
}

export function prefsVersionFromModelsKey(modelsKey) {
  if (typeof modelsKey !== 'string') return null
  const at = modelsKey.lastIndexOf(MARK)
  if (at < 0) return null
  const version = Number(modelsKey.slice(at + MARK.length))
  return Number.isInteger(version) ? version : null
}

export function unstampModelsKey(modelsKey) {
  if (typeof modelsKey !== 'string') return modelsKey ?? ''
  const at = modelsKey.indexOf(MARK)
  return at >= 0 ? modelsKey.slice(0, at) : modelsKey
}

export function stampModelsKey(modelsKey, prefsVersion) {
  const base = unstampModelsKey(modelsKey == null ? '' : String(modelsKey))
  return `${base}${MARK}${prefsVersion ?? 0}`
}

export function stateRequestPayload(payload, user) {
  const next = payload && typeof payload === 'object' ? { ...payload } : {}
  const clientVersion = prefsVersionFromModelsKey(next.models)
  if (clientVersion !== (user.prefsVersion ?? 0)) delete next.since
  if (typeof next.models === 'string') next.models = unstampModelsKey(next.models)
  return next
}

function keepMap(map, owns) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return {}
  return Object.fromEntries(Object.entries(map).filter(([key]) => owns(key)))
}

function filterWork(work, access) {
  if (!work || typeof work !== 'object') return work ?? { bots: {}, approvals: [] }
  const owns = access.owns
  const approvals = Array.isArray(work.approvals)
    ? work.approvals.filter((entry) => {
      if (!entry || typeof entry !== 'object') return false
      const mine = owns(entry.botId) || owns(entry.sessionId) || owns(entry.roomId)
      if (!mine) return false
      if (typeof entry.id === 'string') access.claim(entry.id, 'approval', entry.botId ?? entry.sessionId ?? null)
      return true
    })
    : []
  return {
    ...work,
    bots: keepMap(work.bots, owns),
    rooms: keepMap(work.rooms, owns),
    waiting: keepMap(work.waiting, owns),
    approvals,
  }
}

function claimBot(access, bot) {
  if (!bot || typeof bot.id !== 'string') return false
  if (!access.owns(bot.id)) return false
  if (typeof bot.sessionId === 'string') access.claim(bot.sessionId, 'session', bot.id)
  if (Array.isArray(bot.parts)) {
    for (const part of bot.parts) {
      if (typeof part === 'string') access.claim(part, 'session', bot.id)
    }
  }
  return true
}

export function filterState(value, user, access, settings = {}) {
  if (!value || typeof value !== 'object') return value
  if (value.unchanged) return value
  const bots = []
  for (const bot of value.bots ?? []) {
    if (claimBot(access, bot)) bots.push(bot)
  }
  const rooms = []
  for (const room of value.rooms ?? []) {
    if (room && access.owns(room.id)) rooms.push(room)
  }
  const agents = []
  for (const agent of value.agents ?? []) {
    if (!agent || !access.owns(agent.id)) continue
    agents.push(agent)
    for (const sessionId of agent.sessions ?? []) {
      if (typeof sessionId === 'string') access.claim(sessionId, 'session', agent.id)
    }
  }
  const mainBotIds = (user.mainBotIds ?? []).filter(id => access.owns(id))
  const botCapabilities = settings.botCapabilities && typeof settings.botCapabilities === 'object' ? settings.botCapabilities : {}
  for (const bot of bots) {
    if (Array.isArray(botCapabilities[bot.id])) bot.capabilities = [...botCapabilities[bot.id]]
  }
  const result = {
    ...value,
    bots,
    rooms,
    agents,
    mainBotId: mainBotIds[0] ?? null,
    mainBotIds,
    prefs: { ...(user.prefs ?? {}) },
    questions: keepMap(value.questions, access.owns),
    exchangeTurns: keepMap(value.exchangeTurns, access.owns),
    secrets: publicSecrets(settings),
    capabilities: publicCapabilities(settings),
    capabilityStatuses: keepMap(value.capabilityStatuses, access.owns),
    secretRequests: keepMap(value.secretRequests, access.owns),
    activity: keepMap(value.activity, access.owns),
    memoryNews: keepMap(value.memoryNews, access.owns),
    work: filterWork(value.work, access),
    connectors: scopeConnectors(value.connectors, settings.connectors),
    models: Array.isArray(value.models) ? value.models.map(stripModelSecrets) : value.models,
    modelsKey: stampModelsKey(value.modelsKey, user.prefsVersion ?? 0),
  }
  for (const key of ['usage', 'providers', 'providerKeys', 'diagnostics', 'files', 'workspace', 'teamWorkspace']) delete result[key]
  return result
}

export function filterUsage(value, access) {
  return scopeUsage(value, access)
}

export function filterSchedules(value, access) {
  const list = Array.isArray(value) ? value : value?.schedules
  if (!Array.isArray(list)) return value
  const kept = list.filter(item => item && (access.owns(item.id) || access.owns(item.sessionId) || access.owns(item.botId)))
  return Array.isArray(value) ? kept : { ...value, schedules: kept }
}

export function claimCreated(endpoint, value, access) {
  if (!value || typeof value !== 'object') return
  const body = value.bot ?? value.room ?? value.agent ?? value
  if (endpoint === 'create-bot' || endpoint === 'duplicate-bot') {
    if (typeof body.id === 'string') access.claim(body.id, 'bot')
    if (typeof body.sessionId === 'string') access.claim(body.sessionId, 'session', body.id ?? null)
    if (Array.isArray(body.parts)) {
      for (const part of body.parts) if (typeof part === 'string') access.claim(part, 'session', body.id ?? null)
    }
  } else if (endpoint === 'create-room') {
    if (typeof body.id === 'string') access.claim(body.id, 'room')
  } else if (endpoint === 'add-agent') {
    if (typeof body.id === 'string') access.claim(body.id, 'agent')
    for (const sessionId of body.sessions ?? []) {
      if (typeof sessionId === 'string') access.claim(sessionId, 'session', body.id ?? null)
    }
  } else if (endpoint === 'agent-session') {
    const sessionId = value.sessionId ?? body.sessionId ?? (typeof body.id === 'string' && body.id !== value.agentId ? body.id : null)
    if (typeof sessionId === 'string') access.claim(sessionId, 'session', value.agentId ?? null)
  } else if (endpoint === 'schedule-create') {
    const id = value.id ?? value.schedule?.id
    if (typeof id === 'string') access.claim(id, 'schedule', value.sessionId ?? null)
  }
}

const RELEASE_ENDPOINTS = new Set(['delete-bot', 'delete-room', 'remove-agent', 'schedule-delete', 'secret-delete', 'capability-delete'])

export function releaseDeleted(endpoint, payload, access) {
  if (!RELEASE_ENDPOINTS.has(endpoint) || !payload || typeof payload !== 'object') return
  if (typeof payload.id === 'string') access.release(payload.id)
  if (typeof payload.name === 'string') access.release(payload.name)
}

export function rewriteValue(endpoint, value, user, access, settings) {
  if (endpoint === 'state') return filterState(value, user, access, settings)
  if (endpoint === 'usage') return filterUsage(value, access)
  if (endpoint === 'schedules') return filterSchedules(value, access)
  if (endpoint === 'providers') return freezeProviders(value)
  return value
}

export function localValue(endpoint, user) {
  if (endpoint === 'diagnostics-log') return ''
  if (endpoint === 'diagnostics-clear') return true
  if (endpoint === 'diagnostics') {
    return {
      markdown: `BotCamp\n账号 ${user?.email ?? ''}\n这里只有这个账号自己的记录。\n`,
      issuesUrl: 'https://github.com/Fei2411/DeepSeek-Bot/issues/new',
    }
  }
  if (endpoint === 'set-prefs') return { ...(user.prefs ?? {}) }
  if (endpoint === 'set-main') return { mainBotIds: [...(user.mainBotIds ?? [])] }
  return null
}

export function feedBlockAllowed(block, access) {
  const lines = block.split('\n')
  if (lines.every(line => line === '' || line.startsWith(':'))) return true
  let event = 'message'
  const data = []
  for (const line of lines) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) data.push(line.slice(5).trim())
  }
  if (event === 'hello' || event === 'revision') return true
  if (data.length === 0) return false
  let payload
  try { payload = JSON.parse(data.join('\n')) } catch { return false }
  const ids = []
  for (const key of ID_KEYS) {
    if (typeof payload?.[key] === 'string' && payload[key]) ids.push(payload[key])
  }
  if (ids.length === 0) return false
  let mine = false
  for (const id of ids) {
    const owner = access.ownerOf(id)
    if (owner && owner !== access.userId) return false
    if (owner === access.userId) mine = true
  }
  if (!mine) return false
  for (const id of ids) if (!access.ownerOf(id)) access.claim(id, 'session')
  return true
}

export function feedMessageItem(block) {
  const data = []
  let event = 'message'
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) data.push(line.slice(5).trim())
  }
  if (event !== 'message' || data.length === 0) return null
  try {
    const payload = JSON.parse(data.join('\n'))
    if (!payload || typeof payload.sessionId !== 'string' || !payload.item) return null
    return payload
  } catch { return null }
}
