import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generatePassword, hashPassword, normalizeEmail, validEmail, validPassword, verifyPassword } from './passwords.mjs'
import { emptySettings, normalizeSettings } from './userSettings.mjs'
import { ensureWorkspace, writeManifest, writeSettings as writeWorkspaceFile } from './workspace.mjs'

const SESSION_MS = 14 * 24 * 60 * 60 * 1000

export function defaultDataDir() {
  const url = import.meta.url
  if (!url) return '/tmp/botcamp-data'
  return fileURLToPath(new URL('../../data', url))
}

function emptyData() {
  return { users: [], sessions: [], resources: [], revoked: [] }
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
    mustChangePassword: user.mustChangePassword === true,
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
    mustChangePassword: user.mustChangePassword === true,
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

function newUser({ email, passwordHash, role, quota, id, kernelKey }) {
  return {
    id: id ?? randomBytes(16).toString('base64url'),
    email,
    passwordHash,
    role,
    quota,
    used: 0,
    kernelKey: kernelKey ?? `u_${randomBytes(12).toString('base64url')}`,
    prefs: {},
    prefsVersion: 0,
    mainBotIds: [],
    mustChangePassword: false,
    createdAt: new Date().toISOString(),
  }
}

export async function openStore(dataDir, options = {}) {
  const ledger = options.ledger ?? null
  const dir = dataDir
  const file = path.join(dir, 'accounts.json')
  const namespaceDir = path.join(dir, 'namespaces')
  await mkdir(namespaceDir, { recursive: true })
  let data = emptyData()
  try {
    data = JSON.parse(await readFile(file, 'utf8'))
    if (!Array.isArray(data.users) || !Array.isArray(data.sessions) || !Array.isArray(data.resources)) data = emptyData()
    if (!Array.isArray(data.revoked)) data.revoked = []
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  let reuseLoad = false
  if (ledger) {
    const remote = await ledger.loadAccounts()
    if (remote && Array.isArray(remote.users)) {
      data = {
        users: remote.users,
        sessions: Array.isArray(remote.sessions) ? remote.sessions : [],
        resources: Array.isArray(remote.resources) ? remote.resources : [],
        revoked: Array.isArray(remote.revoked) ? remote.revoked : [],
      }
      reuseLoad = true
    }
  }

  let dummyHash = null
  const ensureDummy = async () => {
    if (!dummyHash) dummyHash = await hashPassword('botcamp-dummy-check')
    return dummyHash
  }
  let chain = Promise.resolve()
  let sessionKey = null

  // 每台函数实例都会把项目库抄进内存。整表覆盖会把别的实例刚写入的账号删掉，
  // 登录若打到旧快照上，库里明明有的用户也会被说成密码错误。每次操作先重读，
  // 再只提交这一次改过的行。配额为 0 只影响发送，不参与登录判断。
  async function refresh() {
    if (!ledger) return
    // 打开仓库时刚读过。引导管理员紧接着再读一遍，冷启动会多等一整轮。
    if (reuseLoad) {
      reuseLoad = false
      return
    }
    const remote = await ledger.loadAccounts()
    if (!remote || !Array.isArray(remote.users)) return
    data = {
      users: remote.users,
      sessions: Array.isArray(remote.sessions) ? remote.sessions : [],
      resources: Array.isArray(remote.resources) ? remote.resources : [],
      revoked: Array.isArray(remote.revoked) ? remote.revoked : [],
    }
  }

  function snapshotAccounts() {
    return {
      users: new Map(data.users.map(user => [user.id, JSON.stringify(user)])),
      sessions: new Map(data.sessions.map(session => [session.tokenHash, JSON.stringify(session)])),
      resources: new Map(data.resources.map(resource => [resource.id, JSON.stringify(resource)])),
      revoked: new Set(data.revoked),
    }
  }

  function accountsChanged(before) {
    if (before.users.size !== data.users.length) return true
    for (const user of data.users) if (before.users.get(user.id) !== JSON.stringify(user)) return true
    if (before.sessions.size !== data.sessions.length) return true
    for (const session of data.sessions) if (before.sessions.get(session.tokenHash) !== JSON.stringify(session)) return true
    if (before.resources.size !== data.resources.length) return true
    for (const resource of data.resources) if (before.resources.get(resource.id) !== JSON.stringify(resource)) return true
    if (before.revoked.size !== data.revoked.length) return true
    for (const hash of data.revoked) if (!before.revoked.has(hash)) return true
    return false
  }

  async function commitDiff(before) {
    if (!accountsChanged(before)) return
    await writeAtomic(file, data)
    if (!ledger) return
    const seenUsers = new Set()
    for (const user of data.users) {
      seenUsers.add(user.id)
      if (before.users.get(user.id) !== JSON.stringify(user)) await ledger.putUser(user)
    }
    for (const id of before.users.keys()) if (!seenUsers.has(id)) await ledger.removeUser(id)
    const seenSessions = new Set()
    for (const session of data.sessions) {
      seenSessions.add(session.tokenHash)
      if (before.sessions.get(session.tokenHash) !== JSON.stringify(session)) await ledger.putSession(session)
    }
    for (const tokenHash of before.sessions.keys()) if (!seenSessions.has(tokenHash)) await ledger.removeSession(tokenHash)
    const seenResources = new Set()
    for (const resource of data.resources) {
      seenResources.add(resource.id)
      if (before.resources.get(resource.id) !== JSON.stringify(resource)) await ledger.putResource(resource)
    }
    for (const id of before.resources.keys()) if (!seenResources.has(id)) await ledger.removeResource(id)
    const seenRevoked = new Set(data.revoked)
    for (const hash of data.revoked) if (!before.revoked.has(hash)) await ledger.putRevoked(hash)
    for (const hash of before.revoked) if (!seenRevoked.has(hash)) await ledger.removeRevoked(hash)
  }

  const exclusive = (fn) => {
    const run = chain.then(async () => {
      await refresh()
      const before = snapshotAccounts()
      const result = await fn()
      await commitDiff(before)
      return result
    })
    chain = run.then(() => {}, () => {})
    return run
  }
  const saveAccounts = async () => {
    await writeAtomic(file, data)
  }
  const hydrated = new Set()

  function claimWorkspace(user) {
    if (!safeKernelKey(user.kernelKey)) return false
    if (data.resources.some(resource => resource.id === user.kernelKey)) return false
    data.resources.push({ id: user.kernelKey, userId: user.id, kind: 'workspace', parentId: null })
    return true
  }

  async function collectFiles(root, rel = '') {
    const out = {}
    let entries = []
    try { entries = await readdir(path.join(root, rel), { withFileTypes: true }) } catch (error) {
      if (error?.code === 'ENOENT') return out
      throw error
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name.length > 180) continue
      const child = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        out[child] = { dir: true }
        Object.assign(out, await collectFiles(root, child))
      } else if (entry.isFile()) {
        out[child] = { text: await readFile(path.join(root, child), 'utf8') }
      }
    }
    return out
  }

  async function hydrateFiles(kernelKey, root, prepared) {
    if (!ledger || hydrated.has(kernelKey)) return
    const tree = prepared ?? await ledger.loadFiles(kernelKey)
    const entries = Object.entries(tree ?? {}).sort((a, b) => Number(Boolean(b[1]?.dir)) - Number(Boolean(a[1]?.dir)))
    for (const [rel, info] of entries) {
      if (typeof rel !== 'string' || rel.includes('..') || path.isAbsolute(rel)) continue
      const abs = path.join(root, rel)
      if (!abs.startsWith(`${root}${path.sep}`) && abs !== root) continue
      if (info?.dir) await mkdir(abs, { recursive: true, mode: 0o700 })
      else {
        await mkdir(path.dirname(abs), { recursive: true })
        await writeFile(abs, info?.text ?? '', { mode: 0o600 })
      }
    }
    hydrated.add(kernelKey)
  }

  async function projectWorkspace(user) {
    if (!safeKernelKey(user.kernelKey)) return null
    const root = await ensureWorkspace(dir, user.kernelKey)
    await hydrateFiles(user.kernelKey, root)
    const mine = data.resources.filter(resource => resource.userId === user.id && resource.kind !== 'workspace')
    await writeManifest(root, {
      workspaceId: user.kernelKey,
      sessions: mine.filter(resource => resource.kind === 'session').map(resource => resource.id),
      bots: mine.filter(resource => resource.kind === 'bot').map(resource => resource.id),
      settings: { ...(user.prefs ?? {}) },
    })
    await writeWorkspaceFile(root, { prefs: { ...(user.prefs ?? {}) } })
    if (ledger) await ledger.saveFiles(user.kernelKey, await collectFiles(root))
    return root
  }

  async function writeNamespace(kernelKey, saved) {
    const transcriptFile = path.join(namespaceDir, `${kernelKey}.json`)
    await writeAtomic(transcriptFile, saved)
    if (ledger) await ledger.saveNamespace(kernelKey, saved)
  }

  function revokeSessions(userId, keepHash) {
    const kept = []
    for (const session of data.sessions) {
      if (session.userId !== userId || session.tokenHash === keepHash) {
        kept.push(session)
        continue
      }
      if (!data.revoked.includes(session.tokenHash)) data.revoked.push(session.tokenHash)
    }
    data.sessions = kept
    if (data.revoked.length > 200) data.revoked.splice(0, data.revoked.length - 200)
  }

  const api = {
    idle: () => chain,
    publicUser,
    exclusive,
    async bootstrap(env) {
      sessionKey = sessionSecret(env)
      return exclusive(async () => {
        const creds = bootstrapCredentials(env)
        const emailOk = Boolean(creds) && validEmail(normalizeEmail(creds.email)) && typeof creds.password === 'string' && creds.password.length >= 8
        if (!emailOk) return { created: false, empty: data.users.length === 0 }
        const email = normalizeEmail(creds.email)
        const id = stableUserId(email)
        const kernelKey = stableKernelKey(email)
        const existing = data.users.find(user => user.email === email)
        if (!existing) {
          if (data.users.length > 0) return { created: false, empty: false }
          const createdUser = newUser({
            email,
            passwordHash: await hashPassword(creds.password),
            role: 'admin',
            quota: defaultQuota(env),
            id,
            kernelKey,
          })
          data.users.push(createdUser)
          claimWorkspace(createdUser)
          await projectWorkspace(createdUser)
          await saveAccounts()
          return { created: true, empty: false }
        }
        let changed = false
        if (existing.id !== id) {
          const previous = existing.id
          existing.id = id
          for (const session of data.sessions) if (session.userId === previous) session.userId = id
          for (const resource of data.resources) if (resource.userId === previous) resource.userId = id
          changed = true
        }
        if (existing.kernelKey !== kernelKey) {
          existing.kernelKey = kernelKey
          changed = true
        }
        if (claimWorkspace(existing)) changed = true
        // 工作区没变就别整表上传。冷启动每次都重写，会让第一次打开列表多等一轮。
        if (changed) {
          await projectWorkspace(existing)
          await saveAccounts()
        }
        return { created: false, empty: false }
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
      const generated = password === undefined || password === null || password === ''
      const secret = generated ? generatePassword() : password
      if (!validEmail(normalized)) return { error: '请填写有效的邮箱。' }
      if (!validPassword(secret)) return { error: '密码至少 8 位。' }
      if (role !== 'admin' && role !== 'user') return { error: '角色无效。' }
      if (!Number.isInteger(quota) || quota < 0) return { error: '配额必须是非负整数。' }
      const passwordHash = await hashPassword(secret)
      return exclusive(async () => {
        if (data.users.some(user => user.email === normalized)) return { error: '这个邮箱已经有账号。' }
        const user = newUser({ email: normalized, passwordHash, role, quota })
        user.mustChangePassword = true
        data.users.push(user)
        claimWorkspace(user)
        await projectWorkspace(user)
        await saveAccounts()
        return { user: publicUser(user), password: secret }
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
        if (passwordHash) {
          user.passwordHash = passwordHash
          user.mustChangePassword = true
          revokeSessions(user.id, null)
        }
        await saveAccounts()
        return { user: publicUser(user) }
      })
    },
    async changePassword(userId, current, next, keepToken) {
      if (!validPassword(next)) return { error: '新密码至少 8 位。' }
      const candidate = typeof current === 'string' && current.length <= 200 ? current : ''
      if (candidate !== '' && candidate === next) return { error: '新密码不能和当前密码相同。' }
      const dummy = await ensureDummy()
      const hash = await exclusive(async () => data.users.find(user => user.id === userId)?.passwordHash ?? null)
      const ok = await verifyPassword(candidate, hash ?? dummy)
      if (!ok || !hash || candidate === '') return { error: '当前密码不正确。' }
      const passwordHash = await hashPassword(next)
      const keepHash = typeof keepToken === 'string' && keepToken.length >= 20 ? hashToken(keepToken) : null
      return exclusive(async () => {
        const user = data.users.find(entry => entry.id === userId)
        if (!user) return { error: '没有这个用户。', status: 404 }
        user.passwordHash = passwordHash
        user.mustChangePassword = false
        revokeSessions(userId, keepHash)
        await saveAccounts()
        return { user: publicUser(user) }
      })
    },
    async resetPassword(id) {
      const password = generatePassword()
      const passwordHash = await hashPassword(password)
      return exclusive(async () => {
        const user = data.users.find(entry => entry.id === id)
        if (!user) return { error: '没有这个用户。', status: 404 }
        user.passwordHash = passwordHash
        user.mustChangePassword = true
        revokeSessions(id, null)
        await saveAccounts()
        return { user: publicUser(user), password }
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
      const expiresAt = Date.now() + SESSION_MS
      const token = sessionKey ? signSession(userId, expiresAt, sessionKey) : randomBytes(32).toString('base64url')
      const tokenHash = hashToken(token)
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
        if (data.revoked.includes(tokenHash)) return null
        const now = Date.now()
        const session = data.sessions.find(entry => entry.tokenHash === tokenHash)
        if (session) {
          if (session.expiresAt <= now) {
            data.sessions = data.sessions.filter(entry => entry !== session)
            await saveAccounts()
            return null
          }
          return principal(data.users.find(user => user.id === session.userId))
        }
        if (!sessionKey || !token.startsWith('v1.')) return null
        const userId = verifySession(token, sessionKey)
        if (!userId) return null
        return principal(data.users.find(user => user.id === userId))
      })
    },
    // 打开页面只读一次账本。会话、资源和设置在同一次重读里拿齐。
    async accountContext(token) {
      if (typeof token !== 'string' || token.length < 20) return null
      const tokenHash = hashToken(token)
      return exclusive(async () => {
        if (data.revoked.includes(tokenHash)) return null
        const now = Date.now()
        const session = data.sessions.find(entry => entry.tokenHash === tokenHash)
        let userId = null
        if (session) {
          if (session.expiresAt <= now) {
            data.sessions = data.sessions.filter(entry => entry !== session)
            await saveAccounts()
            return null
          }
          userId = session.userId
        } else if (sessionKey && token.startsWith('v1.')) {
          userId = verifySession(token, sessionKey)
        }
        if (!userId) return null
        const user = data.users.find(entry => entry.id === userId)
        if (!user) return null
        let settings = emptySettings()
        if (safeKernelKey(user.kernelKey)) {
          const saved = await readNamespace(path.join(namespaceDir, `${user.kernelKey}.json`))
          settings = saved.settings
        }
        return {
          user: principal(user),
          resources: data.resources.map(resource => ({ ...resource })),
          settings,
        }
      })
    },
    async deleteSession(token) {
      if (typeof token !== 'string' || token.length < 20) return
      const tokenHash = hashToken(token)
      await exclusive(async () => {
        data.sessions = data.sessions.filter(entry => entry.tokenHash !== tokenHash)
        if (!data.revoked.includes(tokenHash)) data.revoked.push(tokenHash)
        if (data.revoked.length > 200) data.revoked.splice(0, data.revoked.length - 200)
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
        claimWorkspace(user)
        await projectWorkspace(user)
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
        claimWorkspace(user)
        await projectWorkspace(user)
        await saveAccounts()
        return principal(user)
      })
    },
    async commitAccess(userId, access) {
      // 列表每次都会过一遍归属。没有新认领时重写工作区，会把全部文件再上传一次。
      if (access.pending().length === 0 && access.released().length === 0) return
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
        const user = data.users.find(entry => entry.id === userId)
        if (user && claimWorkspace(user)) changed = true
        if (!changed || !user) return
        await projectWorkspace(user)
        await saveAccounts()
      })
    },
    async rememberPage(userId, sessionId, items) {
      if (typeof sessionId !== 'string' || !Array.isArray(items)) return
      await exclusive(async () => {
        const user = data.users.find(entry => entry.id === userId)
        if (!user || !safeKernelKey(user.kernelKey)) return
        const saved = await readNamespace(path.join(namespaceDir, `${user.kernelKey}.json`))
        saved.transcripts[sessionId] = { items: items.slice(-200) }
        await writeNamespace(user.kernelKey, saved)
      })
    },
    async appendItem(userId, sessionId, item) {
      if (typeof sessionId !== 'string' || !item || typeof item !== 'object') return
      await exclusive(async () => {
        const user = data.users.find(entry => entry.id === userId)
        if (!user || !safeKernelKey(user.kernelKey)) return
        const saved = await readNamespace(path.join(namespaceDir, `${user.kernelKey}.json`))
        const page = saved.transcripts[sessionId] ?? { items: [] }
        const items = Array.isArray(page.items) ? page.items : []
        const same = items.some(entry => entry.kind === item.kind && entry.time === item.time && entry.text === item.text)
        if (!same) items.push(item)
        saved.transcripts[sessionId] = { items: items.slice(-200) }
        await writeNamespace(user.kernelKey, saved)
      })
    },
    kernelKey(userId) {
      return exclusive(async () => data.users.find(user => user.id === userId)?.kernelKey ?? '')
    },
    readSettings(userId) {
      return exclusive(async () => {
        const user = data.users.find(entry => entry.id === userId)
        if (!user || !safeKernelKey(user.kernelKey)) return emptySettings()
        const saved = await readNamespace(path.join(namespaceDir, `${user.kernelKey}.json`))
        return normalizeSettings(saved.settings)
      })
    },
    async writeSettings(userId, settings) {
      await exclusive(async () => {
        const user = data.users.find(entry => entry.id === userId)
        if (!user || !safeKernelKey(user.kernelKey)) return
        const saved = await readNamespace(path.join(namespaceDir, `${user.kernelKey}.json`))
        saved.settings = normalizeSettings(settings)
        await writeNamespace(user.kernelKey, saved)
      })
    },
    async writeUsage(userId, usage) {
      await exclusive(async () => {
        const user = data.users.find(entry => entry.id === userId)
        if (!user || !safeKernelKey(user.kernelKey)) return
        const saved = await readNamespace(path.join(namespaceDir, `${user.kernelKey}.json`))
        saved.usage = usage
        await writeNamespace(user.kernelKey, saved)
      })
    },
    ensureUserWorkspace(userId) {
      return exclusive(async () => {
        const user = data.users.find(entry => entry.id === userId)
        if (!user || !safeKernelKey(user.kernelKey)) return null
        const claimed = claimWorkspace(user)
        const root = await projectWorkspace(user)
        if (claimed) await saveAccounts()
        return root
      })
    },
    // Listing must not upload the tree. The host retries until this directory can be read.
    localWorkspace(userId) {
      return exclusive(async () => {
        const user = data.users.find(entry => entry.id === userId)
        if (!user || !safeKernelKey(user.kernelKey)) return null
        const claimed = claimWorkspace(user)
        const root = await ensureWorkspace(dir, user.kernelKey)
        if (claimed) await saveAccounts()
        return root
      })
    },
    syncWorkspace(userId) {
      return exclusive(async () => {
        const user = data.users.find(entry => entry.id === userId)
        if (!user || !safeKernelKey(user.kernelKey) || !ledger) return
        const root = await ensureWorkspace(dir, user.kernelKey)
        await ledger.saveFiles(user.kernelKey, await collectFiles(root))
      })
    },
  }
  if (ledger) {
    await writeAtomic(file, data)
    const namespaces = typeof ledger.loadNamespaceMap === 'function' ? await ledger.loadNamespaceMap() : null
    const fileTrees = typeof ledger.loadAllFileTrees === 'function' ? await ledger.loadAllFileTrees() : null
    for (const user of data.users) {
      if (!safeKernelKey(user.kernelKey)) continue
      const remoteBody = namespaces
        ? namespaces.get(user.kernelKey) ?? null
        : await ledger.loadNamespace(user.kernelKey)
      if (remoteBody) await writeAtomic(path.join(namespaceDir, `${user.kernelKey}.json`), remoteBody)
      const root = await ensureWorkspace(dir, user.kernelKey)
      if (fileTrees) await hydrateFiles(user.kernelKey, root, fileTrees.get(user.kernelKey) ?? {})
      else await hydrateFiles(user.kernelKey, root)
    }
  }
  return api
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex')
}

function stableUserId(email) {
  return createHash('sha256').update(`botcamp-user:${email}`).digest('base64url').slice(0, 22)
}

function stableKernelKey(email) {
  return `u_${createHash('sha256').update(`botcamp-kernel:${email}`).digest('base64url').slice(0, 16)}`
}

// Instances do not share a disk. The bootstrap admin id is derived from the email,
// and the session is signed with a key every instance can rebuild from the env.
function sessionSecret(env) {
  if (typeof env?.BOTCAMP_SESSION_SECRET === 'string' && env.BOTCAMP_SESSION_SECRET.length >= 16) return env.BOTCAMP_SESSION_SECRET
  const password = typeof env?.BOTCAMP_ADMIN_PASSWORD === 'string' ? env.BOTCAMP_ADMIN_PASSWORD : ''
  if (password.length < 8) return null
  return createHash('sha256').update(`botcamp-session:${password}`).digest('base64url')
}

function signSession(userId, expiresAt, secret) {
  const payload = Buffer.from(JSON.stringify({ uid: userId, exp: expiresAt })).toString('base64url')
  const sig = createHmac('sha256', secret).update(payload).digest('base64url')
  return `v1.${payload}.${sig}`
}

function verifySession(token, secret) {
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== 'v1') return null
  const expected = createHmac('sha256', secret).update(parts[1]).digest('base64url')
  const actual = Buffer.from(parts[2])
  const wanted = Buffer.from(expected)
  if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) return null
  let body
  try { body = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) } catch { return null }
  if (!body || typeof body.uid !== 'string' || typeof body.exp !== 'number' || body.exp <= Date.now()) return null
  return body.uid
}

function safeKernelKey(kernelKey) {
  return typeof kernelKey === 'string' && /^u_[A-Za-z0-9_-]{8,}$/.test(kernelKey)
}

async function readNamespace(file) {
  let saved
  try {
    saved = JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    saved = {}
  }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) saved = {}
  if (!saved.transcripts || typeof saved.transcripts !== 'object' || Array.isArray(saved.transcripts)) saved.transcripts = {}
  saved.settings = normalizeSettings(saved.settings ?? emptySettings())
  return saved
}

async function writeAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tmp, JSON.stringify(value), { mode: 0o600 })
  await rename(tmp, file)
}
