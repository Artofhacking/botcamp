import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { kernelProxy } from './kernelProxy.mjs'

const primitives = fileURLToPath(new URL('./ui/src/primitives.js', import.meta.url))

// Bot views ask for ./dsh-primitives.js. This window does not load the Harness shell,
// so the local module stands in for that import.
const ownPrimitives = {
  name: 'ds-bot-primitives',
  enforce: 'pre',
  resolveId(source, importer) {
    return source === './dsh-primitives.js' && importer?.replaceAll('\\', '/').includes('/ds-bot/src/client/') ? primitives : null
  },
}

export default defineConfig({
  root: fileURLToPath(new URL('./ui', import.meta.url)),
  base: './',
  plugins: [ownPrimitives, kernelProxy()],
  resolve: { dedupe: ['react', 'react-dom'] },
  server: { host: '127.0.0.1', port: 5173 },
  preview: { host: '127.0.0.1', port: 4173 },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 2048 },
})
