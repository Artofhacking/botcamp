/**
 * First-run pairing for BotCamp.
 *
 * A fresh install has no device credential, so the gateway would list no devices
 * for this account. Before the main window opens we show the pairing code, wait
 * for the account owner to approve it on any signed-in browser, then keep the
 * relay agent running so the machine becomes reachable at /desk/d<slot>/.
 */
import { BrowserWindow } from 'electron'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'

const GATEWAY = (process.env.BOTCAMP_GATEWAY ?? 'https://camp.aigc.sx.cn').replace(/\/$/, '')
const CONFIG = join(homedir(), '.botcamp', 'agent.json')
const AGENT = join(process.resourcesPath ?? '', 'botcamp-agent.mjs')

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

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${GATEWAY}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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

async function waitForApproval(code: string): Promise<{ slot: string, secret: string }> {
  for (;;) {
    await sleep(2000)
    const result = await post<{ status: string, slot?: string, device_secret?: string }>('/botcamp/api/devices/pair/poll', { code })
    if (result.status === 'approved' && result.slot && result.device_secret) {
      return { slot: result.slot, secret: result.device_secret }
    }
    if (result.status === 'expired') throw new Error('pairing code expired')
  }
}

/** Start (or restart) the relay agent bundled with the app. */
function startRelay(): void {
  if (relay && relay.exitCode === null) return
  if (!existsSync(AGENT)) return
  relay = spawn(process.execPath, [AGENT, 'up'], {
    detached: false,
    stdio: 'ignore',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  relay.on('exit', () => { relay = undefined })
}

export async function botcampEnsureDevice(): Promise<void> {
  if (!existsSync(CONFIG)) {
    const device = { device_id: deviceId(), name: hostname(), platform: `${process.platform} ${process.arch}` }
    const started = await post<{ code: string, url: string }>('/botcamp/api/devices/pair/start', device).catch(() => undefined)
    if (!started) return
    const window = new BrowserWindow({
      width: 420, height: 300, resizable: false, center: true,
      title: 'BotCamp', backgroundColor: '#0b0b0d',
      webPreferences: { contextIsolation: true, sandbox: true },
    })
    void window.loadURL(PAGE(started.code, started.url))
    try {
      const approved = await waitForApproval(started.code)
      mkdirSync(join(homedir(), '.botcamp'), { recursive: true })
      writeFileSync(CONFIG, JSON.stringify({ device, slot: approved.slot, secret: approved.secret }, null, 2), { mode: 0o600 })
    } catch {
      // Timeout or offline: let the app open; the user can pair from the settings later.
    } finally {
      if (!window.isDestroyed()) window.close()
    }
  }
  startRelay()
}

export function stopBotcampRelay(): void {
  relay?.kill()
  relay = undefined
}
