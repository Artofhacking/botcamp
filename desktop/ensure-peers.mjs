#!/usr/bin/env node
/**
 * The payload collector needs every @deepseek-ai peer of every installed package.
 * Read the installed metadata, find peers that resolve nowhere, and pin them at the
 * workspace root with the version of the package that asks for them.
 *
 * Usage: node desktop/ensure-peers.mjs <path-to-dsh-desktop>
 * Exit code 0 always; prints "changed" when package.json was written.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.argv[2]
if (!root) { console.error('usage: node desktop/ensure-peers.mjs <path-to-dsh-desktop>'); process.exit(1) }
const appAi = join(root, 'dsh-desktop-next', 'node_modules', '@deepseek-ai')
const rootAi = join(root, 'node_modules', '@deepseek-ai')
if (!existsSync(appAi)) { console.log('no application install yet'); process.exit(0) }

const missing = new Map()
for (const dir of readdirSync(appAi)) {
  const manifest = join(appAi, dir, 'package.json')
  if (!existsSync(manifest)) continue
  let meta
  try { meta = JSON.parse(readFileSync(manifest, 'utf8')) } catch { continue }
  for (const name of Object.keys(meta.peerDependencies || {})) {
    if (!name.startsWith('@deepseek-ai/')) continue
    if (existsSync(join(rootAi, name)) || existsSync(join(appAi, name))) continue
    if (!missing.has(name)) missing.set(name, meta.version || '*')
  }
}
if (missing.size === 0) { console.log('all peers resolve'); process.exit(0) }

const pkgPath = join(root, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
pkg.devDependencies = pkg.devDependencies || {}
for (const [name, version] of missing) pkg.devDependencies[name] = version
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
console.log('changed: pinned', [...missing.keys()].join(', '))
