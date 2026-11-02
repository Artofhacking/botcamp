#!/usr/bin/env node
/**
 * The payload collector resolves each dependency from the workspace that owns it,
 * so a package that lives in one workspace cannot see peers installed for another.
 * Fill the gaps with directory links instead of reinstalling: no package.json edits,
 * no second install, identical result on macOS and Windows.
 *
 * Usage: node desktop/fix-payload.mjs <path-to-dsh-desktop>
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { rebrandTree } from './rebrand.mjs'

// Absolute, so every symlink target below resolves from the link's own directory.
const root = resolve(process.argv[2] ?? '')
if (process.argv[2] === undefined) { console.error('usage: node desktop/fix-payload.mjs <path-to-dsh-desktop>'); process.exit(1) }

const appAi = join(root, 'dsh-desktop-next', 'node_modules', '@deepseek-ai')
if (!existsSync(appAi)) { console.error('application node_modules missing:', appAi); process.exit(1) }

const rootAi = join(root, 'node_modules', '@deepseek-ai')
const marketAi = join(root, 'dsh-community-market', 'node_modules', '@deepseek-ai')

function fill(target, source) {
  if (!existsSync(source)) return 0
  mkdirSync(target, { recursive: true })
  let linked = 0
  for (const name of readdirSync(source)) {
    const dest = join(target, name)
    if (existsSync(dest)) continue
    // A link left over from an earlier run can be dangling: existsSync is false but
    // creating it again fails with EEXIST, so clear it first.
    try { lstatSync(dest); rmSync(dest, { recursive: true, force: true }) } catch { /* nothing there */ }
    try {
      symlinkSync(join(source, name), dest, process.platform === 'win32' ? 'junction' : 'dir')
      linked += 1
    } catch (error) {
      console.warn(`could not link ${name} into ${target}:`, error.message)
    }
  }
  return linked
}

// yarn hoists most packages to the workspace root, but the payload collector looks
// inside the workspace that owns each dependency, so fill in both directions.
let filled = 0
filled += fill(appAi, rootAi)
filled += fill(rootAi, appAi)
filled += fill(marketAi, appAi)
filled += fill(rootAi, marketAi)
console.log(`linked ${filled} package(s) so every workspace sees the same tree`)

// Every surface a person reads says BotCamp. Runs after the links exist, so the
// shell sources and every hoisted client plugin are patched exactly once.
// All Bots share one BotCamp browser profile. Tabs and history stay per Bot, but
// cookies/logins are deliberately team-wide: log in once, let the team use it.
for (const client of [
  join(root, 'node_modules', 'ds-bot', 'client.js'),
  join(root, 'dsh-desktop-next', 'node_modules', 'ds-bot', 'client.js'),
]) {
  if (!existsSync(client)) continue
  let text = readFileSync(client, 'utf8')
  if (text.includes("await bridge.acquire(`bot:${botId}`)")) {
    text = text.replace("await bridge.acquire(`bot:${botId}`)", "await bridge.acquire('botcamp:team')")
    writeFileSync(client, text)
    console.log('shared bot browser profile:', client)
  }
}

// The directly opened right-sidebar browser and every Bot browser share the same
// storage profile, so a login in one is immediately available in the other.
for (const client of [
  join(root, 'node_modules', '@deepseek-ai', 'dsh-client-ui-sidebar-browser', 'lib', 'client.js'),
  join(root, 'dsh-desktop-next', 'node_modules', '@deepseek-ai', 'dsh-client-ui-sidebar-browser', 'lib', 'client.js'),
]) {
  if (!existsSync(client)) continue
  let text = readFileSync(client, 'utf8')
  const old = 'return workspace === void 0 ? `session:${sessionId}` : `cwd:${workspace.path}`;'
  if (text.includes(old)) {
    text = text.replace(old, "return 'botcamp:team';")
    writeFileSync(client, text)
    console.log('shared direct sidebar browser profile:', client)
  }
}

const branded = rebrandTree(root, { log: (line) => console.log(line) })
console.log(`rebranded ${branded.words} DSH mention(s) in ${branded.files} file(s)`)
