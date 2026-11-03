/**
 * First-run pairing for BotCamp.
 *
 * A fresh install has no device credential, so the gateway would list no devices
 * for this account. Before the main window opens we show the pairing code, wait
 * for the account owner to approve it on any signed-in browser, then keep the
 * relay agent running so the machine becomes reachable at /desk/d<slot>/.
 */
import { app, BrowserWindow } from 'electron'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

const GATEWAY = (process.env.BOTCAMP_GATEWAY ?? 'https://camp.aigc.sx.cn').replace(/\/$/, '')
const botcampHome = (): string => process.env.BOTCAMP_HOME || join(homedir(), '.botcamp')
const configPath = (): string => join(botcampHome(), 'agent.json')
const AGENT = join(process.resourcesPath ?? '', 'botcamp-agent.mjs')

/** The model layer the profile needs to talk to the BotCamp gateway. */
const MODEL_PATCH = `- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      botcamp:
        api: openai-completions
        baseURL: https://camp.aigc.sx.cn/botcamp/v1
        apiKeyEnv: BOTCAMP_LLM_KEY
        models:
          - id: deepseek-v4.1-flash
            name: DeepSeek V4.1 Flash
            contextWindow: 1000000
            maxTokens: 384000
            input: [ text, image ]
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: botcamp
    model: deepseek-v4.1-flash
- id: locale
  name: "@deepseek-ai/dsh-client-locale"
  config:
    preference: zh
`

let relay: ChildProcess | undefined

function machineUuid(): string {
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8' })
      const found = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out)
      if (found) return found[1]!
    } else if (process.platform === 'win32') {
      const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { encoding: 'utf8' })
      const found = /MachineGuid\s+REG_SZ\s+(\S+)/.exec(out)
      if (found) return found[1]!
    }
  } catch { /* fall through */ }
  return `${hostname()}|${process.env.USER ?? process.env.USERNAME ?? ''}`
}

function deviceId(): string {
  return createHash('sha256').update(machineUuid()).digest('hex').slice(0, 16)
}

async function post<T>(path: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
  const response = await fetch(`${GATEWAY}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  return await response.json() as T
}

function sleep(ms: number): Promise<void> { return new Promise((resolve) => { setTimeout(resolve, ms) }) }

const PAGE = (code: string, url: string) => `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html><head><meta charset="utf-8"><title>BotCamp</title>
<style>body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
background:#0b0b0d;color:#e8e8ee;font:14px/1.6 system-ui,-apple-system,"PingFang SC",sans-serif}
.box{text-align:center;padding:28px 24px}b{font-size:30px;letter-spacing:4px;color:#6c8cff;display:block;margin:16px 0}
p{color:#8b8b98;margin:4px 0;font-size:13px}a{color:#6c8cff;word-break:break-all;font-size:12px}</style></head>
<body><div class="box"><h2 style="font-size:16px;margin:0">绑定这台电脑</h2>
<p>用手机或浏览器打开下面的地址并登录确认</p><b>${code}</b><a>${url}</a>
<p id="s" style="margin-top:18px">等待确认…</p></div></body></html>`)}`

async function waitForApproval(code: string): Promise<{ slot: string, secret: string, llmToken?: string }> {
  for (;;) {
    await sleep(2000)
    const result = await post<{ status: string, slot?: string, device_secret?: string, llm_token?: string }>('/botcamp/api/devices/pair/poll', { code })
    if (result.status === 'approved' && result.slot && result.device_secret) {
      return { slot: result.slot, secret: result.device_secret, ...result.llm_token ? { llmToken: result.llm_token } : {} }
    }
    if (result.status === 'expired') throw new Error('pairing code expired')
  }
}

/**
 * Point every existing profile at the BotCamp gateway and export the paired
 * inference key. Without this the host starts with no model at all: the profile
 * patch is empty on a fresh install, and BOTCAMP_LLM_KEY is only known to
 * agent.json. Marking onboarding complete also stops the first-run flow from
 * resetting the patch on the next launch.
 */
function profileRoots(): string[] {
  const roots = [join(botcampHome(), 'profiles')]
  const accounts = join(botcampHome(), 'accounts')
  try {
    for (const account of readdirSync(accounts)) roots.push(join(accounts, account, 'profiles'))
  } catch { /* no accounts yet */ }
  return roots
}

function configureProfiles(): void {
  try {
    const config = JSON.parse(readFileSync(configPath(), 'utf8')) as { llm_token?: unknown }
    if (typeof config.llm_token === 'string' && config.llm_token) process.env.BOTCAMP_LLM_KEY = config.llm_token
    if (!process.env.BOTCAMP_LLM_KEY) return
    for (const root of profileRoots()) {
      let names: string[]
      try { names = readdirSync(root) } catch { continue }
      for (const name of names) {
        const directory = join(root, name)
        const patchPath = join(directory, 'cordis.patch.yml')
        if (existsSync(patchPath)) {
          const text = readFileSync(patchPath, 'utf8')
          let valid = true
          try { parseYaml(text) } catch { valid = false }
          if (!valid) {
            // A half-written or duplicated patch put the app into recovery mode.
            // Keep a copy, then replace it with the known-good model patch.
            try { writeFileSync(patchPath + '.broken', text) } catch { /* ignore */ }
            writeFileSync(patchPath, MODEL_PATCH)
          } else if (!text.includes('dsh-llm-pi-ai')) {
            const head = text.trim()
            const next = head === '' || head === '[]' ? MODEL_PATCH : `${text.trimEnd()}\n${MODEL_PATCH}`
            try {
              parseYaml(next)
              writeFileSync(patchPath, next)
            } catch {
              try { writeFileSync(patchPath + '.broken', text) } catch { /* ignore */ }
              writeFileSync(patchPath, MODEL_PATCH)
            }
          }
        }
        const manifestPath = join(directory, 'package.json')
        if (existsSync(manifestPath)) {
          const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dsh?: Record<string, unknown> }
          manifest.dsh = manifest.dsh ?? {}
          manifest.dsh.desktopNextOnboarding = { version: 1, outcome: 'completed' }
          writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
        }
      }
    }
  } catch { /* not paired yet, or a profile is unreadable: the app still opens */ }
}

/** A fresh account must land in the team, not in the account-interview flow. */
function seedOnboarding(): void {
  const accounts = join(botcampHome(), 'accounts')
  let names: string[]
  try { names = readdirSync(accounts) } catch { return }
  for (const account of names) {
    const bot = join(accounts, account, 'bot')
    const file = join(bot, 'onboarding.json')
    if (existsSync(file)) continue
    try {
      mkdirSync(bot, { recursive: true })
      writeFileSync(file, JSON.stringify({
        version: 1,
        complete: true,
        platform: '',
        account: '',
        accountId: '',
        audience: '',
        goal: '',
        resources: '',
        intervention: 40,
        completedAt: Date.now(),
      }, null, 2) + '\n', { mode: 0o600 })
    } catch { /* the next retry can seed it */ }
  }
}

let provisionTimer: NodeJS.Timeout | undefined
function startProvisioning(): void {
  if (provisionTimer !== undefined) return
  const provision = () => { configureProfiles(); seedOnboarding() }
  provision()
  provisionTimer = setInterval(provision, 1500)
  provisionTimer.unref?.()
  const stop = setTimeout(() => {
    if (provisionTimer !== undefined) clearInterval(provisionTimer)
    provisionTimer = undefined
  }, 60_000)
  stop.unref?.()
}

/**
 * Start (or restart) the relay agent bundled with the app. The desktop shell
 * owns the Host on this machine, so the agent attaches to it instead of
 * starting a second one on the same port.
 */
function startRelay(): void {
  if (relay && relay.exitCode === null) return
  if (!existsSync(AGENT)) return
  relay = spawn(process.execPath, [AGENT, 'up', '--attach'], {
    detached: false,
    stdio: 'ignore',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  relay.on('exit', () => { relay = undefined })
}

const LOGIN_PAGE = () => `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html><head><meta charset="utf-8"><title>BotCamp</title>
<style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f7f9;color:#14161a;font:14px/1.5 system-ui,-apple-system,"PingFang SC",sans-serif;padding:24px}
.card{width:min(92vw,360px);background:#fff;border:1px solid #e6e8ee;border-radius:16px;padding:24px;box-shadow:0 12px 32px rgba(16,24,40,.06)}
.brand{display:flex;align-items:center;gap:9px;font-weight:700;margin-bottom:18px}.mark{width:26px;height:26px;border-radius:8px;background:linear-gradient(140deg,#35b36b,#167a4d)}
label{display:block;color:#667085;font-size:12px;margin:12px 0 5px}input{width:100%;height:38px;border:1px solid #e6e8ee;border-radius:9px;padding:0 10px;font:inherit;outline:none}input:focus{border-color:#9ed3b7}
button{width:100%;height:40px;margin-top:18px;border:0;border-radius:10px;background:#167a4d;color:#fff;font:inherit;font-weight:600;cursor:pointer}button:disabled{opacity:.5}
.err{color:#b42318;font-size:12px;min-height:16px;margin-top:10px}
</style></head><body><div class="card"><div class="brand"><span class="mark"></span>BotCamp</div>
<label>邮箱</label><input id="email" type="email" autocomplete="username" placeholder="you@example.com">
<label>密码</label><input id="password" type="password" autocomplete="current-password" placeholder="••••••••">
<button id="go">登录</button><div class="err" id="err"></div></div>
<script>
const API=${JSON.stringify(GATEWAY)};
document.getElementById('go').onclick=async()=>{
 const b=document.getElementById('go'),e=document.getElementById('err');
 b.disabled=true;e.textContent='';
 try{
  const r=await fetch(API+'/botcamp/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:document.getElementById('email').value.trim(),password:document.getElementById('password').value})});
  const d=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(d.error||'登录失败');
  location.href='botcamp://login?token='+encodeURIComponent(d.token||'')+'&llm='+encodeURIComponent(d.llm_token||'')+'&email='+encodeURIComponent(document.getElementById('email').value.trim());
 }catch(err){e.textContent=err.message;b.disabled=false}
};
document.getElementById('password').addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('go').click()});
</script></body></html>`)}`

async function loginWindow(): Promise<{ token: string, llm: string, email: string } | null> {
  const window = new BrowserWindow({
    width: 400, height: 480, resizable: false, center: true,
    title: 'BotCamp', backgroundColor: '#f6f7f9',
    webPreferences: { contextIsolation: true, sandbox: true },
  })
  return await new Promise((resolve) => {
    let settled = false
    const finish = (value: { token: string, llm: string, email: string } | null): void => {
      if (settled) return
      settled = true
      resolve(value)
      if (!window.isDestroyed()) window.close()
    }
    window.webContents.on('will-navigate', (event, url) => {
      if (!url.startsWith('botcamp://login?')) return
      event.preventDefault()
      const parsed = new URL(url)
      finish({
        token: parsed.searchParams.get('token') ?? '',
        llm: parsed.searchParams.get('llm') ?? '',
        email: parsed.searchParams.get('email') ?? '',
      })
    })
    window.once('closed', () => finish(null))
    window.loadURL(LOGIN_PAGE()).catch(() => finish(null))
  })
}

function ensureDefaultModels(): void {
  const modelRef = 'botcamp/deepseek-v4.1-flash'
  try {
    const accounts = join(botcampHome(), 'accounts')
    for (const account of readdirSync(accounts)) {
      const statePath = join(accounts, account, 'bot', 'state.json')
      if (!existsSync(statePath)) continue
      const state = JSON.parse(readFileSync(statePath, 'utf8')) as { bots?: Record<string, { model?: string, appliedModel?: string }> }
      let changed = false
      for (const bot of Object.values(state.bots ?? {})) {
        if (typeof bot.model !== 'string' || bot.model === '') { bot.model = modelRef; changed = true }
        if (typeof bot.appliedModel !== 'string' || bot.appliedModel === '') { bot.appliedModel = bot.model; changed = true }
      }
      if (changed) writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n')
    }
  } catch { /* no account state yet */ }
}

function botcampHasAccountHistory(): boolean {
  try {
    const accounts = join(botcampHome(), 'accounts')
    for (const name of readdirSync(accounts)) {
      if (existsSync(join(accounts, name, 'bot', 'state.json'))) return true
    }
  } catch { /* no accounts yet */ }
  return false
}

async function botcampMaybeWelcome(): Promise<void> {
  const marker = join(botcampHome(), 'template.json')
  if (existsSync(marker)) return
  if (botcampHasAccountHistory()) return
  const page = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>BotCamp</title>
<style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#f6f7f9;color:#14161a;font:14px/1.6 system-ui,-apple-system,"PingFang SC",sans-serif;display:grid;place-items:center;padding:32px}
.box{width:min(92vw,760px);text-align:center}.brand{display:flex;align-items:center;justify-content:center;gap:10px;font-weight:700;font-size:15px;margin-bottom:20px}
.mark{width:26px;height:26px;border-radius:8px;background:linear-gradient(140deg,#6cd58f,#167a4d);box-shadow:0 1px 3px rgba(22,122,77,.25)}
h1{font-size:26px;margin:0 0 8px;letter-spacing:-.3px}p.sub{color:#667085;margin:0 0 28px}
.cards{display:grid;grid-template-columns:1fr 1fr;gap:14px}.card{text-align:left;background:#fff;border:1px solid #e6e8ee;border-radius:16px;padding:22px;cursor:pointer;color:inherit;font:inherit;transition:.15s;box-shadow:0 1px 2px rgba(16,24,40,.03)}
.card:hover{border-color:#9ed3b7;background:#fbfffc}.card h2{font-size:16px;margin:0 0 8px}.card p{color:#667085;font-size:13px;margin:0 0 16px;min-height:40px}
.badge{display:inline-block;font-size:11px;color:#167a4d;background:#e8f5ee;border-radius:999px;padding:3px 8px;margin-bottom:12px}
.primary{color:#fff;background:#167a4d;border-color:#167a4d}.primary:hover{background:#11663f}.primary p{color:#d9f0e3}.primary .badge{color:#e8fff0;background:rgba(255,255,255,.16)}
.primary b{font-weight:600}.card b{color:#167a4d}.primary b{color:#fff}
.foot{color:#98a2b3;font-size:12px;margin-top:18px}
</style></head><body><div class="box"><div class="brand"><span class="mark"></span>BotCamp</div><h1>选择你的团队模板</h1><p class="sub">这会决定首次进入 BotCamp 时的团队结构，之后仍可调整。</p>
<div class="cards">
<button class="card primary" onclick="location.href='botcamp://template?choice=media'"><span class="badge">推荐</span><h2>自媒体运营</h2><p>主编 + 选题、文案、视频、视觉、数据，自带内容团队和群聊。</p><b>开始使用 →</b></button>
<button class="card" onclick="location.href='botcamp://template?choice=none'"><span class="badge">轻量</span><h2>空白团队</h2><p>只有一个 Chief，不创建其他 Bot、群聊和团队文档；文档库保留。</p><b>开始使用 →</b></button>
</div><p class="foot">首次登录仅显示一次</p></div></body></html>`)}`
  const window = new BrowserWindow({
    width: 780, height: 540, resizable: false, center: true,
    title: 'BotCamp', backgroundColor: '#f6f7f9',
    webPreferences: { contextIsolation: true, sandbox: true },
  })
  const choice = await new Promise<'media' | 'none'>((resolve) => {
    let settled = false
    const finish = (value: 'media' | 'none'): void => {
      if (settled) return
      settled = true
      resolve(value)
      if (!window.isDestroyed()) window.close()
    }
    window.webContents.on('will-navigate', (event, url) => {
      if (!url.startsWith('botcamp://template')) return
      event.preventDefault()
      finish(new URL(url).searchParams.get('choice') === 'none' ? 'none' : 'media')
    })
    window.once('closed', () => finish('media'))
    window.loadURL(page).catch(() => finish('media'))
  })
  mkdirSync(botcampHome(), { recursive: true })
  writeFileSync(marker, JSON.stringify({ id: choice, at: Date.now() }, null, 2) + '\n', { mode: 0o600 })
}

export async function botcampEnsureDevice(): Promise<void> {
  configureProfiles()
  const session = await loginWindow()
  if (!session || !session.token) { app.exit(0); return }
  const device = { device_id: deviceId(), name: hostname(), platform: `${process.platform} ${process.arch}` }
  try {
    const registered = await post<{ slot: string, device_secret: string }>(
      '/botcamp/api/devices/register', device, { authorization: `Bearer ${session.token}` },
    )
    mkdirSync(botcampHome(), { recursive: true })
    writeFileSync(configPath(), JSON.stringify({
      email: session.email,
      device,
      slot: registered.slot,
      secret: registered.device_secret,
      ...session.llm ? { llm_token: session.llm } : {},
    }, null, 2), { mode: 0o600 })
  } catch {
    app.exit(0)
    return
  }
  await botcampMaybeWelcome()
  configureProfiles()
  seedOnboarding()
  ensureDefaultModels()
  startProvisioning()
  startRelay()
}

export function stopBotcampRelay(): void {
  relay?.kill()
  relay = undefined
}
