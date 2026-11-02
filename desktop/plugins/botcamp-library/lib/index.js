/**
 * BotCamp Library — host half. Derived from @s1lencewill/dsh-markdown-reader
 * (BSD-3-Clause); every route is library-gated; the workspace adds atomic writes.
 * routes (/md-reader/read, /md-reader/stat, /md-reader/raw) plus the vendored-asset route
 * (/md-reader/assets/*, KaTeX + optional Mermaid drop-in) on the shared
 * webserver, and an agent announcement through the system-prompt section
 * mechanism. The browser half (exports "./client") is served by
 * client-modules from the same package's dsh.client declaration.
 *
 * Security model (mirrors dsh-aionui-panel's workspace gate): every fs route
 * canonicalizes the requested project root with realpath and requires it to
 * be a registered workspace (or a directory inside one); the resolved file
 * is realpathed again and prefix-checked, so `..` and symlink escapes are
 * rejected. Read routes are read-only; write routes are limited to docs/ and use
 * temp-file + rename, and deletions go to the hidden .trash/ folder.
 *
 * Zero build, zero runtime dependencies: pure Node ESM.
 * @module @botcamp/dsh-library
 */

import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, open, readdir, realpath, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Required services: the route registry and the prompt band. */
export const inject = ['webServer', 'systemPrompt']

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 220

/** Model-facing announcement: plugin presence, capabilities, and limits. */
export const MARKDOWN_READER_GUIDANCE = `本机已安装 BotCamp 文档库插件（BotCamp Library）。团队规范以 docs/团队规范/index.md 为准；文档在当前登录账号的 workspace/docs 下，可以在 BotCamp 的「文档库」里阅读、创建、编辑、重命名、删除（删除进 .trash，不做版本管理）。

【硬性规范】
1. 文档库是团队唯一的持久知识库，聊天记录不是知识库。账号定位、受众、选题、脚本、视觉规范、数据复盘、SOP、交付物等长期内容必须写进 docs/，不能只留在聊天里。
2. 一篇文档只讲一个主题；一个主题只保留一个 canonical 文档。有新结论时原地更新，不另建“最终版/最终版2”，不做版本历史。
3. 禁止 frontmatter，禁止 YAML 头；只写最终稿，不把过程稿、废弃方案留在文档里。
4. 文档路径就是真实文件系统名称；新文档默认 docs/<slug>/index.md，短文档也可以 docs/<name>.md。
5. 图片/视频放在该文档的 assets/ 下；跨文档原始素材放 media/。正文用相对路径引用，图片居中，视频不自动播放。
6. 不把密码、API Key、Cookie、私信内容、客户隐私写进文档。

【如何使用文档库】
1. 正式产出前先读 docs/团队规范/index.md；需要模板时读 docs/团队规范/文档模板.md。
2. 先查重：已有同主题文档就更新，不重复新建。
3. 新建文档：
   curl -sS -X POST http://127.0.0.1:8765/md-reader/create -H 'content-type: application/json' -d '{"title":"标题","parent":"docs"}'
   响应里有 value.path 和 value.link。
4. 新建文件夹：
   curl -sS -X POST http://127.0.0.1:8765/md-reader/mkdir -H 'content-type: application/json' -d '{"name":"文件夹名","parent":"docs"}'
5. 写入/更新正文（path 为 docs/.../index.md）：
   curl -sS -X POST http://127.0.0.1:8765/md-reader/write -H 'content-type: application/json' -d '{"path":"docs/.../index.md","content":"# 标题\n\n正文"}'
6. 回复用户时，必须使用接口返回的 value.link 作为 Markdown 链接：[打开文档](value.link)。不能只给路径，不能手写或猜测链接。
7. 链接格式为 botcamp://doc?path=<URL 编码后的 path>。只有文档真实存在时才给链接；创建失败或找不到文档时，明确说明失败原因，不要假装成功。

用户提到「文档库 / 阅读 / 打开某篇文档 / 保存成文档 / 团队规范」时即指本插件。`

// ---------------------------------------------------------------------------
// Error envelope (PanelError-shaped so clients can share the same decoding).
// ---------------------------------------------------------------------------

/** One structured error. */

/** Public account research cache: 5 minutes, process-local, no credentials. */
const researchCache = new Map()
const RESEARCH_TTL_MS = 5 * 60_000
const CHROME_CANDIDATES = [
  process.env.BOTCAMP_CHROME_PATH,
  '/Users/phosa/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
].filter(Boolean)


/** Successful name -> public user id lookups. IDs are public, never credentials. */
const NAME_CACHE_FILE = join(homedir(), '.botcamp', 'library-research-names.json')
function readNameCache() {
  try {
    return JSON.parse(readFileSync(NAME_CACHE_FILE, 'utf8'))
  } catch {
    return {}
  }
}
function writeNameCache(key, id) {
  try {
    const cache = readNameCache()
    cache[key] = { id, at: Date.now() }
    writeFileSync(NAME_CACHE_FILE, JSON.stringify(cache, null, 2))
  } catch {
    // A cache write must never fail the research request.
  }
}
function cachedNameId(key) {
  const entry = readNameCache()[key]
  return entry !== undefined && typeof entry.id === 'string' && Date.now() - Number(entry.at ?? 0) < 30 * 24 * 60 * 60_000 ? entry.id : null
}

function extractHeyboxId(account) {
  const text = String(account ?? '')
  const fromUrl = text.match(/\/app\/user\/profile\/(\d+)/) ?? text.match(/[?&]user_id=(\d+)/)
  if (fromUrl !== null) return fromUrl[1]
  const bare = text.trim().match(/^\d{4,}$/)
  return bare === null ? null : bare[0]
}

function extractXhsId(account) {
  const text = String(account ?? '')
  const fromUrl = text.match(/\/user\/profile\/([^/?#\s]+)/)
  return fromUrl === null ? null : fromUrl[1]
}

function loginWall(text) {
  return /验证码登录|密码登录/.test(text) && !/粉丝/.test(text)
}

/**
 * Open one public profile in a throwaway headless browser. Public pages only;
 * no cookies, no login, no credential handling. The platform adapter owns the
 * URL shape and the page parser.
 */
async function researchPublicProfile({ platform, account }) {
  const kind = String(platform ?? '').toLowerCase()
  let url = null
  let searchName = null
  if (kind === 'heybox' || kind === '小黑盒' || kind === 'xiaoheihe') {
    const id = extractHeyboxId(account)
    if (id !== null) url = `https://www.xiaoheihe.cn/app/user/profile/${id}`
    else {
      searchName = String(account ?? '').replace(/^小黑盒\s*[:：]\s*/, '').trim()
      const cachedId = cachedNameId(`小黑盒:${searchName}`)
      if (cachedId !== null) {
        url = `https://www.xiaoheihe.cn/app/user/profile/${cachedId}`
        searchName = null
      }
    }
    if (url === null && searchName === '') return { ok: false, code: 'need-account-id', message: '小黑盒需要账号名、主页链接或数字 heybox_id。' }
  } else if (kind === 'xiaohongshu' || kind === '小红书' || kind === 'xhs') {
    const id = extractXhsId(account)
    if (id === null) return { ok: false, code: 'need-account-id', message: '小红书需要主页链接或用户 ID。' }
    url = `https://www.xiaohongshu.com/user/profile/${id}`
  } else {
    return { ok: false, code: 'unsupported-platform', message: '目前只支持小黑盒和小红书公开主页。' }
  }
  const cached = url === null ? undefined : researchCache.get(url)
  if (cached !== undefined && Date.now() - cached.at < RESEARCH_TTL_MS) return { ok: true, value: cached.value }

  const { chromium } = await import('playwright-core')
  const executablePath = CHROME_CANDIDATES.find((candidate) => existsSync(candidate))
  const browser = await chromium.launch({ headless: false, executablePath, args: ['--no-sandbox'] })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
    if (searchName !== null) {
      const searchUrl = `https://www.xiaoheihe.cn/app/search/list?q=${encodeURIComponent(searchName)}&search_type=user`
      const userResponse = page.waitForResponse(
        (response) => response.url().includes('/bbs/app/api/general/search/v1') && response.url().includes('search_type=user'),
        { timeout: 20_000 },
      ).catch(() => null)
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 25_000 })
      const response = await userResponse
      const body = response === null ? null : await response.json().catch(() => null)
      const items = body?.result?.items ?? []
      const users = items.filter((item) => item?.type === 'user' && item?.info?.username)
      const normalized = (value) => String(value ?? '').toLowerCase().replace(/\s+/gu, '')
      const exact = users.find((item) => normalized(item.info.username) === normalized(searchName))
      const near = users.filter((item) => {
        if (item === exact) return false
        const name = normalized(item.info.username)
        const query = normalized(searchName)
        // Very short names like "Ai" share a token with almost every query; they
        // are not useful candidates for a human choice.
        if (name.length < 3) return false
        return name.includes(query) || query.includes(name)
      })
      const match = exact ?? (near.length === 1 ? near[0] : undefined)
      if (match?.info?.userid === undefined) {
        const candidates = near.slice(0, 8).map((item) => ({
          name: item.info.username,
          id: String(item.info.userid ?? ''),
          meta: item.info.rec_tag ?? '',
        }))
        if (candidates.length === 0) {
          return {
            ok: false,
            code: 'needs-human',
            message: `按“${searchName}”没有拿到可用候选；请在可见浏览器里搜索并点选目标账号。`,
            searchUrl: `https://www.xiaoheihe.cn/app/search/list?q=${encodeURIComponent(searchName)}&search_type=user`,
          }
        }
        return {
          ok: false,
          code: 'account-ambiguous',
          message: `没有唯一匹配“${searchName}”，请让用户从相近账号中选择，或提供主页链接。`,
          candidates,
        }
      }
      url = `https://www.xiaoheihe.cn/app/user/profile/${match.info.userid}`
      writeNameCache(`小黑盒:${searchName}`, String(match.info.userid))
    }
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 })
    await page.waitForTimeout(6_000)
    const title = await page.title()
    const text = await page.locator('body').innerText()
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
    const back = lines.indexOf('返回')
    const name = back >= 0 ? lines[back + 1] ?? '' : ''
    const level = back >= 0 && /^Lv\./i.test(lines[back + 2] ?? '') ? lines[back + 2] : ''
    const bio = back >= 0 && !/^Lv\./i.test(lines[back + 2] ?? '') ? lines[back + 2] ?? '' : lines[back + 3] ?? ''
    const numberBefore = (label) => {
      const index = lines.indexOf(label)
      const n = index > 0 ? Number(lines[index - 1].replace(/[^\d]/g, '')) : NaN
      return Number.isFinite(n) ? n : null
    }
    const posts = await page.locator('a[href*="/app/bbs/link/"]').evaluateAll((anchors) => anchors.slice(0, 20).map((a) => {
      const lines = (a.innerText ?? '').split('\n').map((line) => line.trim()).filter(Boolean)
      const date = lines.find((line) => /^(?:\d{4}-)?\d{2}-\d{2}$/.test(line) || /^(?:\d+分钟前|\d+小时前|\d+天前|昨天|前天|今天)/.test(line)) ?? ''
      const body = lines.slice(2).filter((line) => line !== date && !/^共\d+张$/.test(line) && !/^\d+$/.test(line))
      return { title: body.join(' ').slice(0, 240), date, url: a.href }
    }))
    const value = {
      platform: kind === '小黑盒' || kind === 'xiaoheihe' ? 'heybox' : kind,
      url,
      title,
      name,
      level,
      bio,
      stats: { following: numberBefore('关注'), followers: numberBefore('粉丝'), likes: numberBefore('获赞与收藏') },
      posts,
      needsAuth: loginWall(text),
      text: text.slice(0, 12_000),
      fetchedAt: Date.now(),
    }
    researchCache.set(url, { at: Date.now(), value })
    return { ok: true, value }
  } catch (error) {
    return { ok: false, code: 'research-failed', message: error instanceof Error ? error.message : String(error) }
  } finally {
    await browser.close().catch(() => {})
  }
}

async function handleResearch(payload, res) {
  const result = await researchPublicProfile({
    platform: payload.platform,
    account: payload.account ?? payload.url ?? payload.query,
  })
  if (result.ok) {
    json(res, { ok: true, value: result.value })
    return
  }
  const status = ['need-account-id', 'account-not-found', 'account-ambiguous', 'needs-human'].includes(result.code) ? 422 : result.code === 'unsupported-platform' ? 400 : 502
  const envelope = FAIL(result.code, result.message)
  if (result.candidates !== undefined) envelope.candidates = result.candidates
  if (result.searchUrl !== undefined) envelope.searchUrl = result.searchUrl
  json(res, envelope, status)
}

const FAIL = (code, message) => ({ ok: false, error: { code, message } })

/** Write one JSON envelope response. */
function json(res, envelope, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(envelope))
}

/** Read a JSON request body into an unknown value; null when unparseable. */
async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const buffer = chunk
    chunks.push(buffer)
    total += buffer.length
    if (total > 32 * 1024 * 1024) return null
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text === '') return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Extract the required string field from a JSON object payload. */
function strField(payload, key) {
  if (typeof payload !== 'object' || payload === null) return null
  const value = payload[key]
  return typeof value === 'string' && value !== '' ? value : null
}

// ---------------------------------------------------------------------------
// Workspace gate (same canonicalization contract as dsh-aionui-panel).
// ---------------------------------------------------------------------------

/** Normalize a path for prefix comparison (separators + trailing slash; case on win32). */
function normalizeForPrefix(value) {
  const normalized = value.replaceAll('\\', '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** Whether `child` lives inside (or equals) `root`. */
function isPathInside(root, child) {
  if (root === '' || child === '') return false
  const normRoot = normalizeForPrefix(root)
  const normChild = normalizeForPrefix(child)
  if (normChild === normRoot) return true
  return normChild.startsWith(`${normRoot}/`)
}

/**
 * Gate every request to one fixed BotCamp library root.
 *
 * The client still sends `root` for upstream compatibility, but this fork
 * deliberately ignores it: the library is a first-class root, not a workspace,
 * so a stale or hostile `root` parameter cannot widen the read scope.
 *
 * @param {string} root - absolute library root.
 * @returns a gate function: {ok:true, canonical} or {ok:false, error}.
 */
function createLibraryGate(root) {
  return async () => {
    let canonical
    try {
      canonical = await realpath(root)
    } catch {
      return { ok: false, error: { code: 'library-missing', message: 'library root does not resolve on disk' } }
    }
    return { ok: true, canonical }
  }
}

// ---------------------------------------------------------------------------
// Limits and mime maps.
// ---------------------------------------------------------------------------

/** Default library root: per-device, outside any code workspace. */
const DEFAULT_LIBRARY_ROOT = join(homedir(), 'BotCamp', 'library')

/** Resolve the library root from the environment (BotCamp sets it on first run). */
function resolveLibraryRoot() {
  const configured = process.env.BOTCAMP_LIBRARY_ROOT
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  // The desktop host is started per account with DSH_HOME pointing at
  // ~/.botcamp/accounts/<id>; keep each user's docs inside that workspace.
  const accountHome = process.env.DSH_HOME
  if (typeof accountHome === 'string' && accountHome.trim() !== '') {
    return join(accountHome.trim(), 'bot', 'workspace')
  }
  return DEFAULT_LIBRARY_ROOT
}

// ---------------------------------------------------------------------------
// Account onboarding (platform-level, one profile per account)
// ---------------------------------------------------------------------------

const ONBOARDING_VERSION = 1
const ONBOARDING_DOC = 'docs/账号/账号定位.md'

/** Account-scoped initialization state lives beside the docs workspace. */
function onboardingPath(libraryRoot) {
  return join(dirname(libraryRoot), 'onboarding.json')
}

function readOnboarding(libraryRoot) {
  try {
    const value = JSON.parse(readFileSync(onboardingPath(libraryRoot), 'utf8'))
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

function onboardingComplete(libraryRoot) {
  const value = readOnboarding(libraryRoot)
  return value?.version === ONBOARDING_VERSION && value?.complete === true ? value : null
}

function clampText(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

/** Validate and normalize the one-time account interview payload. */
function normalizeOnboarding(payload) {
  const platform = clampText(payload?.platform, 60)
  const account = clampText(payload?.account, 240)
  const accountId = clampText(payload?.accountId, 80)
  const audience = clampText(payload?.audience, 240)
  const goal = clampText(payload?.goal, 300)
  const resources = clampText(payload?.resources, 800)
  const rawIntervention = Number(payload?.intervention)
  const intervention = Number.isFinite(rawIntervention) ? Math.max(0, Math.min(100, Math.round(rawIntervention))) : 40
  if (platform === '') throw new Error('请选择主要平台')
  if (account === '') throw new Error('请填写账号链接或账号 ID')
  return {
    version: ONBOARDING_VERSION,
    complete: true,
    platform,
    account,
    accountId,
    audience,
    goal,
    resources,
    intervention,
    completedAt: Date.now(),
  }
}

const STANDARDS_DIR = fileURLToPath(new URL('../standards/', import.meta.url))

/** Seed the shared rules and template once per account, without overwriting edits. */
async function seedStandards(libraryRoot) {
  const pairs = [
    ['团队规范.md', 'docs/团队规范/index.md'],
    ['文档模板.md', 'docs/团队规范/文档模板.md'],
  ]
  for (const [source, target] of pairs) {
    const destination = join(libraryRoot, target)
    try {
      await stat(destination)
      continue
    } catch { /* absent */ }
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, await readFile(join(STANDARDS_DIR, source), 'utf8'), { mode: 0o600 })
  }
}

/** Write the canonical account-positioning document (no frontmatter, no versions). */
async function writeOnboardingDoc(libraryRoot, profile) {
  const target = join(libraryRoot, ONBOARDING_DOC)
  await mkdir(dirname(target), { recursive: true })
  const body = `# 账号定位\n\n> 这份文档由首次初始化生成，后续由主编和团队原地更新。\n\n## 平台\n\n${profile.platform}\n\n## 账号\n\n${profile.account}\n\n## 目标受众\n\n${profile.audience || '待补充'}\n\n## 目标\n\n${profile.goal || '待补充'}\n\n## 现有资源与限制\n\n${profile.resources || '待补充'}\n\n## 干预度\n\n${profile.intervention}/100\n\n- 0–25：只提醒会导致返工、合规或交付失败的关键缺口。\n- 26–55：关键缺口必须提醒，最多附带一条高价值建议。\n- 56–80：可以主动给结构优化和下一步建议。\n- 81–100：高强度挑战假设、给替代方案，但最终由用户决定。\n\n## 相关文档\n\n- [团队规范](botcamp://doc?path=docs%2F%E5%9B%A2%E9%98%9F%E8%A7%84%E8%8C%83%2Findex.md)\n`
  const tmp = target + '.tmp'
  await writeFile(tmp, body, { mode: 0o600 })
  await rename(tmp, target)
  return { path: ONBOARDING_DOC, link: `botcamp://doc?path=${encodeURIComponent(ONBOARDING_DOC)}` }
}

async function handleOnboardingGet(libraryRoot, res) {
  const profile = readOnboarding(libraryRoot)
  json(res, { ok: true, value: { complete: onboardingComplete(libraryRoot) !== null, profile } })
}

async function handleOnboardingSave(libraryRoot, payload, res) {
  let profile
  try {
    profile = normalizeOnboarding(payload)
  } catch (error) {
    json(res, FAIL('onboarding-invalid', error.message), 400)
    return
  }
  const path = onboardingPath(libraryRoot)
  await mkdir(dirname(path), { recursive: true })
  const tmp = path + '.tmp'
  await writeFile(tmp, JSON.stringify(profile, null, 2), { mode: 0o600 })
  await rename(tmp, path)
  await seedStandards(libraryRoot)
  const doc = await writeOnboardingDoc(libraryRoot, profile)
  json(res, { ok: true, value: { profile, doc } })
}

/** Model-facing account profile and intervention policy. */
function onboardingPrompt(libraryRoot) {
  const profile = readOnboarding(libraryRoot)
  if (profile === null || profile.complete !== true) {
    return `【账号初始化：未完成】
直接在 BotCamp 聊天里向用户提问，不要用表格、表单或弹框。一次只问一个问题。

先收集，再研究，再问缺口：
1. 主要平台。用户已经说过的不要重复问。
2. 账号名、主页链接或账号 ID。已经有账号时，先要账号名或链接；接口支持按昵称搜用户。
拿到账号后立刻研究公开信息，不要先问受众、目标或资源。优先调用平台研究接口：
curl -sS -X POST http://127.0.0.1:8765/md-reader/research -H 'content-type: application/json' -d '{"platform":"小黑盒","account":"<主页链接或数字ID>"}'
- 小黑盒：传账号名或公开主页 https://www.xiaoheihe.cn/app/user/profile/<数字ID> 都可以。接口会先按昵称搜用户，再返回昵称、等级、简介、关注/粉丝/获赞、近期帖子。重名或搜不到时，再向用户要主页链接；不要瞎猜。
- 小红书：把 platform 改为“小红书”，account 传主页链接或用户 ID；公开页能看到多少就报多少。
- 其他平台：先用浏览器打开主页，读取公开内容。
接口返回 account-ambiguous 时，把候选账号（昵称、ID、粉丝/内容数）列给用户，让用户选；不要自己猜。候选为空或返回 needs-human/CAPTCHA 时，用可见浏览器打开搜索页，请用户完成验证或在窗口里点选目标账号，再继续。接口返回 need-account-id 时，只问用户要主页链接或 ID；返回 needsAuth 时，请用户在 BotCamp 浏览器登录后交还，或给公开链接；绝不要索要密码、Cookie、验证码。
如果页面要求登录、验证码或空数据：告诉用户“这个页面需要登录/授权，我目前只能看到公开部分”，并请用户在 BotCamp 浏览器里登录后交还，或提供公开主页链接。绝不要向用户索要密码、Cookie 或验证码，也不要把这些写进文档。

研究完成后，先用一小段话告诉用户你确认了什么、哪些查不到，再只问用户无法从公开信息判断的内容：
3. 目标受众或当前定位（如果主页已经能判断，就直接确认，不再问）
4. 当前最想解决的问题
5. 每周可投入时间和限制
平台和账号是必填；其余可以“跳过”。收齐后必须 POST http://127.0.0.1:8765/md-reader/onboarding，字段 platform,account,audience,goal,resources；只有返回 ok:true 才算完成。然后给最低成本启动方案，不要提前给选题建议。
干预度不要问，也不要提。默认就是 40，静默记录。只有用户主动说“多给我建议/多管我一点”或“少提建议/别管太多”时，才在后台把干预度调高或调低并保存，不要把数值、档位或调整过程告诉用户。`
  }
  const n = typeof profile.intervention === 'number' ? profile.intervention : 40
  return `【账号初始化资料（权威事实）】
下面的账号资料已经由用户在初始化面板确认，优先于任何旧的欢迎语、开场白或“资料为空”的旧消息；不要再说没看到账号信息。
- 平台：${profile.platform}
- 账号：${profile.account}
${profile.accountId ? `- 账号 ID：${profile.accountId}\n` : ''}- 目标受众：${profile.audience || '待补充'}
- 目标：${profile.goal || '待补充'}
- 资源与限制：${profile.resources || '待补充'}
- 干预度：${n}/100

【公开账号研究（优先用这个）】
用户给出账号链接或 ID 后，先调用公开研究接口，不要先靠猜或手写网页抓取：
curl -sS -X POST http://127.0.0.1:8765/md-reader/research -H 'content-type: application/json' -d '{"platform":"小黑盒","account":"<主页链接或数字ID>"}'
小黑盒公开主页为 https://www.xiaoheihe.cn/app/user/profile/<数字ID>，接口会返回昵称、等级、简介、关注/粉丝/获赞与收藏和近期帖子。账号名可以直接传；接口会先搜用户。若返回 account-ambiguous，把候选账号列给用户选；候选为空/需要验证码时，打开可见浏览器让用户完成验证或点选；搜不到再要主页链接或 ID，不要反复试错。返回 needsAuth 时请用户在 BotCamp 浏览器登录后交还，绝不要索要密码、Cookie、验证码。小红书把 platform 改为“小红书”，其余平台先用公开主页链接。
【干预规则】
只把用户无法从公开信息或账号数据里判断的内容拿来问：真实目标、资源、限制、决策偏好。平台规则、公开案例、竞品内容先自己查，查不到再问。
公开信息研究优先用 web_search / 浏览器工具；单次最多 2 轮搜索、约 90 秒内给结论。遇到登录、验证码、反爬或签名接口就停止，不要为了查账号去逆向接口或撞多个搜索引擎；查不到就明确说“公开信息查不到”，不要编造账号数据。
必须提醒的关键缺口：平台/账号不明确、目标受众不清、合规或授权风险、关键交付依赖缺失、会导致返工的事实错误。
可选建议按干预度处理：0–25 只提关键缺口；26–55 关键缺口必须提醒，最多附带一条高价值建议；56–80 可主动给结构优化和下一步建议；81–100 可挑战假设、给替代方案。无论数值多少，用户保留最终决定权。
不要教成熟用户基础操作；不要奉承、不要训斥；先给结论，再给依据。
不要在回复里提干预度、档位、默认值或“我可以调整主动程度”。默认按 40 执行；只有用户主动要求多给建议或少给建议时，才在后台调整并静默保存。`
}

/** Cap for /md-reader/read (larger files are truncated with a flag). */
const MAX_READ_BYTES = 4 * 1024 * 1024
/** Hard cap for /md-reader/raw; range streaming keeps memory flat for video. */
const MAX_RAW_BYTES = 4 * 1024 * 1024 * 1024

/** Markdown extensions the reader accepts. */
const MD_EXT = new Set(['.md', '.markdown', '.mdown', '.mdx'])
const MEDIA_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.mp4', '.m4v', '.webm', '.ogv', '.mov'])

/** Mime map for raw file serving (images, video, audio, and other assets). */
const RAW_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/opus',
  '.pdf': 'application/pdf',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.css': 'text/css; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
}

/** Mime map for vendored assets. */
const ASSET_MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
}

/** The vendored asset directory (package root/vendor). */
const ASSET_DIR = fileURLToPath(new URL('../vendor/', import.meta.url))

/** The standalone library page (same client, no DSH shell) served at /library/. */
const STANDALONE_DIR = fileURLToPath(new URL('../standalone/', import.meta.url))

// ---------------------------------------------------------------------------
// Route handlers.
// ---------------------------------------------------------------------------

/**
 * Resolve a client-supplied relative path against a gated canonical root and
 * verify containment on the REAL path (defeats `..` and symlink escapes).
 * @returns {ok:true, abs, real} or {ok:false, error, status}.
 */
async function resolveInside(gate, root, relPath) {
  const gated = await gate(root)
  if (!gated.ok) return { ok: false, error: gated.error, status: 400 }
  const joined = join(gated.canonical, relPath)
  if (!isPathInside(gated.canonical, joined)) {
    return { ok: false, error: { code: 'path-outside-root', message: 'path escapes the project root' }, status: 403 }
  }
  let real
  try {
    real = await realpath(joined)
  } catch {
    return { ok: false, error: { code: 'not-found', message: 'file does not exist' }, status: 404 }
  }
  if (!isPathInside(gated.canonical, real)) {
    return { ok: false, error: { code: 'path-outside-root', message: 'path resolves outside the project root' }, status: 403 }
  }
  return { ok: true, real }
}

/**
 * Parse one HTTP Range header against a known file size.
 * Only the single-range form (`bytes=a-b`) is supported; that is what
 * Chromium's <video> element sends for seeking.
 */
function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim())
  if (match === null) return null
  const hasStart = match[1] !== ''
  const hasEnd = match[2] !== ''
  if (!hasStart && !hasEnd) return null
  let start
  let end
  if (!hasStart) {
    const suffix = Number(match[2])
    if (!Number.isFinite(suffix) || suffix <= 0) return null
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(match[1])
    end = hasEnd ? Number(match[2]) : size - 1
    if (end >= size) end = size - 1
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  if (start < 0 || start >= size || end < start) return null
  return { start, end }
}

/**
 * GET/HEAD /md-reader/raw: stream one library file (images, video, audio).
 * Media responses advertise byte ranges so <video> can seek through the
 * reverse tunnel; images keep the simple buffered path.
 */
async function serveRaw(gate, req, url, res) {
  const path = url.searchParams.get('path')
  if (path === null || path === '') {
    json(res, FAIL('malformed-request', 'missing path'), 400)
    return
  }
  const resolved = await resolveInside(gate, '', path.replaceAll('\\', '/'))
  if (!resolved.ok) {
    json(res, FAIL(resolved.error.code, resolved.error.message), resolved.status)
    return
  }
  let info
  try {
    info = await stat(resolved.real)
  } catch {
    json(res, FAIL('not-found', 'file does not exist'), 404)
    return
  }
  if (!info.isFile()) {
    json(res, FAIL('is-directory', 'target is a directory'), 403)
    return
  }
  if (info.size > MAX_RAW_BYTES) {
    json(res, FAIL('too-large', 'file exceeds the raw serving limit'), 413)
    return
  }

  const mime = RAW_MIME[extname(resolved.real).toLowerCase()] ?? 'application/octet-stream'
  const rangeHeader = req.headers?.range
  const range = typeof rangeHeader === 'string' && rangeHeader !== '' ? parseRange(rangeHeader, info.size) : null
  if (typeof rangeHeader === 'string' && rangeHeader !== '' && range === null) {
    res.writeHead(416, { 'accept-ranges': 'bytes', 'content-range': `bytes */${info.size}` })
    res.end()
    return
  }

  const streamable = range !== null || mime.startsWith('video/') || mime.startsWith('audio/')
  const start = range !== null ? range.start : 0
  const end = range !== null ? range.end : Math.max(0, info.size - 1)
  const length = info.size === 0 ? 0 : end - start + 1
  const headers = {
    'content-type': mime,
    'content-length': length,
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
    'accept-ranges': 'bytes',
    'content-disposition': 'inline',
  }
  if (range !== null) headers['content-range'] = `bytes ${start}-${end}/${info.size}`
  if (mime === 'image/svg+xml') {
    headers['content-security-policy'] = "default-src 'none'; style-src 'unsafe-inline'; sandbox"
  }

  try {
    res.writeHead(range !== null ? 206 : 200, headers)
    if (req.method === 'HEAD' || info.size === 0) {
      res.end()
      return
    }
    if (!streamable) {
      res.end(await readFile(resolved.real))
      return
    }
    const stream = createReadStream(resolved.real, { start, end })
    stream.on('error', () => {
      try {
        res.destroy?.()
      } catch {
        /* connection already gone */
      }
    })
    stream.pipe(res)
  } catch {
    if (!res.headersSent) json(res, FAIL('not-found', 'file could not be read'), 404)
  }
}

/**
 * GET/HEAD /md-reader/assets/*: serve one vendored asset (KaTeX JS/CSS/fonts,
 * optional Mermaid drop-in) from the plugin package's vendor/ directory.
 * HEAD answers with the headers only so the client can probe for the optional
 * Mermaid drop-in without printing a 404 (or downloading it twice).
 */
async function serveAsset(url, res, headOnly) {
  await serveVendorAsset(url, res, headOnly, '/md-reader/assets/', '')
}

/**
 * Serve one file from a vendor subdirectory, for an arbitrary URL prefix.
 * Shared by /md-reader/assets/* and the aionui-panel compat routes.
 */
async function serveVendorAsset(url, res, headOnly, prefix, subdir) {
  const rel = url.pathname.slice(prefix.length)
  if (rel === '' || !/^[a-zA-Z0-9@._/+-]+$/.test(rel) || rel.includes('..')) {
    res.writeHead(404)
    res.end()
    return
  }
  const base = join(ASSET_DIR, subdir)
  const resolved = join(base, rel)
  if (!isPathInside(base, resolved)) {
    res.writeHead(404)
    res.end()
    return
  }
  try {
    const info = await stat(resolved)
    if (!info.isFile()) throw new Error('not a file')
    const headers = {
      'content-type': ASSET_MIME[extname(resolved).toLowerCase()] ?? 'application/octet-stream',
      'content-length': info.size,
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    }
    res.writeHead(200, headers)
    if (headOnly) {
      res.end()
      return
    }
    res.end(await readFile(resolved))
  } catch {
    res.writeHead(404)
    res.end()
  }
}

/**
 * GET/HEAD /aionui-panel/katex/* and /aionui-panel/hljs/* compat routes.
 * Registered under LONGER prefixes than the aionui-panel bundle's own
 * `/aionui-panel` prefix, so longest-prefix-wins routes these asset requests
 * here. Reason: after an in-place config hot-reload (skin switch) the panel's
 * in-memory host code can end up in a hybrid broken state (405 on its asset
 * subroutes); serving the same vendored assets from here keeps panel math
 * and highlighting alive without touching the panel package.
 */
async function serveCompatAsset(url, res, headOnly) {
  if (url.pathname.startsWith('/aionui-panel/katex/')) {
    await serveVendorAsset(url, res, headOnly, '/aionui-panel/katex/', 'katex')
    return
  }
  if (url.pathname.startsWith('/aionui-panel/hljs/')) {
    await serveVendorAsset(url, res, headOnly, '/aionui-panel/hljs/', 'hljs')
    return
  }
  res.writeHead(404)
  res.end()
}

/**
 * POST /md-reader/read: read one workspace markdown file (gated, capped).
 * Returns {content, mtime, size, truncated}.
 */
async function handleRead(gate, payload, res) {
  const root = strField(payload, 'root') ?? ''
  const path = strField(payload, 'path')
  if (path === null) {
    json(res, FAIL('malformed-request', 'missing path'), 400)
    return
  }
  const rel = path.replaceAll('\\', '/').replace(/^\/+/, '')
  const resolved = await resolveInside(gate, root, rel)
  if (!resolved.ok) {
    json(res, FAIL(resolved.error.code, resolved.error.message), resolved.status)
    return
  }
  const ext = extname(resolved.real).toLowerCase()
  if (!MD_EXT.has(ext)) {
    json(res, FAIL('unsupported-type', 'not a markdown file'), 415)
    return
  }
  let info
  try {
    info = await stat(resolved.real)
  } catch {
    json(res, FAIL('not-found', 'file does not exist'), 404)
    return
  }
  if (!info.isFile()) {
    json(res, FAIL('is-directory', 'target is a directory'), 403)
    return
  }
  const truncated = info.size > MAX_READ_BYTES
  try {
    // Open + partial read: a 200MB file only costs the capped buffer, not a
    // full readFile into memory.
    const fh = await open(resolved.real, 'r')
    try {
      const buffer = Buffer.alloc(Math.min(info.size, MAX_READ_BYTES))
      const { bytesRead } = await fh.read(buffer, 0, buffer.length, 0)
      json(res, {
        ok: true,
        value: {
          content: buffer.subarray(0, bytesRead).toString('utf8'),
          mtime: info.mtimeMs,
          size: info.size,
          truncated,
        },
      })
    } finally {
      await fh.close().catch(() => {})
    }
  } catch {
    json(res, FAIL('not-found', 'file could not be read'), 404)
  }
}

/**
 * POST /md-reader/stat: return lightweight file metadata for change polling.
 * It intentionally shares the same workspace/type gate as /read and never
 * returns file content.
 */
async function handleStat(gate, payload, res) {
  const root = strField(payload, 'root') ?? ''
  const path = strField(payload, 'path')
  if (path === null) {
    json(res, FAIL('malformed-request', 'missing path'), 400)
    return
  }
  const rel = path.replaceAll('\\', '/').replace(/^\/+/, '')
  const resolved = await resolveInside(gate, root, rel)
  if (!resolved.ok) {
    json(res, FAIL(resolved.error.code, resolved.error.message), resolved.status)
    return
  }
  if (!MD_EXT.has(extname(resolved.real).toLowerCase())) {
    json(res, FAIL('unsupported-type', 'not a markdown file'), 415)
    return
  }
  try {
    const info = await stat(resolved.real)
    if (!info.isFile()) {
      json(res, FAIL('is-directory', 'target is a directory'), 403)
      return
    }
    json(res, { ok: true, value: { mtime: info.mtimeMs, size: info.size } })
  } catch {
    json(res, FAIL('not-found', 'file does not exist'), 404)
  }
}

// ---------------------------------------------------------------------------
// Write layer (create / edit / rename / trash). The reader used to be read-only;
// the workspace page needs a small, root-gated file API. Every write is atomic
// (temp file + rename), never accepts a path outside docs/, and keeps deletions
// recoverable in the hidden .trash/ folder.
// ---------------------------------------------------------------------------

/** Maximum Markdown file size accepted by /md-reader/write. */
const MAX_WRITE_BYTES = 4 * 1024 * 1024

/** Normalize a client path and reject empty / dot / traversal segments. */
function normalizeRelPath(value) {
  if (typeof value !== 'string') return null
  const rel = value.replaceAll('\\', '/').replace(/^\/+/, '')
  if (rel === '' || rel.includes('\0')) return null
  const parts = rel.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null
  return rel
}

/** Whether a relative path is a Markdown document under docs/. */
function isDocumentPath(rel) {
  return rel.startsWith('docs/') && MD_EXT.has(extname(rel).toLowerCase())
}

/** Turn a title into a safe folder name (Unicode letters are preserved). */
function slugFromTitle(title) {
  const base = String(title ?? '')
    .trim()
    .replace(/[\\/:*?"<>|#%{}[\]]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64)
  return base || `doc-${Date.now()}`
}

/** Find a free docs/<slug> folder, appending -2, -3, ... on collision. */
async function uniqueDocSlug(docsDir, base) {
  for (let attempt = 1; attempt < 1000; attempt += 1) {
    const slug = attempt === 1 ? base : `${base}-${attempt}`
    try {
      await stat(join(docsDir, slug))
    } catch {
      return slug
    }
  }
  return `${base}-${Date.now()}`
}

/** GET /md-reader/tree: docs and media for the workspace sidebar. */
async function handleTree(gate, root, res) {
  await mkdir(join(root, 'docs'), { recursive: true }).catch(() => {})
  await mkdir(join(root, 'media'), { recursive: true }).catch(() => {})
  const gated = await gate('')
  if (!gated.ok) {
    json(res, FAIL(gated.error.code, gated.error.message), 500)
    return
  }
  const docs = await collectDocs(gated.canonical)
  const media = []
  const walkMedia = async (dir, depth) => {
    if (depth > 8 || media.length >= 500) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const absolute = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walkMedia(absolute, depth + 1)
        continue
      }
      if (!entry.isFile() || media.length >= 500) continue
      const ext = extname(entry.name).toLowerCase()
      if (!MEDIA_EXT.has(ext)) continue
      let info
      try { info = await stat(absolute) } catch { continue }
      media.push({
        path: relative(gated.canonical, absolute).replaceAll('\\', '/'),
        name: entry.name,
        type: ['.mp4', '.m4v', '.webm', '.ogv', '.mov'].includes(ext) ? 'video' : 'image',
        size: info.size,
        mtime: info.mtimeMs,
      })
    }
  }
  await walkMedia(gated.canonical, 0)
  const folderData = await collectFolders(gated.canonical)
  json(res, { ok: true, value: { root: gated.canonical, docs, media, folders: folderData.folders, folderInfo: folderData.folderInfo } })
}

/** POST /md-reader/create: create docs/<slug>/index.md plus assets/. */
async function handleCreate(gate, root, payload, res) {
  const title = (strField(payload, 'title') ?? '').trim() || '未命名文档'
  if (title.length > 120) {
    json(res, FAIL('invalid-title', 'title is too long'), 400)
    return
  }
  const gated = await gate('')
  if (!gated.ok) {
    json(res, FAIL(gated.error.code, gated.error.message), 500)
    return
  }
  const docsDir = join(gated.canonical, 'docs')
  await mkdir(docsDir, { recursive: true })
  const parentRel = normalizeRelPath(strField(payload, 'parent') ?? 'docs')
  if (parentRel === null || (parentRel !== 'docs' && !parentRel.startsWith('docs/'))) {
    json(res, FAIL('invalid-parent', 'parent must be a folder under docs/'), 400)
    return
  }
  const parentDir = join(gated.canonical, parentRel)
  let parentReal
  try {
    parentReal = await realpath(parentDir)
    if (!isPathInside(docsDir, parentReal) || !(await stat(parentReal)).isDirectory()) throw new Error('bad parent')
    if (await stat(join(parentReal, 'index.md')).then(() => true).catch(() => false)) throw new Error('parent is a document')
  } catch {
    json(res, FAIL('invalid-parent', 'parent folder does not exist'), 400)
    return
  }
  const requestedSlug = strField(payload, 'slug')
  const base = slugFromTitle(requestedSlug || title)
  const slug = await uniqueDocSlug(parentReal, base)
  const dir = join(parentReal, slug)
  await mkdir(join(dir, 'assets'), { recursive: true })
  const heading = title.replace(/\r?\n/g, ' ')
  const content = `# ${heading}\n\n`
  try {
    await writeFile(join(dir, 'index.md'), content, { flag: 'wx', mode: 0o600 })
  } catch {
    json(res, FAIL('create-failed', 'document already exists or could not be created'), 409)
    return
  }
  const parentPrefix = relative(gated.canonical, parentReal).replaceAll('\\', '/')
  const docPath = `${parentPrefix}/${slug}/index.md`
  const link = `botcamp://doc?path=${encodeURIComponent(docPath)}`
  json(res, { ok: true, value: { path: docPath, link, slug, title: heading, parent: parentPrefix } })
}

/** POST /md-reader/write: atomically replace one Markdown document. */
async function handleWrite(gate, root, payload, res) {
  const rel = normalizeRelPath(strField(payload, 'path'))
  const content = typeof payload?.content === 'string' ? payload.content : null
  if (rel === null || !isDocumentPath(rel)) {
    json(res, FAIL('invalid-path', 'path must be a Markdown file under docs/'), 400)
    return
  }
  if (content === null || Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES) {
    json(res, FAIL('invalid-content', 'content is missing or too large'), 413)
    return
  }
  const resolved = await resolveInside(gate, root, rel)
  if (!resolved.ok) {
    json(res, FAIL(resolved.error.code, resolved.error.message), resolved.status)
    return
  }
  const dir = dirname(resolved.real)
  const tmp = join(dir, `.${basename(resolved.real)}.${process.pid}.${Date.now()}.tmp`)
  try {
    await writeFile(tmp, content, { mode: 0o600 })
    await rename(tmp, resolved.real)
    const info = await stat(resolved.real)
    json(res, { ok: true, value: { path: rel, mtime: info.mtimeMs, size: info.size } })
  } catch {
    await unlink(tmp).catch(() => {})
    json(res, FAIL('write-failed', 'document could not be written'), 500)
  }
}

/** POST /md-reader/rename: rename a document folder and update its title. */
async function handleRename(gate, root, payload, res) {
  const rel = normalizeRelPath(strField(payload, 'path'))
  const title = (strField(payload, 'title') ?? '').trim()
  if (rel === null || !isDocumentPath(rel) || title === '' || title.length > 120) {
    json(res, FAIL('invalid-request', 'path and title are required'), 400)
    return
  }
  const resolved = await resolveInside(gate, root, rel)
  if (!resolved.ok) {
    json(res, FAIL(resolved.error.code, resolved.error.message), resolved.status)
    return
  }
  const gated = await gate('')
  if (!gated.ok) {
    json(res, FAIL(gated.error.code, gated.error.message), 500)
    return
  }
  const docsDir = join(gated.canonical, 'docs')
  const docDir = dirname(resolved.real)
  if (!isPathInside(docsDir, docDir) || docDir === docsDir) {
    json(res, FAIL('invalid-path', 'only a document folder can be renamed'), 400)
    return
  }
  const parentDir = dirname(docDir)
  const slug = slugFromTitle(title)
  const target = join(parentDir, slug)
  if (target === docDir) {
    json(res, { ok: true, value: { path: rel } })
    return
  }
  try {
    await stat(target)
    json(res, FAIL('already-exists', 'a document with that name already exists'), 409)
    return
  } catch { /* free */ }
  try {
    await rename(docDir, target)
    const file = join(target, basename(resolved.real))
    const text = await readFile(file, 'utf8').catch(() => '')
    if (text !== '') {
      let next = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
      const lines = next.split('\n')
      const headingIndex = lines.findIndex((line) => /^#\s+/.test(line))
      if (headingIndex !== -1) lines[headingIndex] = `# ${title}`
      else lines.unshift(`# ${title}`, '')
      next = lines.join('\n')
      await writeFile(file, next, { mode: 0o600 })
    }
    json(res, { ok: true, value: { path: relative(gated.canonical, join(target, basename(resolved.real))).replaceAll('\\', '/') } })
  } catch {
    json(res, FAIL('rename-failed', 'document could not be renamed'), 500)
  }
}

/** POST /md-reader/rename-folder: rename one folder inside docs/. */
async function handleRenameFolder(gate, root, payload, res) {
  const rel = normalizeRelPath(strField(payload, 'path'))
  const raw = typeof payload.name === 'string' ? payload.name.trim() : ''
  const name = raw.replace(/[\\/:*?"<>|]/g, '').trim()
  if (rel === null || !rel.startsWith('docs/') || name === '' || name === '.' || name === '..' || name.startsWith('.') || name.length > 80) {
    json(res, FAIL('invalid-request', 'path and name are required'), 400)
    return
  }
  const resolved = await resolveInside(gate, root, rel)
  if (!resolved.ok) {
    json(res, FAIL(resolved.error.code, resolved.error.message), resolved.status)
    return
  }
  const gated = await gate('')
  if (!gated.ok) {
    json(res, FAIL(gated.error.code, gated.error.message), 500)
    return
  }
  const docsDir = join(gated.canonical, 'docs')
  const info = await stat(resolved.real).catch(() => null)
  if (info === null || !info.isDirectory() || !isPathInside(docsDir, resolved.real) || resolved.real === docsDir) {
    json(res, FAIL('invalid-path', 'only a folder can be renamed'), 400)
    return
  }
  if (await stat(join(resolved.real, 'index.md')).then(() => true).catch(() => false)) {
    json(res, FAIL('is-document', 'use the document rename API for documents'), 400)
    return
  }
  const target = join(dirname(resolved.real), name)
  if (!isPathInside(docsDir, target) || target === resolved.real) {
    json(res, { ok: true, value: { path: rel } })
    return
  }
  try {
    await stat(target)
    json(res, FAIL('already-exists', '同名文件夹已存在'), 409)
    return
  } catch { /* free */ }
  try {
    await rename(resolved.real, target)
    json(res, { ok: true, value: { path: relative(gated.canonical, target).replaceAll('\\', '/') } })
  } catch {
    json(res, FAIL('rename-failed', '文件夹重命名失败'), 500)
  }
}

/** POST /md-reader/delete-folder: move a folder into .trash/. */
async function handleDeleteFolder(gate, root, payload, res) {
  const rel = normalizeRelPath(strField(payload, 'path'))
  if (rel === null || !rel.startsWith('docs/')) {
    json(res, FAIL('invalid-path', 'path must be a folder under docs/'), 400)
    return
  }
  const resolved = await resolveInside(gate, root, rel)
  if (!resolved.ok) {
    json(res, FAIL(resolved.error.code, resolved.error.message), resolved.status)
    return
  }
  const gated = await gate('')
  if (!gated.ok) {
    json(res, FAIL(gated.error.code, gated.error.message), 500)
    return
  }
  const docsDir = join(gated.canonical, 'docs')
  const info = await stat(resolved.real).catch(() => null)
  if (info === null || !info.isDirectory() || !isPathInside(docsDir, resolved.real) || resolved.real === docsDir) {
    json(res, FAIL('invalid-path', 'only a folder can be deleted'), 400)
    return
  }
  if (await stat(join(resolved.real, 'index.md')).then(() => true).catch(() => false)) {
    json(res, FAIL('is-document', 'use the document delete API for documents'), 400)
    return
  }
  const trash = join(root, '.trash')
  await mkdir(trash, { recursive: true })
  const target = join(trash, `${Date.now()}-${basename(resolved.real)}`)
  try {
    await rename(resolved.real, target)
    json(res, { ok: true, value: { trash: target } })
  } catch {
    json(res, FAIL('delete-failed', '文件夹删除失败'), 500)
  }
}

/** Allowed image extensions for the workspace upload route. */
const UPLOAD_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.mp4', '.webm', '.ogg', '.mov'])

/** POST /md-reader/upload: save one base64 image into the document's assets/. */
async function handleUpload(gate, root, payload, res) {
  const rel = normalizeRelPath(strField(payload, 'path'))
  if (rel === null || !isDocumentPath(rel)) {
    json(res, FAIL('invalid-path', 'path must be a Markdown file under docs/'), 400)
    return
  }
  const name = basename(String(strField(payload, 'name') ?? 'image.png'))
  const ext = extname(name).toLowerCase()
  if (!UPLOAD_EXT.has(ext)) {
    json(res, FAIL('unsupported-type', 'only image or video files can be uploaded'), 415)
    return
  }
  const raw = typeof payload?.data === 'string' ? payload.data : ''
  const comma = raw.indexOf(',')
  const base64 = raw.startsWith('data:') && comma !== -1 ? raw.slice(comma + 1) : raw
  let buffer
  try { buffer = Buffer.from(base64, 'base64') } catch { buffer = null }
  if (buffer === null || buffer.length === 0) {
    json(res, FAIL('invalid-content', 'image data is missing'), 400)
    return
  }
  if (buffer.length > 20 * 1024 * 1024) {
    json(res, FAIL('too-large', 'media is larger than 20MB'), 413)
    return
  }
  const resolved = await resolveInside(gate, root, rel)
  if (!resolved.ok) {
    json(res, FAIL(resolved.error.code, resolved.error.message), resolved.status)
    return
  }
  const assets = join(dirname(resolved.real), 'assets')
  await mkdir(assets, { recursive: true })
  const stem = basename(name, ext).replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-|-$/g, '') || 'image'
  let file = `${stem}${ext}`
  for (let attempt = 1; attempt < 1000; attempt += 1) {
    try { await stat(join(assets, file)); file = `${stem}-${attempt}${ext}` } catch { break }
  }
  try {
    await writeFile(join(assets, file), buffer, { flag: 'wx' })
    json(res, { ok: true, value: { path: `assets/${file}`, size: buffer.length } })
  } catch {
    json(res, FAIL('upload-failed', 'image could not be saved'), 500)
  }
}

/** POST /md-reader/delete: move a document folder into library/.trash/. */
async function handleDelete(gate, root, payload, res) {
  const rel = normalizeRelPath(strField(payload, 'path'))
  if (rel === null || !isDocumentPath(rel)) {
    json(res, FAIL('invalid-path', 'path must be a Markdown file under docs/'), 400)
    return
  }
  const resolved = await resolveInside(gate, root, rel)
  if (!resolved.ok) {
    json(res, FAIL(resolved.error.code, resolved.error.message), resolved.status)
    return
  }
  const gated = await gate('')
  if (!gated.ok) {
    json(res, FAIL(gated.error.code, gated.error.message), 500)
    return
  }
  const docsDir = join(gated.canonical, 'docs')
  const docDir = dirname(resolved.real)
  if (!isPathInside(docsDir, docDir) || docDir === docsDir) {
    json(res, FAIL('invalid-path', 'only a document folder can be deleted'), 400)
    return
  }
  const trash = join(root, '.trash')
  await mkdir(trash, { recursive: true })
  const target = join(trash, `${Date.now()}-${basename(docDir)}`)
  try {
    await rename(docDir, target)
    json(res, { ok: true, value: { trash: target } })
  } catch {
    json(res, FAIL('delete-failed', 'document could not be moved to trash'), 500)
  }
}

// ---------------------------------------------------------------------------
// Library index (frontmatter + first H1 + cover discovery).
// ---------------------------------------------------------------------------

/** Parse the tiny YAML subset the library needs: string / inline array. */
function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (match === null) return { data: {}, body: text }
  const data = {}
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (kv === null) continue
    let value = kv[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value
        .slice(1, -1)
        .split(',')
        .map((item) => item.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean)
    }
    data[kv[1]] = value
  }
  return { data, body: text.slice(match[0].length) }
}

/** First readable paragraph, used as the card description when frontmatter has none. */
function firstParagraph(body) {
  for (const line of body.split(/\r?\n/)) {
    const text = line.trim()
    if (text === '') continue
    if (/^(?:#{1,6}\s|!\[|>|```|\||<)/.test(text)) continue
    return text.replace(/[*_~`]/g, '').slice(0, 160)
  }
  return ''
}

/** Resolve a cover path against the document folder, and keep it inside the library. */
async function resolveCover(root, docAbs, configured) {
  if (typeof configured === 'string' && /^https?:/i.test(configured)) return configured
  const candidates = []
  if (typeof configured === 'string' && configured !== '') candidates.push(join(dirname(docAbs), configured))
  for (const name of ['cover.jpg', 'cover.png', 'cover.webp', 'cover.avif']) candidates.push(join(dirname(docAbs), name))
  for (const candidate of candidates) {
    try {
      const real = await realpath(candidate)
      if (!isPathInside(root, real)) continue
      const info = await stat(real)
      if (info.isFile()) return relative(root, real).replaceAll('\\', '/')
    } catch {
      /* try the next candidate */
    }
  }
  return null
}

/** Walk `docs/` and return every non-hidden folder, including empty ones. */
async function collectFolders(root) {
  const docsDir = join(root, 'docs')
  const folders = []
  const folderInfo = {}
  const walk = async (dir, depth) => {
    if (depth > 6 || folders.length >= 300) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'assets' || !entry.isDirectory()) continue
      const absolute = join(dir, entry.name)
      const rel = relative(root, absolute).replaceAll('\\', '/')
      let info = null
      try { info = await stat(absolute) } catch { /* still list it */ }
      folders.push(rel)
      if (info !== null) folderInfo[rel] = { created: info.birthtimeMs || info.ctimeMs, mtime: info.mtimeMs }
      await walk(absolute, depth + 1)
    }
  }
  await walk(docsDir, 0)
  return { folders, folderInfo }
}

/** POST /md-reader/mkdir: create one folder under docs/. */
async function handleMkdir(gate, root, payload, res) {
  const raw = typeof payload.name === 'string' ? payload.name.trim() : ''
  const name = raw.replace(/[\\/:*?"<>|]/g, '').trim()
  if (name === '' || name === '.' || name === '..' || name.startsWith('.')) {
    json(res, FAIL('invalid-name', '文件夹名称无效'), 400)
    return
  }
  if (name.length > 80) {
    json(res, FAIL('invalid-name', '文件夹名称太长'), 400)
    return
  }
  const gated = await gate('')
  if (!gated.ok) {
    json(res, FAIL(gated.error.code, gated.error.message), 500)
    return
  }
  const docsDir = join(gated.canonical, 'docs')
  await mkdir(docsDir, { recursive: true })
  const parentRel = normalizeRelPath(strField(payload, 'parent') ?? 'docs')
  if (parentRel === null || (parentRel !== 'docs' && !parentRel.startsWith('docs/'))) {
    json(res, FAIL('invalid-parent', 'parent must be a folder under docs/'), 400)
    return
  }
  const parentDir = join(gated.canonical, parentRel)
  let parentReal
  try {
    parentReal = await realpath(parentDir)
    if (!isPathInside(docsDir, parentReal) || !(await stat(parentReal)).isDirectory()) throw new Error('bad parent')
    if (await stat(join(parentReal, 'index.md')).then(() => true).catch(() => false)) throw new Error('parent is a document')
  } catch {
    json(res, FAIL('invalid-parent', 'parent folder does not exist'), 400)
    return
  }
  const target = join(parentReal, name)
  if (!isPathInside(parentReal, target)) {
    json(res, FAIL('invalid-name', '文件夹名称无效'), 400)
    return
  }
  try {
    await stat(target)
    json(res, FAIL('exists', '同名文件夹已存在'), 409)
    return
  } catch { /* free */ }
  await mkdir(target)
  const parentPrefix = relative(gated.canonical, parentReal).replaceAll('\\', '/')
  json(res, { ok: true, value: { path: `${parentPrefix}/${name}` } })
}

/** Walk `docs/` and return the library cards, newest first. */
async function collectDocs(root) {
  const docsDir = join(root, 'docs')
  const items = []
  const walk = async (dir, depth) => {
    if (depth > 6 || items.length >= 500) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const absolute = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(absolute, depth + 1)
        continue
      }
      if (!entry.isFile() || !MD_EXT.has(extname(entry.name).toLowerCase())) continue
      if (items.length >= 500) return
      let info
      try {
        info = await stat(absolute)
      } catch {
        continue
      }
      const head = await readFile(absolute, 'utf8').catch(() => '')
      const { data, body } = parseFrontmatter(head.slice(0, 64 * 1024))
      const h1 = /^#\s+(.+)$/m.exec(body)
      const fallbackTitle = basename(entry.name, extname(entry.name))
      const title =
        (typeof data.title === 'string' && data.title.trim() !== '' ? data.title.trim() : '') ||
        (h1 !== null ? h1[1].replace(/[*_`~]/g, '').trim() : '') ||
        fallbackTitle
      const description =
        (typeof data.description === 'string' && data.description.trim() !== '' ? data.description.trim() : '') ||
        firstParagraph(body)
      const tags = Array.isArray(data.tags)
        ? data.tags
        : typeof data.tags === 'string' && data.tags !== ''
          ? [data.tags]
          : []
      items.push({
        path: relative(root, absolute).replaceAll('\\', '/'),
        title,
        description,
        icon: typeof data.icon === 'string' && data.icon !== '' ? data.icon : '📄',
        cover: await resolveCover(root, absolute, data.cover),
        tags,
        updated:
          typeof data.updated === 'string' && data.updated !== ''
            ? data.updated
            : info.mtime.toISOString().slice(0, 10),
        mtime: info.mtimeMs,
        created: info.birthtimeMs || info.ctimeMs,
        size: info.size,
      })
    }
  }
  await walk(docsDir, 0)
  return items.sort((a, b) => String(b.updated).localeCompare(String(a.updated)) || b.mtime - a.mtime)
}

/** GET /md-reader/config: the fixed root and the library identity. */
function handleConfig(root, res) {
  json(res, {
    ok: true,
    value: {
      root,
      title: 'BotCamp 文档库',
      readonly: false,
      version: 2,
    },
  })
}

/** GET /md-reader/list: cards for the library home. */
async function handleList(gate, root, res) {
  await mkdir(join(root, 'docs'), { recursive: true }).catch(() => {})
  await mkdir(join(root, 'media'), { recursive: true }).catch(() => {})
  const gated = await gate('')
  if (!gated.ok) {
    json(res, FAIL(gated.error.code, gated.error.message), 500)
    return
  }
  const items = await collectDocs(gated.canonical)
  json(res, { ok: true, value: { root: gated.canonical, items } })
}

/**
 * GET /library/*: the standalone library page used by mobile/WebViews.
 * It loads the same client bundle with React UMD and mocks the tiny DSH
 * session surface, so the reading experience is identical to the desktop
 * overlay without depending on the DSH shell.
 */
async function serveStandalone(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405)
    res.end()
    return
  }
  const url = new URL(req.url ?? '/', 'http://x')
  if (url.pathname === '/library') {
    res.writeHead(308, { location: '/library/' })
    res.end()
    return
  }
  let rel = url.pathname.replace(/^\/library\/?/, '')
  if (rel === 'reader' || rel.startsWith('reader/')) {
    // The old read-only reader is retired; every library entry goes to the workspace.
    res.writeHead(302, { location: '/library/' })
    res.end()
    return
  }
  if (rel === '' || rel === 'index.html') rel = 'workspace.html'
  const allowed = rel === 'workspace.js' || rel === 'workspace.html' || rel === 'index.html'
    || rel === 'react.js' || rel === 'react-dom.js' || rel === 'client.js'
    || rel.startsWith('vditor/')
  if (!allowed) {
    res.writeHead(404)
    res.end()
    return
  }
  const file = rel === 'client.js'
    ? fileURLToPath(new URL('../lib/client.cjs', import.meta.url))
    : join(STANDALONE_DIR, rel)
  if (!isPathInside(STANDALONE_DIR, file) && rel !== 'client.js') {
    res.writeHead(404)
    res.end()
    return
  }
  const ext = extname(file).toLowerCase()
  const mime = ext === '.html' ? 'text/html; charset=utf-8'
    : ext === '.js' ? 'text/javascript; charset=utf-8'
      : ext === '.css' ? 'text/css; charset=utf-8'
        : ASSET_MIME[ext] ?? 'application/octet-stream'
  try {
    const body = await readFile(file)
    res.writeHead(200, {
      'content-type': mime,
      'content-length': body.length,
      'cache-control': rel.startsWith('vditor/') ? 'public, max-age=86400' : 'no-store',
      'x-content-type-options': 'nosniff',
    })
    if (req.method === 'HEAD') res.end()
    else res.end(body)
  } catch {
    res.writeHead(404)
    res.end()
  }
}

/**
 * Register the /md-reader route prefix.
 * @returns the route disposer.
 */
function registerRoutes(ctx, gate, libraryRoot) {
  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (url.pathname.startsWith('/md-reader/assets/')) {
        await serveAsset(url, res, req.method === 'HEAD')
        return
      }
      if (req.method === 'GET' && url.pathname === '/md-reader/config') {
        handleConfig(libraryRoot, res)
        return
      }
      if (req.method === 'GET' && url.pathname === '/md-reader/list') {
        await handleList(gate, libraryRoot, res)
        return
      }
      if (req.method === 'GET' && url.pathname === '/md-reader/tree') {
        await handleTree(gate, libraryRoot, res)
        return
      }
      if (req.method === 'GET' && url.pathname === '/md-reader/onboarding') {
        await handleOnboardingGet(libraryRoot, res)
        return
      }
      if (url.pathname === '/md-reader/raw') {
        await serveRaw(gate, req, url, res)
        return
      }
      res.writeHead(405)
      res.end()
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405)
      res.end()
      return
    }
    // Require an explicit JSON content-type: cross-site simple requests (no
    // preflight) cannot set application/json, so this blocks form-based CSRF
    // from driving the read routes.
    const contentType = req.headers['content-type'] ?? ''
    if (!contentType.toLowerCase().startsWith('application/json')) {
      json(res, FAIL('malformed-request', 'expected application/json'), 415)
      return
    }
    const payload = await readJsonBody(req)
    if (payload === null) {
      json(res, FAIL('malformed-request', 'malformed request'), 400)
      return
    }
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    if (pathname === '/md-reader/read') {
      await handleRead(gate, payload, res)
      return
    }
    if (pathname === '/md-reader/stat') {
      await handleStat(gate, payload, res)
      return
    }
    if (pathname === '/md-reader/create') {
      await handleCreate(gate, libraryRoot, payload, res)
      return
    }
    if (pathname === '/md-reader/mkdir') {
      await handleMkdir(gate, libraryRoot, payload, res)
      return
    }
    if (pathname === '/md-reader/rename-folder') {
      await handleRenameFolder(gate, libraryRoot, payload, res)
      return
    }
    if (pathname === '/md-reader/delete-folder') {
      await handleDeleteFolder(gate, libraryRoot, payload, res)
      return
    }
    if (pathname === '/md-reader/onboarding') {
      await handleOnboardingSave(libraryRoot, payload, res)
      return
    }
    if (pathname === '/md-reader/research') {
      await handleResearch(payload, res)
      return
    }
    if (pathname === '/md-reader/write') {
      await handleWrite(gate, libraryRoot, payload, res)
      return
    }
    if (pathname === '/md-reader/rename') {
      await handleRename(gate, libraryRoot, payload, res)
      return
    }
    if (pathname === '/md-reader/delete') {
      await handleDelete(gate, libraryRoot, payload, res)
      return
    }
    if (pathname === '/md-reader/upload') {
      await handleUpload(gate, libraryRoot, payload, res)
      return
    }
    res.writeHead(404)
    res.end()
  }

  const standaloneHandler = async (req, res) => {
    await serveStandalone(req, res)
  }

  // aionui-panel asset compat routes (shadow the panel's broken subroutes
  // via longest-prefix-wins; see serveCompatAsset).
  const compatHandler = async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405)
      res.end()
      return
    }
    const url = new URL(req.url ?? '/', 'http://x')
    await serveCompatAsset(url, res, req.method === 'HEAD')
  }

  const disposers = [
    ctx.webServer.register({ kind: 'prefix', path: '/md-reader', handler }),
    ctx.webServer.register({ kind: 'prefix', path: '/library', handler: standaloneHandler }),
    ctx.webServer.register({ kind: 'prefix', path: '/aionui-panel/katex', handler: compatHandler }),
    ctx.webServer.register({ kind: 'prefix', path: '/aionui-panel/hljs', handler: compatHandler }),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}

/**
 * Mount the read routes and the agent announcement.
 * @param ctx - context carrying webServer and systemPrompt.
 */
export function apply(ctx) {
  const libraryRoot = resolveLibraryRoot()
  const gate = createLibraryGate(libraryRoot)
  ctx.effect(() => registerRoutes(ctx, gate, libraryRoot), 'botcamp-library: /md-reader routes')
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'plugin:botcamp-library',
    order: SECTION_ORDER,
    text: MARKDOWN_READER_GUIDANCE,
  }), 'botcamp-library: prompt section')
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'plugin:botcamp-onboarding',
    order: SECTION_ORDER + 1,
    text: () => onboardingPrompt(libraryRoot),
  }), 'botcamp-library: onboarding prompt section')
}
