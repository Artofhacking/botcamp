#!/usr/bin/env node
/**
 * The payload collector resolves each dependency from the workspace that owns it,
 * so a package that lives in one workspace cannot see peers installed for another.
 * Fill the gaps with directory links instead of reinstalling: no package.json edits,
 * no second install, identical result on macOS and Windows.
 *
 * Usage: node desktop/fix-payload.mjs <path-to-dsh-desktop>
 */
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rebrandTree } from './rebrand.mjs'

// Absolute, so every symlink target below resolves from the link's own directory.
const here = dirname(fileURLToPath(import.meta.url))
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

// The Main Bot is a lead, not a soloist: it must dispatch the specialist crew in
// the team room instead of doing every role's work itself. Patch the installed
// ds-bot package so both new teams and repaired teams get the same contract.
const mainRole = `你是自媒体团队的主编，职责是定方向、拆任务、分派、验收和整合，不是亲自完成所有岗位工作。
默认流程：
1. 先判断任务需要哪些岗位：选题策划、文案编导、视频编导、视觉设计、数据运营。
2. 在「自媒体运营团队」群里 @ 对应 Bot，写清交付物、输入、截止点和验收标准。
3. 成员各自产出，你负责收集、拍板和整合。
4. 不要替成员写完整稿、做设计、拉数据或做视频脚本；只有成员都不可用，或用户明确要求你亲自做时，才自己执行。
5. 每次回复用户时，先说明你分派给了谁、各自交付了什么，再给最终结论。
群组是默认协作场所。不要绕过群聊私拉人，也不要把所有活揽在自己身上。`
const roomNotice = '主编负责拆解、调度和验收；选题策划、文案编导、视频编导、视觉设计、数据运营各司其职。用户任务先进群，由主编 @ 对应岗位并说明交付物；成员不越权，主编不代替成员完成本职。'
for (const roster of [
  join(root, 'node_modules', 'ds-bot', 'src', 'host', 'roster.js'),
  join(root, 'dsh-desktop-next', 'node_modules', 'ds-bot', 'src', 'host', 'roster.js'),
]) {
  if (!existsSync(roster)) continue
  let text = readFileSync(roster, 'utf8')
  const oldMain = '你是自媒体团队的主编，负责内容方向、选题质量、稿件把关和团队协作。先读用户完成初始化后留下的平台、账号、目标、受众和干预度资料；公开信息先自己查，只问用户无法从公开信息判断的目标、资源和限制。再协调选题策划、文案编导、视频编导、视觉设计、数据运营，按“选题→文案→视频→视觉→发布→复盘”推进。给结论和最低成本启动方案，不教成熟用户基础操作，不奉承、不训斥，最终决定权交给用户。'
  const oldNotice = '先对齐平台、账号定位、受众和更新节奏；日常按“选题→文案→视频→视觉→发布→复盘”协作。干预度以初始化资料为准。'
  let changed = false
  if (text.includes(oldMain)) { text = text.replaceAll(oldMain, mainRole); changed = true }
  if (text.includes(oldNotice)) { text = text.replaceAll(oldNotice, roomNotice); changed = true }
  if (changed) { writeFileSync(roster, text); console.log('main lead / room notice:', roster) }
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

// A process restart is not a user-facing failure: hide the DSH "interrupted" row
// and let the next Bot turn continue from the retained transcript.
for (const chat of [
  join(root, 'node_modules', '@deepseek-ai', 'dsh-client-ui-chat', 'lib', 'client.js'),
  join(root, 'dsh-desktop-next', 'node_modules', '@deepseek-ai', 'dsh-client-ui-chat', 'lib', 'client.js'),
]) {
  if (!existsSync(chat)) continue
  let text = readFileSync(chat, 'utf8')
  const old = '\t\tfunction TurnErrorItem({ node, t }) {\n\t\t\treturn (0, react_jsx_runtime.jsxs)("div", {'
  if (text.includes(old)) {
    text = text.replace(old, '\t\tfunction TurnErrorItem({ node, t }) {\n\t\t\tif (node.code === "INTERRUPTED") return null;\n\t\t\treturn (0, react_jsx_runtime.jsxs)("div", {')
    writeFileSync(chat, text)
    console.log('hide interrupted turn row:', chat)
  }
}

// BotCamp DS Bot patches: template-aware roster, bot avatars, browser tools and
// open-card handling. Copy over the installed package so npm/yarn cannot undo it.
const dsBotPatch = join(here, 'overlay', 'ds-bot')
for (const installed of [
  join(root, 'node_modules', 'ds-bot'),
  join(root, 'dsh-desktop-next', 'node_modules', 'ds-bot'),
]) {
  if (!existsSync(installed)) continue
  cpSync(dsBotPatch, installed, { recursive: true, force: true })
  console.log('ds-bot patches:', installed)
}

const branded = rebrandTree(root, { log: (line) => console.log(line) })
console.log(`rebranded ${branded.words} DSH mention(s) in ${branded.files} file(s)`)
