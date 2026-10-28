#!/usr/bin/env node
/**
 * The payload collector resolves peers through the workspace that owns each package.
 * dsh-community-market carries its own copy of @deepseek-ai/* whose peers are not
 * installed, so point that copy at the application's tree (one physical install).
 *
 * Usage: node desktop/fix-payload.mjs <path-to-dsh-desktop>
 */
import { cpSync, existsSync, lstatSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'

const root = process.argv[2]
if (!root) { console.error('usage: node desktop/fix-payload.mjs <path-to-dsh-desktop>'); process.exit(1) }

const market = join(root, 'dsh-community-market', 'node_modules', '@deepseek-ai')
const app = join(root, 'dsh-desktop-next', 'node_modules', '@deepseek-ai')
if (!existsSync(app)) { console.error('application node_modules missing:', app); process.exit(1) }
if (!existsSync(market)) { console.log('nothing to fix: no market copy'); process.exit(0) }

rmSync(market, { recursive: true, force: true })
try {
  symlinkSync(app, market, process.platform === 'win32' ? 'junction' : 'dir')
  console.log('linked market packages ->', app)
} catch (error) {
  console.warn('symlink failed, copying instead:', error.message)
  cpSync(app, market, { recursive: true, dereference: true })
  console.log('copied market packages from', app)
}
