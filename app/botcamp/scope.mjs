// Who may change what on the shared kernel. Model configuration is not a user
// feature: nobody, including an admin using the bot UI, may write the catalog
// or a provider key. Other settings belong to the caller. Usage is reduced to
// the caller's own rows before it is returned.

export const MODEL_MESSAGE = '不能配置模型。模型目录和服务商密钥不向账号开放。'

// Bot endpoints an admin may use to change a shared kernel setting. Empty on
// purpose: user and quota management lives on /api/admin, not here, and model
// configuration is not one of these controls.
export const ADMIN_GLOBAL = new Set()

const MODEL_WRITES = new Set([
  'provider-key', 'provider-add', 'provider-remove', 'provider-models',
  'model-add', 'model-remove', 'models-add', 'models-remove', 'models-save', 'models-update',
  'model-config', 'set-providers', 'set-catalog', 'catalog',
])

const MODEL_READS = new Set(['models', 'model', 'providers', 'efforts'])

const MODEL_PAYLOAD_KEYS = ['apiKey', 'providerKey', 'providers', 'provider', 'catalog']

export function isModelWrite(endpoint, payload) {
  if (typeof endpoint !== 'string') return false
  if (MODEL_READS.has(endpoint)) return false
  if (MODEL_WRITES.has(endpoint) || endpoint.startsWith('provider-')) return true
  if (/^(model|models|catalog)[-/]/.test(endpoint)) return true
  if (endpoint === 'update-bot' && payload && typeof payload === 'object') {
    return MODEL_PAYLOAD_KEYS.some(key => Object.hasOwn(payload, key))
  }
  return false
}

export function isAdminGlobal(endpoint, role) {
  return role === 'admin' && ADMIN_GLOBAL.has(endpoint)
}

export function usageRequestPayload(payload) {
  const next = payload && typeof payload === 'object' ? { ...payload } : {}
  for (const key of ['userId', 'user', 'owner', 'owners', 'botId', 'email']) delete next[key]
  return next
}

function ownerId(owner) {
  if (typeof owner === 'string') return owner
  if (!owner || typeof owner !== 'object') return null
  if (typeof owner.id === 'string' && owner.id) return owner.id
  if (typeof owner.key === 'string' && owner.key) return owner.key
  if (typeof owner.botId === 'string' && owner.botId) return owner.botId
  return null
}

function publicOwner(owner, id) {
  return {
    key: typeof owner.key === 'string' ? owner.key : id,
    id,
    kind: typeof owner.kind === 'string' ? owner.kind : 'bot',
    name: typeof owner.name === 'string' ? owner.name : '',
    deleted: owner.deleted === true,
  }
}

function publicModel(model, index) {
  if (!model || typeof model !== 'object') return { key: String(index) }
  return {
    key: model.key ?? model.model ?? String(index),
    name: model.name,
    model: model.model,
    provider: model.provider,
    providerName: model.providerName,
  }
}

// Keep a row only when its owner is one of this user's resources. Owner is either
// an index into `owners` or a resource id. Aggregates that mix every account are dropped.
export function scopeUsage(value, access) {
  const now = typeof value?.now === 'string' ? value.now : ''
  const scanning = value?.scanning === true
  const sourceOwners = Array.isArray(value?.owners) ? value.owners : null
  const models = Array.isArray(value?.models) ? value.models.map(publicModel) : []
  const rows = Array.isArray(value?.rows) ? value.rows : []
  if (!sourceOwners) {
    return {
      now,
      scanning,
      models,
      rows: rows.filter(row => Array.isArray(row) && typeof row[1] === 'string' && access.owns(row[1])),
    }
  }
  const kept = []
  const remap = new Map()
  sourceOwners.forEach((owner, index) => {
    const id = ownerId(owner)
    if (!id || !access.owns(id)) return
    remap.set(index, kept.length)
    if (typeof owner?.key === 'string') remap.set(owner.key, kept.length)
    remap.set(id, kept.length)
    kept.push(publicOwner(owner, id))
  })
  const nextRows = []
  for (const row of rows) {
    if (!Array.isArray(row)) continue
    const owner = row[1]
    if (typeof owner === 'number') {
      if (!remap.has(owner)) continue
      const copy = row.slice()
      copy[1] = remap.get(owner)
      nextRows.push(copy)
      continue
    }
    if (typeof owner === 'string' && remap.has(owner)) {
      const copy = row.slice()
      copy[1] = remap.get(owner)
      nextRows.push(copy)
    }
  }
  return { now, scanning, owners: kept, models, rows: nextRows }
}

export function stripModelSecrets(model) {
  if (!model || typeof model !== 'object') return model
  const next = {}
  for (const [key, child] of Object.entries(model)) {
    if (/apiKey|token|password|secret|authorization|^key$/i.test(key)) continue
    next[key] = child
  }
  return next
}

export function freezeProviders(value) {
  if (!value || typeof value !== 'object') return { available: false, providers: [] }
  const list = Array.isArray(value.providers) ? value.providers : []
  return {
    available: false,
    protocols: Array.isArray(value.protocols) ? value.protocols.filter(item => typeof item === 'string') : [],
    providers: list.map(provider => ({
      id: provider?.id,
      name: provider?.name,
      removable: false,
      error: typeof provider?.error === 'string' ? provider.error : undefined,
      models: Array.isArray(provider?.models) ? provider.models.map(stripModelSecrets) : [],
      key: provider?.key && typeof provider.key === 'object'
        ? { configured: Boolean(provider.key.configured), writable: false }
        : undefined,
    })),
  }
}

export function scopeConnectors(kernelList, mine) {
  const saved = new Map((Array.isArray(mine) ? mine : []).map(item => [item?.id, item]))
  const list = Array.isArray(kernelList) ? kernelList : []
  const ids = []
  for (const item of list) {
    if (item && typeof item.id === 'string' && !ids.includes(item.id)) ids.push(item.id)
  }
  for (const id of saved.keys()) {
    if (typeof id === 'string' && !ids.includes(id)) ids.push(id)
  }
  return ids.map((id) => {
    const kernel = list.find(item => item?.id === id) ?? {}
    const own = saved.get(id)
    const row = {
      id,
      name: (own?.name || kernel.name || id),
      state: own?.state || 'off',
    }
    if (own?.account) row.account = own.account
    if (own?.error) row.error = own.error
    return row
  })
}
