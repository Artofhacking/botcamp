// Demox 用户函数的磁盘和 HOME 都在冷启动时丢掉，函数环境变量也不是数据库。
// 平台真正留下来的业务数据在网站 API 的项目库里（MySQL 的 project_rows）。
// 一行最多约 32KB，所以正文按块存放。

const API_URL = 'https://api.demox.site/website'
const CHUNK_BYTES = 16_000
const DOC_BUDGET = 24_000

const USERS = 'botcamp_users'
const SESSIONS = 'botcamp_sessions'
const RESOURCES = 'botcamp_resources'
const REVOKED = 'botcamp_revoked'
const NAMESPACES = 'botcamp_ns'
const FILES = 'botcamp_files'

const SCHEMAS = {
  [USERS]: [
    { name: 'id', type: 'text', primary: true },
    { name: 'email', type: 'text' },
    { name: 'password_hash', type: 'text' },
    { name: 'role', type: 'text' },
    { name: 'quota', type: 'number' },
    { name: 'used', type: 'number' },
    { name: 'kernel_key', type: 'text' },
    { name: 'prefs', type: 'text' },
    { name: 'prefs_version', type: 'number' },
    { name: 'main_bot_ids', type: 'text' },
    { name: 'created_at', type: 'text' },
  ],
  [SESSIONS]: [
    { name: 'id', type: 'text', primary: true },
    { name: 'user_id', type: 'text' },
    { name: 'expires_at', type: 'number' },
    { name: 'session_id', type: 'text' },
  ],
  [RESOURCES]: [
    { name: 'id', type: 'text', primary: true },
    { name: 'user_id', type: 'text' },
    { name: 'kind', type: 'text' },
    { name: 'parent_id', type: 'text' },
  ],
  [REVOKED]: [
    { name: 'id', type: 'text', primary: true },
  ],
  [NAMESPACES]: [
    { name: 'id', type: 'text', primary: true },
    { name: 'body', type: 'text' },
  ],
  [FILES]: [
    { name: 'id', type: 'text', primary: true },
    { name: 'kernel_key', type: 'text' },
    { name: 'body', type: 'text' },
  ],
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

function upsert(list, key, value, id) {
  const index = list.findIndex(item => item[key] === id)
  if (index >= 0) list[index] = value
  else list.push(value)
}

function text(value) {
  return typeof value === 'string' ? value : ''
}

function fitNamespace(body) {
  const next = clone(body) ?? {}
  if (!next.transcripts || typeof next.transcripts !== 'object') next.transcripts = {}
  let encoded = JSON.stringify(next)
  if (Buffer.byteLength(encoded) <= DOC_BUDGET) return encoded
  const sessions = Object.keys(next.transcripts)
  for (const sessionId of sessions) {
    const page = next.transcripts[sessionId]
    const items = Array.isArray(page?.items) ? page.items : []
    while (items.length > 0 && Buffer.byteLength(JSON.stringify(next)) > DOC_BUDGET) items.pop()
    if (items.length === 0) delete next.transcripts[sessionId]
    if (Buffer.byteLength(JSON.stringify(next)) <= DOC_BUDGET) break
  }
  encoded = JSON.stringify(next)
  if (Buffer.byteLength(encoded) > DOC_BUDGET) {
    const error = new Error('这个账号的记录太大，项目库的一行放不下。')
    error.code = 'LIMIT'
    throw error
  }
  return encoded
}

function chunksFor(textBody) {
  const source = Buffer.from(String(textBody ?? ''), 'utf8')
  if (source.length === 0) return ['']
  const parts = []
  let offset = 0
  while (offset < source.length) {
    let end = Math.min(source.length, offset + CHUNK_BYTES)
    while (end > offset && (source[end] & 0xc0) === 0x80) end -= 1
    if (end === offset) end = Math.min(source.length, offset + CHUNK_BYTES)
    parts.push(source.subarray(offset, end).toString('utf8'))
    offset = end
  }
  return parts
}

export function createMemoryLedger() {
  const accounts = { users: [], sessions: [], resources: [], revoked: [] }
  let ready = false
  const namespaces = new Map()
  const files = new Map()
  return {
    async loadAccounts() {
      if (!ready) return null
      return clone(accounts)
    },
    async saveAccounts(data) {
      accounts.users = clone(data.users ?? [])
      accounts.sessions = clone(data.sessions ?? [])
      accounts.resources = clone(data.resources ?? [])
      accounts.revoked = clone(data.revoked ?? [])
      ready = true
    },
    async putUser(user) {
      ready = true
      upsert(accounts.users, 'id', clone(user), user.id)
    },
    async removeUser(id) {
      ready = true
      accounts.users = accounts.users.filter(user => user.id !== id)
    },
    async putSession(session) {
      ready = true
      upsert(accounts.sessions, 'tokenHash', clone(session), session.tokenHash)
    },
    async removeSession(tokenHash) {
      ready = true
      accounts.sessions = accounts.sessions.filter(session => session.tokenHash !== tokenHash)
    },
    async putResource(resource) {
      ready = true
      upsert(accounts.resources, 'id', clone(resource), resource.id)
    },
    async removeResource(id) {
      ready = true
      accounts.resources = accounts.resources.filter(resource => resource.id !== id)
    },
    async putRevoked(hash) {
      ready = true
      if (!accounts.revoked.includes(hash)) accounts.revoked.push(hash)
    },
    async removeRevoked(hash) {
      ready = true
      accounts.revoked = accounts.revoked.filter(item => item !== hash)
    },
    async loadNamespace(kernelKey) {
      return namespaces.has(kernelKey) ? clone(namespaces.get(kernelKey)) : null
    },
    async saveNamespace(kernelKey, body) {
      namespaces.set(kernelKey, JSON.parse(fitNamespace(body)))
    },
    async loadFiles(kernelKey) {
      return clone(files.get(kernelKey) ?? {})
    },
    async saveFiles(kernelKey, tree) {
      files.set(kernelKey, clone(tree ?? {}))
    },
  }
}

function userToRow(user) {
  return {
    id: user.id,
    email: user.email,
    password_hash: user.passwordHash,
    role: user.role,
    quota: user.quota ?? 0,
    used: user.used ?? 0,
    kernel_key: user.kernelKey,
    prefs: JSON.stringify(user.prefs ?? {}),
    prefs_version: user.prefsVersion ?? 0,
    main_bot_ids: JSON.stringify(user.mainBotIds ?? []),
    created_at: user.createdAt ?? '',
  }
}

function sessionToRow(session) {
  return {
    id: session.tokenHash,
    user_id: session.userId,
    expires_at: session.expiresAt,
    session_id: session.id,
  }
}

function resourceToRow(resource) {
  return {
    id: resource.id,
    user_id: resource.userId,
    kind: resource.kind ?? '',
    parent_id: resource.parentId ?? '',
  }
}

function userFromRow(values) {
  let prefs = {}
  let mainBotIds = []
  try { prefs = JSON.parse(values.prefs || '{}') } catch { prefs = {} }
  try { mainBotIds = JSON.parse(values.main_bot_ids || '[]') } catch { mainBotIds = [] }
  return {
    id: values.id,
    email: values.email,
    passwordHash: values.password_hash,
    role: values.role,
    quota: Number(values.quota ?? 0),
    used: Number(values.used ?? 0),
    kernelKey: values.kernel_key,
    prefs: prefs && typeof prefs === 'object' ? prefs : {},
    prefsVersion: Number(values.prefs_version ?? 0),
    mainBotIds: Array.isArray(mainBotIds) ? mainBotIds : [],
    createdAt: values.created_at || new Date().toISOString(),
  }
}

async function syncRows(client, table, rows) {
  const existing = await client.list(table)
  const keep = new Set(rows.map(row => row.id))
  for (const row of rows) await client.put(table, row)
  for (const previous of existing) {
    if (!keep.has(previous.pk)) await client.remove(table, previous.pk)
  }
}

export function createHttpLedger({ fetchImpl, apiUrl = API_URL, token, projectId }) {
  if (typeof token !== 'string' || token.length < 20) {
    const error = new Error('项目库令牌没有配置。')
    error.code = 'STORE'
    throw error
  }
  if (typeof projectId !== 'string' || projectId.length < 4) {
    const error = new Error('项目库编号没有配置。')
    error.code = 'STORE'
    throw error
  }
  const call = async (action, extra = {}) => {
    const response = await fetchImpl(apiUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ action, projectId, ...extra }),
      signal: AbortSignal.timeout(20_000),
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok || payload.success === false) {
      const error = new Error(payload.message || '项目库暂时不可用。')
      error.code = payload.code || 'STORE'
      throw error
    }
    return payload
  }
  let prepared = null
  const ensure = () => {
    prepared ??= (async () => {
      for (const [name, columns] of Object.entries(SCHEMAS)) {
        try {
          await call('create_project_table', { name, columns })
        } catch (error) {
          if (error.code !== 'exists') throw error
        }
      }
    })()
    return prepared
  }
  const list = async (table) => {
    await ensure()
    const rows = []
    let after = ''
    for (;;) {
      const page = await call('list_project_rows', { table, limit: 100, ...(after ? { after } : {}) })
      rows.push(...(page.rows ?? []))
      if (!page.next) return rows
      after = page.next
    }
  }
  const put = async (table, values) => {
    await ensure()
    await call('put_project_row', { table, values })
  }
  const remove = async (table, pk) => {
    await ensure()
    try {
      await call('delete_project_row', { table, pk })
    } catch (error) {
      if (error.code !== 'not_found') throw error
    }
  }
  const client = { list, put, remove }
  return {
    async loadAccounts() {
      const [users, sessions, resources, revoked] = await Promise.all([
        list(USERS), list(SESSIONS), list(RESOURCES), list(REVOKED),
      ])
      if (users.length === 0 && sessions.length === 0 && resources.length === 0 && revoked.length === 0) return null
      return {
        users: users.map(row => userFromRow(row.values)),
        sessions: sessions.map(row => ({
          id: text(row.values.session_id) || row.pk,
          userId: text(row.values.user_id),
          tokenHash: row.pk,
          expiresAt: Number(row.values.expires_at ?? 0),
        })),
        resources: resources.map(row => ({
          id: row.pk,
          userId: text(row.values.user_id),
          kind: text(row.values.kind),
          parentId: row.values.parent_id || null,
        })),
        revoked: revoked.map(row => row.pk),
      }
    },
    async saveAccounts(data) {
      await syncRows(client, USERS, (data.users ?? []).map(userToRow))
      await syncRows(client, SESSIONS, (data.sessions ?? []).map(sessionToRow))
      await syncRows(client, RESOURCES, (data.resources ?? []).map(resourceToRow))
      await syncRows(client, REVOKED, (data.revoked ?? []).map(hash => ({ id: hash })))
    },
    async putUser(user) { await put(USERS, userToRow(user)) },
    async removeUser(id) { await remove(USERS, id) },
    async putSession(session) { await put(SESSIONS, sessionToRow(session)) },
    async removeSession(tokenHash) { await remove(SESSIONS, tokenHash) },
    async putResource(resource) { await put(RESOURCES, resourceToRow(resource)) },
    async removeResource(id) { await remove(RESOURCES, id) },
    async putRevoked(hash) { await put(REVOKED, { id: hash }) },
    async removeRevoked(hash) { await remove(REVOKED, hash) },
    async loadNamespace(kernelKey) {
      const rows = await list(NAMESPACES)
      const found = rows.find(row => row.pk === kernelKey)
      if (!found?.values?.body) return null
      try { return JSON.parse(found.values.body) } catch { return null }
    },
    async saveNamespace(kernelKey, body) {
      await put(NAMESPACES, { id: kernelKey, body: fitNamespace(body) })
    },
    async loadFiles(kernelKey) {
      const rows = await list(FILES)
      const prefix = `${kernelKey}:`
      const grouped = new Map()
      for (const row of rows) {
        if (!row.pk.startsWith(prefix)) continue
        const rest = row.pk.slice(prefix.length)
        const match = rest.match(/^(.*)\#(\d+)$/)
        const rel = match ? match[1] : rest
        const index = match ? Number(match[2]) : 0
        const bucket = grouped.get(rel) ?? []
        bucket[index] = text(row.values.body)
        grouped.set(rel, bucket)
      }
      const tree = {}
      for (const [rel, parts] of grouped) {
        if (rel.endsWith('/')) tree[rel.slice(0, -1)] = { dir: true }
        else tree[rel] = { text: parts.filter(part => part != null).join('') }
      }
      return tree
    },
    async saveFiles(kernelKey, tree) {
      const rows = await list(FILES)
      const prefix = `${kernelKey}:`
      const keep = new Set()
      for (const [rel, info] of Object.entries(tree ?? {})) {
        if (typeof rel !== 'string' || rel.includes('..') || rel.startsWith('/')) continue
        if (info?.dir) {
          const id = `${prefix}${rel}/`
          keep.add(id)
          await put(FILES, { id, kernel_key: kernelKey, body: '' })
        }
        const parts = info?.dir ? [] : chunksFor(info?.text ?? '')
        parts.forEach((part, index) => {
          const id = parts.length === 1 ? `${prefix}${rel}` : `${prefix}${rel}#${index}`
          keep.add(id)
        })
        for (let index = 0; index < parts.length; index += 1) {
          const id = parts.length === 1 ? `${prefix}${rel}` : `${prefix}${rel}#${index}`
          await put(FILES, { id, kernel_key: kernelKey, body: parts[index] })
        }
      }
      for (const previous of rows) {
        if (previous.pk.startsWith(prefix) && !keep.has(previous.pk)) await remove(FILES, previous.pk)
      }
    },
  }
}
