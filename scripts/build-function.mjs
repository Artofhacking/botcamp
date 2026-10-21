import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(path.join(root, 'app/package.json'))
const esbuild = require('esbuild')

await esbuild.build({
  entryPoints: [path.join(root, 'functions/bot/entry.mjs')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  outfile: path.join(root, 'functions/bot/index.js'),
  legalComments: 'none',
  logOverride: { 'empty-import-meta': 'silent' },
  banner: {
    js: '// 由 scripts/build-function.mjs 从 functions/bot/entry.mjs 打包。改入口，不要手改这个文件。',
  },
})
