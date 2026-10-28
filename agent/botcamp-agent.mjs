#!/usr/bin/env node
/**
 * BotCamp agent — one process that keeps this computer reachable.
 *
 *   botcamp-agent login        one-time: sign in, register this device
 *   botcamp-agent up           start/attach a host, heartbeat, keep a reverse tunnel
 *   botcamp-agent status       show the saved device
 *   botcamp-agent logout       forget the device credential
 *
 * Only Node built-ins. Works on macOS, Linux and Windows (Windows ships OpenSSH).
 */
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, hostname, platform } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'

const GATEWAY = process.env.BOTCAMP_GATEWAY || 'https://camp.aigc.sx.cn'
const CONFIG = process.env.BOTCAMP_AGENT_CONFIG || join(homedir(), '.botcamp', 'agent.json')
const SSH_KEY = process.env.BOTCAMP_SSH_KEY || ''
const SSH_HOST = process.env.BOTCAMP_SSH_HOST || 'root@server.aigc.sx.cn'
const HOST_PORT = Number(process.env.BOTCAMP_HOST_PORT || 8765)
const REMOTE_BASE = Number(process.env.BOTCAMP_REMOTE_PORT_BASE || 18765)

function readConfig() {
  try { return JSON.parse(readFileSync(CONFIG, 'utf8')) } catch { return {} }
}
function writeConfig(data) {
  mkdirSync(join(CONFIG, '..'), { recursive: true })
  writeFileSync(CONFIG, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
}
function deviceId() {
  const seed = `${hostname()}|${platform()}|${process.env.USER || process.env.USERNAME || ''}`
  return createHash('sha256').update(seed).digest('hex').slice(0, 16)
}
async function post(path, body, headers = {}) {
  const res = await fetch(GATEWAY + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  if (!res.ok) throw new Error(json.error || `${res.status} ${text.slice(0, 120)}`)
  return json
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function login() {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const email = (await rl.question('邮箱: ')).trim()
  const password = await rl.question('密码: ')
  rl.close()
  const { token } = await post('/botcamp/api/login', { email, password })
  const device = {
    device_id: deviceId(),
    name: hostname(),
    platform: `${platform()} ${process.arch}`,
  }
  const registered = await post('/botcamp/api/devices/register', device, { authorization: `Bearer ${token}` })
  writeConfig({ email, device, slot: registered.slot, secret: registered.device_secret })
  console.log(`已注册设备 ${registered.slot}（${device.name}）`)
}

function hostArgs() {
  return ['-y', '@deepseek-ai/dsh@0.2.1-rc.2', 'web',
    '--host', '127.0.0.1', '--port', String(HOST_PORT), '--no-open',
    '--public-url', `http://127.0.0.1:${HOST_PORT}`,
    '--trusted-host', `127.0.0.1:${HOST_PORT}`]
}

function startHost() {
  const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', hostArgs(), {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  })
  let token = ''
  const scan = (buf) => {
    const m = /token=([A-Za-z0-9_-]+)/.exec(buf.toString())
    if (m) token = m[1]
  }
  child.stdout.on('data', scan)
  child.stderr.on('data', scan)
  child.on('exit', () => { token = '' })
  return { child, token: () => token }
}

function sshArgs(slot) {
  const port = REMOTE_BASE + slot - 1
  const args = ['-N', '-o', 'StrictHostKeyChecking=no', '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
    '-R', `127.0.0.1:${port}:127.0.0.1:${HOST_PORT}`]
  if (SSH_KEY) args.push('-i', SSH_KEY)
  args.push(SSH_HOST)
  return args
}

async function up() {
  const cfg = readConfig()
  if (!cfg.secret) {
    console.error('还没有登录。先运行: botcamp-agent login')
    process.exit(1)
  }
  const attach = process.argv.includes('--attach')
  let host
  if (!attach) {
    host = startHost()
    console.log(`已启动本机 host（127.0.0.1:${HOST_PORT}）`)
  } else {
    console.log(`attach 模式：复用已在 ${HOST_PORT} 监听的 host`)
  }

  let token = ''
  for (let i = 0; i < 30; i += 1) {
    if (host?.token()) { token = host.token(); break }
    if (attach) break
    await sleep(2000)
  }

  for (;;) {
    try {
      const beat = await post('/botcamp/api/devices/heartbeat', { token }, { authorization: `Bearer ${cfg.secret}` })
      const slot = beat.slot || cfg.slot
      console.log(`[${new Date().toISOString()}] 心跳 ok，槽位 ${slot}`)
      const ssh = spawn('ssh', sshArgs(slot), { stdio: 'inherit' })
      await new Promise((resolve) => ssh.on('exit', resolve))
      console.log('隧道断开，5 秒后重连')
    } catch (error) {
      console.error('心跳失败：', error.message)
    }
    if (!host?.child || host.child.killed) host = startHost()
    await sleep(5000)
  }
}

function status() {
  const cfg = readConfig()
  if (!cfg.secret) return console.log('未登录')
  console.log(JSON.stringify({ email: cfg.email, device: cfg.device, slot: cfg.slot }, null, 2))
}

function logout() {
  writeConfig({})
  console.log('已清除本机设备凭证')
}

const command = process.argv[2]
const actions = { login, up, status, logout }
if (!actions[command]) {
  console.log('用法: botcamp-agent <login|up|status|logout>')
  process.exit(1)
}
actions[command]()
