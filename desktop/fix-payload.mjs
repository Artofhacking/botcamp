#!/usr/bin/env node
/**
 * The payload collector resolves each dependency from the workspace that owns it.
 * dsh-community-market carries its own copy of @deepseek-ai/* but not every peer,
 * so fill the gaps with links to the application's copies instead of replacing the
 * whole directory (the market still builds against its own install).
 *
 * Usage: node desktop/fix-payload.mjs <path-to-dsh-desktop>
 */
import { existsSync, readdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'

const root = process.argv[2]
if (!root) { console.error('usage: node desktop/fix-payload.mjs <path-to-dsh-desktop>'); process.exit(1) }

const market = join(root, 'dsh-community-market', 'node_modules', '@deepseek-ai')
const app = join(root, 'dsh-desktop-next', 'node_modules', '@deepseek-ai')
if (!existsSync(app)) { console.error('application node_modules missing:', app); process.exit(1) }
if (!existsSync(market)) { console.log('nothing to fill: no market copy'); process.exit(0) }

let filled = 0
for (const name of readdirSync(app)) {
  const target = join(market, name)
  if (existsSync(target)) continue
  try {
    symlinkSync(join(app, name), target, process.platform === 'win32' ? 'junction' : 'dir')
    filled += 1
  } catch (error) {
    console.warn(`could not link ${name}:`, error.message)
  }
}
console.log(`filled ${filled} missing package(s) in the market workspace`)
