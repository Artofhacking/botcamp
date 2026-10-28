import { spawnSync } from 'node:child_process'
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { build } from 'esbuild'

const version = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version
const define = { __DSH_VERSION__: JSON.stringify(version) }
rmSync(new URL('./dist', import.meta.url), { recursive: true, force: true })

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  define,
})
await build({
  entryPoints: ['src/preload.ts'],
  outfile: 'dist/preload.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  define,
})
await build({
  entryPoints: ['src/renderer.ts'],
  outfile: 'dist/renderer.js',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  define,
})
const html = readFileSync(new URL('./src/index.html', import.meta.url), 'utf8').replaceAll('__DSH_VERSION__', version)
writeFileSync(new URL('./dist/index.html', import.meta.url), html)
cpSync(new URL('./LICENSE', import.meta.url), new URL('./dist/LICENSE', import.meta.url))

const result = spawnSync(
  'npx',
  ['electron-builder', '--config', 'electron-builder.cjs', '--mac', '--arm64', '--publish', 'never'],
  {
    stdio: 'inherit',
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
  },
)
if (result.status !== 0) process.exit(result.status ?? 1)
console.log(`Built DSH Desktop ${version} for Apple Silicon`)
