#!/usr/bin/env node
/**
 * Apply BotCamp branding + bundles to a checkout of anywhere-labs/dsh-desktop.
 * Patches the desktop profile template so `ds-bot` and `@botcamp/dsh-library`
 * are active for new and existing profiles, copies the library plugin into the
 * payload, and adds it as a `file:` dependency.
 * Usage: node desktop/apply.mjs <path-to-dsh-desktop>
 */
import { copyFileSync, cpSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = process.argv[2]
const here = dirname(fileURLToPath(import.meta.url))
if (!root) { console.error('usage: node desktop/apply.mjs <path-to-dsh-desktop>'); process.exit(1) }

const pkgPath = join(root, 'dsh-desktop-next/package.json')
const dirPath = join(root, 'dsh-desktop-next/src/data-directory.ts')
const verifyPath = join(root, 'dsh-desktop-next/scripts/verify-packaged.ts')
for (const p of [pkgPath, dirPath, verifyPath]) {
  if (!existsSync(p)) { console.error('missing', p); process.exit(1) }
}

// 0) enable the BotCamp bundles in every desktop profile (new and existing)
const profilesPath = join(root, 'dsh-desktop-next/src/profiles.ts')
let profiles = readFileSync(profilesPath, 'utf8')
const webBundles = "export const WEB_BUNDLES = [...PROFILE_TEMPLATES.web!.bundles]"
const webBundlesNext = "export const WEB_BUNDLES = [...PROFILE_TEMPLATES.web!.bundles, 'ds-bot', '@botcamp/dsh-library']"
if (profiles.includes(webBundles)) {
  profiles = profiles.replace(webBundles, webBundlesNext)
  console.log('profiles.ts: BotCamp bundles added to WEB_BUNDLES')
} else if (!profiles.includes(webBundlesNext)) {
  console.warn('profiles.ts: WEB_BUNDLES pattern not found; check upstream')
}
const ensureAnchor = `    if (existing) {
      const manifest = this.manifest(name)`
const ensurePatch = `    if (existing) {
      const manifest = this.manifest(name)
      const botcampBundles = ['ds-bot', '@botcamp/dsh-library']
      const missingBundles = botcampBundles.filter(bundle => !manifest.dsh.profile.bundles.includes(bundle))
      if (missingBundles.length > 0) {
        manifest.dsh.profile.bundles = [...manifest.dsh.profile.bundles, ...missingBundles]
        atomicJson(join(dir, 'package.json'), manifest)
      }`
if (profiles.includes(ensureAnchor) && !profiles.includes('const botcampBundles')) {
  profiles = profiles.replace(ensureAnchor, ensurePatch)
  console.log('profiles.ts: existing profiles migrate to BotCamp bundles')
}
writeFileSync(profilesPath, profiles)

// 1) product identity + update feed + bundle ds-bot
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const requestedVersion = process.env.BOTCAMP_DESKTOP_VERSION
if (requestedVersion) {
  const version = requestedVersion.trim().replace(/^v/u, '')
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error(`BOTCAMP_DESKTOP_VERSION must be semver, got ${JSON.stringify(requestedVersion)}`)
  }
  pkg.version = version
  console.log(`desktop version: ${version}`)
}
pkg.build.appId = 'site.demox.botcamp'
pkg.build.productName = 'BotCamp'
pkg.build.mac.target = ['dir']
pkg.build.mac.artifactName = 'BotCamp-${version}-${arch}.${ext}'
pkg.build.publish = { provider: 'generic', url: 'https://camp.aigc.sx.cn/botcamp/updates/mac' }
pkg.dependencies['ds-bot'] = '0.2.3'

// BotCamp Library: ship the adapted reader as a first-class profile bundle.
// The plugin is a local package; the desktop profile picks it up from the
// same dependency set as ds-bot.
const librarySrc = join(here, 'plugins', 'botcamp-library')
const libraryDest = join(root, 'dsh-desktop-next', 'plugins', 'botcamp-library')
mkdirSync(join(root, 'dsh-desktop-next', 'plugins'), { recursive: true })
cpSync(librarySrc, libraryDest, {
  recursive: true,
  filter: (source) => !/[\\/](preview|test|shots)([\\/]|$)/.test(source) && !source.endsWith('.tgz'),
})
pkg.dependencies['@botcamp/dsh-library'] = 'file:plugins/botcamp-library'
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

// 3b) the final fuse check must look for the branded executable, not DSH NEXT
const fusesPath = join(root, 'dsh-desktop-next/scripts/verify-fuses.ts')
let fuses = readFileSync(fusesPath, 'utf8')
if (!fuses.includes('const productName = JSON.parse')) {
  fuses = fuses.replace("import { existsSync } from 'node:fs'", "import { existsSync, readFileSync } from 'node:fs'")
  const oldPaths = `  const paths = ['mac/DSH NEXT.app/Contents/MacOS/DSH NEXT', 'mac-arm64/DSH NEXT.app/Contents/MacOS/DSH NEXT',
    'mac-universal/DSH NEXT.app/Contents/MacOS/DSH NEXT', 'win-unpacked/DSH NEXT.exe', 'linux-unpacked/dsh-desktop-next']`
  const newPaths = `  const productName = JSON.parse(readFileSync(join(desktopRoot, 'package.json'), 'utf8')).build.productName
  const paths = [\`mac/\${productName}.app/Contents/MacOS/\${productName}\`, \`mac-arm64/\${productName}.app/Contents/MacOS/\${productName}\`,
    \`mac-universal/\${productName}.app/Contents/MacOS/\${productName}\`, \`win-unpacked/\${productName}.exe\`, 'linux-unpacked/dsh-desktop-next']`
  if (fuses.includes(oldPaths)) {
    fuses = fuses.replace(oldPaths, newPaths)
    writeFileSync(fusesPath, fuses)
    console.log('verify-fuses.ts: product name follows branding')
  } else {
    console.warn('verify-fuses.ts: path list pattern not found; check upstream')
  }
}

// 3c) the DMG verifier must use the branded product name too
const verifyMacPath = join(root, 'dsh-desktop-next/scripts/verify-mac-release.ts')
let verifyMac = readFileSync(verifyMacPath, 'utf8')
if (!verifyMac.includes('const productName = JSON.parse')) {
  verifyMac = verifyMac.replace(
    "import { mkdtempSync, readdirSync, rmdirSync, statSync } from 'node:fs'",
    "import { mkdtempSync, readFileSync, readdirSync, rmdirSync, statSync } from 'node:fs'",
  )
  verifyMac = verifyMac.replace(
    'export function verifyNextMac(signed: boolean): void {',
    "const productName = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).build.productName\n\nexport function verifyNextMac(signed: boolean): void {",
  )
  verifyMac = verifyMac.replace("productName: 'DSH NEXT'", 'productName')
  writeFileSync(verifyMacPath, verifyMac)
  console.log('verify-mac-release.ts: product name follows branding')
}

// 4) first-run pairing overlay + the agent it keeps running
const src = join(root, 'dsh-desktop-next', 'src')
mkdirSync(src, { recursive: true })
copyFileSync(join(here, 'overlay', 'botcamp-onboarding.ts'), join(src, 'botcamp-onboarding.ts'))

const mainPath = join(src, 'main.ts')
let main = readFileSync(mainPath, 'utf8')
if (!main.includes('botcamp-onboarding.ts')) {
  const lines = main.split('\n')
  const lastImport = lines.reduce((last, line, index) => (line.startsWith('import ') ? index : last), 0)
  lines.splice(lastImport + 1, 0, "import { botcampEnsureDevice, stopBotcampRelay } from './botcamp-onboarding.ts'")
  main = lines.join('\n')
  main = main.replace('await app.whenReady()', 'await app.whenReady()\n  await botcampEnsureDevice().catch(() => {})')
  main = main.replace("app.once('will-quit', () => { desktopShortcuts?.dispose() })",
    "app.once('will-quit', () => { stopBotcampRelay(); desktopShortcuts?.dispose() })")
  writeFileSync(mainPath, main)
  console.log('main.ts: pairing hook installed')
}

const resources = join(root, 'dsh-desktop-next', 'resources')
mkdirSync(resources, { recursive: true })
copyFileSync(join(here, '..', 'agent', 'botcamp-agent.mjs'), join(resources, 'botcamp-agent.mjs'))
pkg.build.extraResources = [{ from: 'resources/botcamp-agent.mjs', to: 'botcamp-agent.mjs' }]
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')

console.log('applied BotCamp branding to', root)
console.log('bundled @botcamp/dsh-library from desktop/plugins/botcamp-library')
