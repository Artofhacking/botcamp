import { build } from '/workspace/dsh-mac/node_modules/esbuild/lib/main.js'

const external = ['electron']

await build({
  entryPoints: ['/workspace/dsh-real/service-entry.ts'],
  outfile: '/tmp/dsh-inject/chief-service.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external,
  logLevel: 'info',
})

await build({
  entryPoints: ['/workspace/dsh-real/preload-entry.ts'],
  outfile: '/tmp/dsh-inject/chief-preload.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external,
  logLevel: 'info',
})
