import { randomBytes } from 'node:crypto'

export const USER_LOCAL = new Set([
  'set-prefs', 'set-main', 'diagnostics', 'diagnostics-log', 'diagnostics-clear',
  'team-workspace', 'folders',
  'connector-connect', 'connector-disconnect', 'connector-retry',
  'secret-set', 'secret-update', 'secret-delete', 'secret-allow', 'secret-cancel',
  'capability-save', 'capability-delete', 'capability-approve', 'bot-capability',
  'schedules', 'schedule-create', 'schedule-delete',
  'memory-view', 'memory-forget',
])

export function emptySettings() {
  return {
    workspace: '',
    connectors: [],
    secrets: [],
    capabilities: [],
    schedules: [],
    botCapabilities: {},
    memory: {},
  }
}

export function normalizeSettings(settings) {
  const source = settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {}
  return {
    workspace: typeof source.workspace === 'string' ? source.workspace : '',
    connectors: Array.isArray(source.connectors) ? source.connectors : [],
    secrets: Array.isArray(source.secrets) ? source.secrets : [],
    capabilities: Array.isArray(source.capabilities) ? source.capabilities : [],
    schedules: Array.isArray(source.schedules) ? source.schedules : [],
    botCapabilities: source.botCapabilities && typeof source.botCapabilities === 'object' && !Array.isArray(source.botCapabilities) ? source.botCapabilities : {},
    memory: source.memory && typeof source.memory === 'object' && !Array.isArray(source.memory) ? source.memory : {},
  }
}

function clip(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

function publicSecret(secret) {
  return {
    name: secret.name,
    scope: secret.scope ?? 'all',
    purpose: secret.purpose ?? '',
    configured: true,
  }
}

function publicConnector(connector) {
  const row = { id: connector.id, name: connector.name || connector.id, state: connector.state || 'off' }
  if (connector.account) row.account = connector.account
  if (connector.error) row.error = connector.error
  return row
}

function scheduleView(settings) {
  return {
    available: true,
    tasks: settings.schedules.map(task => ({ ...task })),
  }
}

function memoryId(payload) {
  if (typeof payload?.botId === 'string' && payload.botId) return payload.botId
  if (typeof payload?.roomId === 'string' && payload.roomId) return payload.roomId
  return ''
}

export function publicSecrets(settings) {
  return normalizeSettings(settings).secrets.map(publicSecret)
}

export function publicCapabilities(settings) {
  return normalizeSettings(settings).capabilities.map(item => ({ ...item }))
}

export function applyUserSetting(current, endpoint, payload) {
  const settings = normalizeSettings(current)
  const next = {
    ...settings,
    connectors: settings.connectors.map(item => ({ ...item })),
    secrets: settings.secrets.map(item => ({ ...item })),
    capabilities: settings.capabilities.map(item => ({ ...item })),
    schedules: settings.schedules.map(item => ({ ...item })),
    botCapabilities: { ...settings.botCapabilities },
    memory: { ...settings.memory },
  }
  if (endpoint === 'team-workspace') {
    next.workspace = clip(payload?.path, 500)
    return { settings: next, value: { team: next.workspace || null } }
  }
  if (endpoint === 'folders') {
    return {
      settings,
      value: { team: settings.workspace || null, picker: null, folders: [] },
    }
  }
  if (endpoint === 'connector-connect' || endpoint === 'connector-disconnect' || endpoint === 'connector-retry') {
    const id = clip(payload?.id, 80)
    if (!id) return { settings, error: '没有这个连接器。' }
    const previous = next.connectors.find(item => item.id === id)
    const token = clip(payload?.token, 4000)
    let row = previous ? { ...previous } : { id, name: id === 'github' ? 'GitHub' : id, state: 'off' }
    if (endpoint === 'connector-disconnect') {
      row = { id, name: row.name, state: 'off' }
    } else if (endpoint === 'connector-connect') {
      if (!token) return { settings, error: '需要这个账号自己的连接凭据。' }
      row = { id, name: row.name, state: 'ready', account: '已保存', token }
    } else if (row.token) {
      row = { ...row, state: 'ready', account: row.account || '已保存' }
    } else {
      row = { ...row, state: 'off', error: '还没有这个账号的凭据。' }
    }
    next.connectors = [...next.connectors.filter(item => item.id !== id), row]
    return { settings: next, value: publicConnector(row) }
  }
  if (endpoint === 'secret-set') {
    const name = clip(payload?.name, 200)
    if (!name) return { settings, error: '缺少密钥名称。' }
    const value = clip(payload?.value, 8000)
    if (!value) return { settings, error: '缺少密钥内容。' }
    const secret = {
      name,
      scope: payload?.scope ?? 'all',
      purpose: clip(payload?.purpose, 200),
      value,
    }
    next.secrets = [...next.secrets.filter(item => item.name !== name), secret]
    return { settings: next, value: publicSecret(secret) }
  }
  if (endpoint === 'secret-update') {
    const name = clip(payload?.name, 200)
    const found = next.secrets.find(item => item.name === name)
    if (!found) return { settings, error: '没有这个密钥。' }
    found.scope = payload?.scope ?? found.scope
    return { settings: next, value: publicSecret(found) }
  }
  if (endpoint === 'secret-delete') {
    const name = clip(payload?.name, 200)
    next.secrets = next.secrets.filter(item => item.name !== name)
    return { settings: next, value: true }
  }
  if (endpoint === 'secret-allow' || endpoint === 'secret-cancel') {
    return { settings, value: true }
  }
  if (endpoint === 'capability-save') {
    const name = clip(payload?.name ?? payload?.capability?.name, 200)
    if (!name) return { settings, error: '缺少能力名称。' }
    const saved = { ...(payload?.capability ?? payload), name }
    delete saved.value
    delete saved.token
    delete saved.apiKey
    next.capabilities = [...next.capabilities.filter(item => item.name !== name), saved]
    return { settings: next, value: { name } }
  }
  if (endpoint === 'capability-delete') {
    const name = clip(payload?.name, 200)
    next.capabilities = next.capabilities.filter(item => item.name !== name)
    return { settings: next, value: true }
  }
  if (endpoint === 'capability-approve') {
    const name = clip(payload?.name, 200)
    const found = next.capabilities.find(item => item.name === name)
    if (found) found.approved = true
    return { settings: next, value: { name, approved: Boolean(found) } }
  }
  if (endpoint === 'bot-capability') {
    const botId = clip(payload?.botId, 200)
    const name = clip(payload?.name, 200)
    if (!botId || !name) return { settings, error: '无效的能力设置。' }
    const current = Array.isArray(next.botCapabilities[botId]) ? next.botCapabilities[botId].filter(item => item !== name) : []
    if (payload?.attached !== false) current.push(name)
    next.botCapabilities = { ...next.botCapabilities, [botId]: current }
    return { settings: next, value: { botId, name, attached: payload?.attached !== false } }
  }
  if (endpoint === 'schedules') return { settings, value: scheduleView(settings) }
  if (endpoint === 'schedule-create') {
    const title = clip(payload?.title, 120)
    const prompt = clip(payload?.prompt, 4000)
    const target = clip(payload?.target ?? payload?.botId ?? payload?.sessionId, 200)
    if (!title || !prompt || !target) return { settings, error: '定时任务缺少名称、内容或机器人。' }
    const task = {
      id: `task_${randomBytes(8).toString('base64url')}`,
      title,
      prompt,
      botId: target,
      sessionId: target,
      status: 'active',
      when: payload?.when ?? null,
    }
    next.schedules = [...next.schedules, task]
    return { settings: next, value: scheduleView(next) }
  }
  if (endpoint === 'schedule-delete') {
    const id = clip(payload?.id, 200)
    next.schedules = next.schedules.filter(task => task.id !== id)
    return { settings: next, value: scheduleView(next) }
  }
  if (endpoint === 'memory-view' || endpoint === 'memory-forget') {
    const id = memoryId(payload)
    const bag = next.memory[id] && typeof next.memory[id] === 'object' ? next.memory[id] : { entries: [], summary: '' }
    const entries = Array.isArray(bag.entries) ? bag.entries : []
    if (endpoint === 'memory-forget') {
      const kept = entries.filter(entry => entry?.topic !== payload?.topic || entry?.text !== payload?.text)
      next.memory = { ...next.memory, [id]: { ...bag, entries: kept } }
      return { settings: next, value: { entries: kept, summary: bag.summary ?? '' } }
    }
    return { settings, value: { entries, summary: bag.summary ?? '' } }
  }
  return { settings, error: '这项设置不能这样保存。' }
}
