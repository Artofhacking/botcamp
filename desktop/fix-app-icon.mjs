#!/usr/bin/env node
/**
 * Make a built macOS app use the BotCamp icon on the Dock/Finder.
 *
 * Electron Builder can leave an upstream `CFBundleIconName` and Assets.car in
 * place. macOS then prefers the asset catalog over the `icon.icns` we ship, so
 * replacing the icns alone is not enough. Remove that key after packaging.
 *
 * Usage: node desktop/fix-app-icon.mjs <BotCamp.app>
 */
import { copyFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const app = resolve(process.argv[2] ?? '')
if (!app || !existsSync(join(app, 'Contents', 'Info.plist'))) {
  console.error('usage: node desktop/fix-app-icon.mjs <BotCamp.app>')
  process.exit(1)
}
const plist = join(app, 'Contents', 'Info.plist')
copyFileSync(join(here, 'assets', 'icon.icns'), join(app, 'Contents', 'Resources', 'icon.icns'))
try {
  execFileSync('plutil', ['-remove', 'CFBundleIconName', plist], { stdio: 'ignore' })
  console.log('removed CFBundleIconName from', plist)
} catch {
  console.log('CFBundleIconName was already absent')
}
