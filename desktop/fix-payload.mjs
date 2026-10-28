#!/usr/bin/env node
/**
 * The payload collector resolves each dependency from the workspace that owns it,
 * so a package that lives in one workspace cannot see peers installed for another.
 * Fill the gaps with directory links instead of reinstalling: no package.json edits,
 * no second install, identical result on macOS and Windows.
 *
 * Usage: node desktop/fix-payload.mjs <path-to-dsh-desktop>
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'

const root = process.argv[2]
if (!root) { console.error('usage: node desktop/fix-payload.mjs <path-to-dsh-desktop>'); process.exit(1) }

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
