#!/usr/bin/env node
/**
 * Apply BotCamp branding to a checkout of anywhere-labs/dsh-desktop.
 * Usage: node desktop/apply.mjs <path-to-dsh-desktop>
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const root = process.argv[2]
if (!root) { console.error('usage: node desktop/apply.mjs <path-to-dsh-desktop>'); process.exit(1) }

const pkgPath = join(root, 'dsh-desktop-next/package.json')
const dirPath = join(root, 'dsh-desktop-next/src/data-directory.ts')
const verifyPath = join(root, 'dsh-desktop-next/scripts/verify-packaged.ts')
for (const p of [pkgPath, dirPath, verifyPath]) {
  if (!existsSync(p)) { console.error('missing', p); process.exit(1) }
}

// 1) product identity + update feed + bundle ds-bot
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
pkg.build.appId = 'site.demox.botcamp'
pkg.build.productName = 'BotCamp'
pkg.build.mac.target = ['dir']
pkg.build.mac.artifactName = 'BotCamp-${version}-${arch}.${ext}'
pkg.build.publish = { provider: 'generic', url: 'https://camp.aigc.sx.cn/botcamp/updates/mac' }
pkg.dependencies['ds-bot'] = '0.2.3'
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')

// 1b) peers the payload collector cannot resolve without an explicit entry
pkg.dependencies['@deepseek-ai/dsh-scope'] = peerVersionOf(pkg)
pkg.dependencies['@deepseek-ai/dsh-system-prompt'] = peerVersionOf(pkg)
pkg.dependencies['@deepseek-ai/dsh-user-approval'] = peerVersionOf(pkg)
pkg.dependencies['@deepseek-ai/cordis-plugin-include'] =
  pkg.dependencies['@deepseek-ai/cordis-plugin-include'] || '1.0.10'

// 1c) the same packages at the workspace root
const rootPkgPath = join(root, 'package.json')
const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf8'))
function peerVersionOf(manifest) { return manifest.dependencies['@deepseek-ai/dsh-agent'] || '0.2.1-rc.4' }
const peerVersion = peerVersionOf(pkg)
rootPkg.devDependencies = rootPkg.devDependencies || {}
for (const name of ['@deepseek-ai/dsh-scope', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-user-approval']) {
  rootPkg.devDependencies[name] = peerVersion
}
rootPkg.devDependencies['@deepseek-ai/cordis-plugin-include'] =
  pkg.dependencies['@deepseek-ai/cordis-plugin-include'] || '1.0.10'
writeFileSync(rootPkgPath, JSON.stringify(rootPkg, null, 2) + '\n')

// 2) data directory: ~/.dsh -> ~/.botcamp
const dir = readFileSync(dirPath, 'utf8')
const nextDir = dir.replace("join(userHome, '.dsh')", "join(userHome, '.botcamp')")
if (nextDir === dir) console.warn('data-directory.ts: pattern already applied or changed')
writeFileSync(dirPath, nextDir)

// 3) packaging check must follow the product name
const verify = readFileSync(verifyPath, 'utf8')
const nextVerify = verify.replace(
  "join(context.appOutDir, 'DSH NEXT.app/Contents/Resources')",
  'join(context.appOutDir, `${context.packager.appInfo.productFilename}.app/Contents/Resources`)',
)
if (nextVerify === verify) console.warn('verify-packaged.ts: pattern already applied or changed')
writeFileSync(verifyPath, nextVerify)

console.log('applied BotCamp branding to', root)
