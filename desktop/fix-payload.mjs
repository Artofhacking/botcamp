#!/usr/bin/env node
/**
 * The payload collector resolves each dependency from the workspace that owns it,
 * so a package that lives in one workspace cannot see peers installed for another.
 * Fill the gaps with directory links instead of reinstalling: no package.json edits,
 * no second install, identical result on macOS and Windows.
 *
 * Usage: node desktop/fix-payload.mjs <path-to-dsh-desktop>
 */
import { existsSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'

const root = process.argv[2]
if (!root) { console.error('usage: node desktop/fix-payload.mjs <path-to-dsh-desktop>'); process.exit(1) }

const appAi = join(root, 'dsh-desktop-next', 'node_modules', '@deepseek-ai')
if (!existsSync(appAi)) { console.error('application node_modules missing:', appAi); process.exit(1) }

const targets = [
  join(root, 'node_modules', '@deepseek-ai'),
  join(root, 'dsh-community-market', 'node_modules', '@deepseek-ai'),
]

let filled = 0
for (const dir of targets) {
  mkdirSync(dir, { recursive: true })
  for (const name of readdirSync(appAi)) {
    const target = join(dir, name)
    if (existsSync(target)) continue
    try {
      symlinkSync(join(appAi, name), target, process.platform === 'win32' ? 'junction' : 'dir')
      filled += 1
    } catch (error) {
      console.warn(`could not link ${name} into ${dir}:`, error.message)
    }
  }
}
console.log(`linked ${filled} package(s) across ${targets.length} node_modules roots`)
