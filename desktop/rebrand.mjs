#!/usr/bin/env node
/**
 * BotCamp display branding: the shipped UI never calls itself "DSH".
 *
 * The embedded engine is DSH, but everything a person can read in the app must
 * say BotCamp. This pass rewrites user-facing copy in the desktop shell sources
 * and in the browser bundles that ship as client plugins:
 *
 *   - dsh-desktop-next/src/**            (native shell, settings, onboarding)
 *   - dsh-plugin-desktop{,-beta}/src/**  (recovery assistant, tray, dialogs)
 *   - node_modules/<pkg>/client.js       (every installed client plugin)
 *   - node_modules/<pkg>/locale/*.json   (plugin display names)
 *
 * Internal protocol names are deliberately untouched: `DSH_HOME`, `DSH_PROFILE`,
 * telemetry/trust flags, `X-DSH-*` headers, update channels such as `DSH-NEXT`,
 * and every `@deepseek-ai/*` package id. They are the embedded engine's private
 * handoff (see README "只有 BOTCAMP_* 是对外契约"), not product copy.
 *
 * Usage: node desktop/rebrand.mjs <path-to-dsh-desktop> [--check]
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Product names, not identifiers: fold them to BotCamp whole. "DeepSeek" on its
// own stays — the account sign-in really is a DeepSeek account. These have a
// space (or a lowercase continuation), so they never collide with DSH_*,
// X-DSH-Host or the DSH-NEXT channel name.
const PHRASES = [
  [/DSH Desktop/g, 'BotCamp'],
  [/DSH NEXT/g, 'BotCamp'],
  [/DeepSeek Harness/g, 'BotCamp'],
  // German/English prose writes "DSH-Instanz", "DSH-Build": an adjective, not a token.
  [/DSH-(?=[a-zäöüß])/g, 'BotCamp-'],
]
// A bare word only: DSH_HOME, DSH-NEXT, X-DSH-Desktop and dsh stay as they are.
const WORD = /(?<![A-Za-z0-9_@/.-])DSH(?![A-Za-z0-9_-])/g

const TEXT_FILES = /\.(?:js|mjs|cjs|ts|tsx|jsx|json|css|html)$/u
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage'])
const MAX_BYTES = 4 * 1024 * 1024

function walk(dir, visit, seen = new Set()) {
  let real
  try { real = realpathSync(dir) } catch { return }
  if (seen.has(real)) return
  seen.add(real)
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isSymbolicLink()) {
      walk(full, visit, seen)
    } else if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(full, visit, seen)
    } else if (entry.isFile()) {
      visit(full)
    }
  }
}

function rewrite(text) {
  let next = text
  for (const [pattern, replacement] of PHRASES) next = next.replace(pattern, replacement)
  return next.replace(WORD, 'BotCamp')
}

function patchFile(file, check) {
  let size
  try { size = statSync(file).size } catch { return 0 }
  if (size === 0 || size > MAX_BYTES) return 0
  let text
  try { text = readFileSync(file, 'utf8') } catch { return 0 }
  if (!text.includes('DSH') && !text.includes('DeepSeek Harness')) return 0
  const next = rewrite(text)
  if (next === text) return 0
  const before = (text.match(WORD) ?? []).length + (text.match(/DeepSeek Harness/g) ?? []).length
  if (!check) writeFileSync(file, next)
  return before
}

/** Client bundles are the only package files a person reads; host code stays. */
function isClientAsset(file) {
  const path = file.replaceAll('\\', '/')
  const base = path.slice(path.lastIndexOf('/') + 1)
  if (/^client(?:\.browser)?\.js$/u.test(base)) return true
  if (/\/locale\/[^/]+\.json$/u.test(path)) return true
  return false
}

export function rebrandTree(root, { check = false, log = () => {} } = {}) {
  const desktop = join(root, 'dsh-desktop-next')
  const report = { files: 0, words: 0, checked: check }

  // 1) shell sources — the native shell, recovery assistant and plugin copy live
  // in the workspaces this app bundles. Host-only packages are left alone.
  for (const workspace of ['dsh-desktop-next', 'dsh-plugin-desktop', 'dsh-plugin-desktop-beta', 'dsh-community-market', 'dsh-community-fabric']) {
    const src = join(root, workspace, 'src')
    if (!existsSync(src)) continue
    walk(src, (file) => {
      if (!TEXT_FILES.test(file)) return
      const words = patchFile(file, check)
      if (words > 0) {
        report.files += 1
        report.words += words
        log(`${check ? 'would rewrite' : 'rewrote'} ${relative(root, file)} (${words})`)
      }
    })
  }

  // 2) installed client plugins — the chat transcript, sidebar, dialogs
  for (const modules of [join(root, 'node_modules'), join(desktop, 'node_modules'), join(root, 'dsh-community-market', 'node_modules')]) {
    if (!existsSync(modules)) continue
    walk(modules, (file) => {
      if (!isClientAsset(file)) return
      const words = patchFile(file, check)
      if (words > 0) {
        report.files += 1
        report.words += words
        log(`${check ? 'would rewrite' : 'rewrote'} ${relative(root, file)} (${words})`)
      }
    })
  }

  // 3) plugins that live in the desktop workspace itself
  const plugins = join(desktop, 'plugins')
  if (existsSync(plugins)) {
    walk(plugins, (file) => {
      if (!TEXT_FILES.test(file) || file.includes('/node_modules/')) return
      const words = patchFile(file, check)
      if (words > 0) {
        report.files += 1
        report.words += words
        log(`${check ? 'would rewrite' : 'rewrote'} ${relative(root, file)} (${words})`)
      }
    })
  }

  return report
}

function main(argv) {
  const root = argv[2]
  if (!root) {
    console.error('usage: node desktop/rebrand.mjs <path-to-dsh-desktop> [--check]')
    process.exit(1)
  }
  const check = argv.includes('--check')
  const report = rebrandTree(resolve(root), { check, log: (line) => console.log(line) })
  console.log(`${check ? 'would rewrite' : 'rewrote'} ${report.words} DSH mention(s) in ${report.files} file(s)`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv)
