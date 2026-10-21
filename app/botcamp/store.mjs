import { randomBytes, createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { hashPassword, normalizeEmail, validEmail, validPassword, verifyPassword } from './passwords.mjs'

const SESSION_MS = 14 * 24 * 60 * 60 * 1000

export function defaultDataDir() {
  // The Demox bundle is CJS, where import.meta.url is empty. The function always
  // passes BOTCAMP_DATA_DIR; this fallback is only for a local process.
  if (!import.meta.url) return path.join(process.cwd(), 'data')
  return fileURLToPath(new URL('../../data', import.meta.url))
}

function emptyData() {
  return { users: [], sessions: [], resources: [] }
}

function publicUser(user) {
  const quota = user.quota ?? 0
  const used = user.used ?? 0
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    quota,
    used,
    remaining: Math.max(0, quota - used),
    createdAt: user.createdAt,
  }
}

// Server-side view of an account. Password hashes stay in the file.
function principal(user) {
  if (!user) return null
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    quota: user.quota ?? 0,
    used: user.used ?? 0,
    kernelKey: user.kernelKey,
    prefs: { ...(user.prefs ?? {}) },
    prefsVersion: user.prefsVersion ?? 0,
    mainBotIds: [...(user.mainBotIds ?? [])],
  }
}

export function defaultQuota(env) {
  const parsed = Number(env.BOTCAMP_DEFAULT_QUOTA ?? 200)
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 1_000_000_000 ? parsed : 200
}

// A production password is never baked in. The local default applies only when
// this process is not marked production.
export function bootstrapCredentials(env) {
  const email = typeof env.BOTCAMP_ADMIN_EMAIL === 'string' ? env.BOTCAMP_ADMIN_EMAIL.trim() : ''
  const password = typeof env.BOTCAMP_ADMIN_PASSWORD === 'string' ? env.BOTCAMP_ADMIN_PASSWORD : ''
  if (email && password) return { email, password }
  if (env.NODE_ENV === 'production' || env.BOTCAMP_PRODUCTION === '1') return null
  return { email: 'admin@localhost', password: 'botcamp-dev' }
}

function newUser({ email, passwordHash, role, quota }) {
  return {
    id: randomBytes(16).toString('base64url'),
    email,
    passwordHash,
    role,
    quota,
    used: 0,
    kernelKey: `u_${randomBytes(12).toString('base64url')}`,
    prefs: {},
    prefsVersion: 0,
    mainBotIds: [],
    createdAt: new Date().toISOString(),
  }
}

export async function openStore(dataDir) {
  const dir = dataDir
  const file = path.join(dir, 'accounts.json')
  const namespaceDir = path.join(dir, 'namespaces')
  await mkdir(namespaceDir, { recursive: true })
  let data = emptyData()
  try {
    data = JSON.parse(await readFile(file, 'utf8'))
    if (!Array.isArray(data.users) || !Array.isArray(data.sessions) || !Array.isArray(data.resources)) data = emptyData()
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }

  let dummyHash = null
  const ensureDummy = async () => {
    if (!dummyHash) dummyHash = await hashPassword('botcamp-dummy-check')
    return dummyHash
  }
  let chain = Promise.resolve()
  const exclusive = (fn) => {
    const run = chain.then(fn)
    chain = run.then(() => {}, () => {})
    return run
  }
  const saveAccounts = () => writeAtomic(file, data)

  const api = {
    idle: () => chain,
    publicUser,
    exclusive,
    async bootstrap(env) {
      return exclusive(async () => {
        if (data.users.length > 0) return { created: false }
        const creds = bootstrapCredentials(env)
        if (!creds || !validEmail(normalizeEmail(creds.email)) || typeof creds.password !== 'string' || creds.password.length < 8) {
          return { created: false }
        }
        const email = normalizeEmail(creds.email)
        data.users.push(newUser({
          email,
          passwordHash: await hashPassword(creds.password),
          role: 'admin',
          quota: defaultQuota(env),
        }))
        await saveAccounts()
        return { created: true }
      })
    },
    getUser(id) {
      return exclusive(async () => principal(data.users.find(user => user.id === id)))
    },
    async authenticate(email, password) {
      const normalized = normalizeEmail(typeof email === 'string' ? email : '')
      const candidate = typeof password === 'string' && password.length <= 200 ? password : ''
      const dummy = await ensureDummy()
      const hash = await exclusive(async () => data.users.find(user => user.email === normalized)?.passwordHash ?? null)
      const ok = await verifyPassword(candidate, hash ?? dummy)
      if (!ok || !hash || candidate === '') return null
      return exclusive(async () => principal(data.users.find(user => user.email === normalized)))
    },
    listUsers() {
      return exclusive(async () => data.users.map(publicUser))
    },
    resources() {
      return exclusive(async () => data.resources.map(resource => ({ ...resource })))
    },
    async createUser({ email, password, role, quota }) {
      const normalized = normalizeEmail(email)
      if (!validEmail(normalized)) return { error: '请填写有效的邮箱。' }
      if (!validPassword(password)) return { error: '密码至少 8 位。' }
      if (role !== 'admin' && role !== 'user') return { error: '角色无效。' }
      if (!Number.isInteger(quota) || quota < 0) return { error: '配额必须是非负整数。' }
      return exclusive(async () => {
        if (data.users.some(user => user.email === normalized)) return { error: '这个邮箱已经有账号。' }
        const user = newUser({ email: normalized, passwordHash: await hashPassword(password), role, quota })
        data.users.push(user)
        await saveAccounts()
        return { user: publicUser(user) }
      })
    },
    async updateUser(id, patch) {
      if (patch.role !== undefined && patch.role !== 'admin' && patch.role !== 'user') return { error: '角色无效。' }
      if (patch.quota !== undefined && (!Number.isInteger(patch.quota) || patch.quota < 0)) return { error: '配额必须是非负整数。' }
      if (patch.used !== undefined && (!Number.isInteger(patch.used) || patch.used < 0)) return { error: '已用条数必须是非负整数。' }
      if (patch.password !== undefined && !validPassword(patch.password)) return { error: '密码至少 8 位。' }
      const passwordHash = patch.password !== undefined ? await hashPassword(patch.password) : null
      return exclusive(async () => {
        const user = data.users.find(entry => entry.id === id)
        if (!user) return { error: '没有这个用户。', status: 404 }
        if (patch.role !== undefined) {
          if (user.role === 'admin' && patch.role !== 'admin' && data.users.filter(entry => entry.role === 'admin').length <= 1) {
            return { error: '至少要留下一名管理员。' }
          }
          user.role = patch.role
        }
        if (patch.quota !== undefined) user.quota = patch.quota
        if (patch.used !== undefined) user.used = patch.used
        if (passwordHash) user.passwordHash = passwordHash
        await saveAccounts()
        return { user: publicUser(user) }
      })
    },
    async deleteUser(id, actorId) {
      return exclusive(async () => {
        const user = data.users.find(entry => entry.id === id)
        if (!user) return { error: '没有这个用户。', status: 404 }
        if (user.id === actorId) return { error: '不能删除当前登录的账号。' }
        if (user.role === 'admin' && data.users.filter(entry => entry.role === 'admin').length <= 1) {
          return { error: '至少要留下一名管理员。' }
        }
        data.users = data.users.filter(entry => entry.id !== id)
        data.sessions = data.sessions.filter(session => session.userId !== id)
        data.resources = data.resources.filter(resource => resource.userId !== id)
        await saveAccounts()
        return { ok: true }
      })
    },
    async createSession(userId) {
      const token = randomBytes(32).toString('base64url')
      const tokenHash = hashToken(token)
      const expiresAt = Date.now() + SESSION_MS
      await exclusive(async () => {
        data.sessions.push({ id: randomBytes(12).toString('base64url'), userId, tokenHash, expiresAt })
        await saveAccounts()
      })
      return { token, expiresAt }
    },
    async userForToken(token) {
      if (typeof token !== 'string' || token.length < 20) return null
      const tokenHash = hashToken(token)
      return exclusive(async () => {
        const now = Date.now()
        const session = data.sessions.find(entry => entry.tokenHash === tokenHash)
        if (!session) return null
        if (session.expiresAt <= now) {
          data.sessions = data.sessions.filter(entry => entry !== session)
          await saveAccounts()
          return null
        }
        return principal(data.users.find(user => user.id === session.userId))
      })
    },
    async deleteSession(token) {
      if (typeof token !== 'string') return
      const tokenHash = hashToken(token)
      await exclusive(async () => {
        const next = data.sessions.filter(entry => entry.tokenHash !== tokenHash)
        if (next.length === data.sessions.length) return
        data.sessions = next
        await saveAccounts()
      })
    },
    async tryConsume(userId) {
      return exclusive(async () => {
        const user = data.users.find(entry => entry.id === userId)
        if (!user) return { ok: false }
        if (user.used >= user.quota) return { ok: false }
        user.used += 1
        await saveAccounts()
        return { ok: true, user: publicUser(user) }
      })
    },
    async refund(userId) {
      await exclusive(async () => {
        const user = data.users.find(entry => entry.id === userId)
        if (!user || user.used <= 0) return
        user.used -= 1
        await saveAccounts()
      })
    },
    async setPrefs(userId, prefs) {
      return exclusive(async () => {
        const user = data.users.find(entry => entry.id === userId)
        if (!user) return null
        user.prefs = prefs
        user.prefsVersion = (user.prefsVersion ?? 0) + 1
        await saveAccounts()
        return principal(user)
      })
    },
    async setMain(userId, mainBotIds) {
      return exclusive(async () => {
        const user = data.users.find(entry => entry.id === userId)
        if (!user) return null
        user.mainBotIds = mainBotIds
        user.prefsVersion = (user.prefsVersion ?? 0) + 1
        await saveAccounts()
        return principal(user)
      })
    },
    async commitAccess(userId, access) {
      await exclusive(async () => {
        let changed = false
        for (const id of access.released()) {
          const next = data.resources.filter(resource => !(resource.userId === userId && (resource.id === id || resource.parentId === id)))
          if (next.length !== data.resources.length) changed = true
          data.resources = next
        }
        for (const claim of access.pending()) {
          const existing = data.resources.find(resource => resource.id === claim.id)
          if (existing && existing.userId !== userId) continue
          if (existing) continue
          data.resources.push({ id: claim.id, userId, kind: claim.kind, parentId: claim.parentId ?? null })
          changed = true
        }
        if (changed) await saveAccounts()
      })
    },
    async rememberPage(userId, sessionId, items) {
      if (typeof sessionId !== 'string' || !Array.isArray(items)) return
      await exclusive(async () => {
        const user = data.users.find(entry => entry.id === userId)
        if (!user || !safeKernelKey(user.kernelKey)) return
        const transcriptFile = path.join(namespaceDir, `${user.kernelKey}.json`)
        const saved = await readNamespace(transcriptFile)
        saved.transcripts[sessionId] = { items: items.slice(-200) }
        await writeAtomic(transcriptFile, saved)
      })
    },
    async appendItem(userId, sessionId, item) {
      if (typeof sessionId !== 'string' || !item || typeof item !== 'object') return
      await exclusive(async () => {
        const user = data.users.find(entry => entry.id === userId)
        if (!user || !safeKernelKey(user.kernelKey)) return
        const transcriptFile = path.join(namespaceDir, `${user.kernelKey}.json`)
        const saved = await readNamespace(transcriptFile)
        const page = saved.transcripts[sessionId] ?? { items: [] }
        const items = Array.isArray(page.items) ? page.items : []
        const same = items.some(entry => entry.kind === item.kind && entry.time === item.time && entry.text === item.text)
        if (!same) items.push(item)
        saved.transcripts[sessionId] = { items: items.slice(-200) }
        await writeAtomic(transcriptFile, saved)
      })
    },
    kernelKey(userId) {
      return exclusive(async () => data.users.find(user => user.id === userId)?.kernelKey ?? '')
    },
  }
  return api
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex')
}

function safeKernelKey(kernelKey) {
  return typeof kernelKey === 'string' && /^u_[A-Za-z0-9_-]{8,}$/.test(kernelKey)
}

async function readNamespace(file) {
  try {
    const saved = JSON.parse(await readFile(file, 'utf8'))
    if (!saved.transcripts || typeof saved.transcripts !== 'object') saved.transcripts = {}
    return saved
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    return { transcripts: {} }
  }
}

async function writeAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tmp, JSON.stringify(value), { mode: 0o600 })
  await rename(tmp, file)
}
