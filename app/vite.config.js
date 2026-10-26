import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { cp } from 'node:fs/promises'
import path from 'node:path'
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

const vditorRoot = fileURLToPath(new URL('./node_modules/vditor', import.meta.url))
const diagramLangs = ['abc', 'mermaid', 'smiles', 'markmap', 'flowchart', 'echarts', 'mindmap', 'plantuml', 'graphviz', 'wavedrom']

function vditorFile(pathname) {
  if (!pathname.startsWith('/vditor/')) return null
  let rel = ''
  try { rel = decodeURIComponent(pathname.slice('/vditor/'.length)) } catch { return null }
  if (!rel || rel.includes('\0')) return null
  const file = path.normalize(path.join(vditorRoot, rel))
  if (file !== vditorRoot && !file.startsWith(vditorRoot + path.sep)) return null
  if (!existsSync(file) || !statSync(file).isFile()) return null
  return file
}

function vditorType(file) {
  if (file.endsWith('.js')) return 'text/javascript; charset=utf-8'
  if (file.endsWith('.css')) return 'text/css; charset=utf-8'
  if (file.endsWith('.woff2')) return 'font/woff2'
  if (file.endsWith('.woff')) return 'font/woff'
  if (file.endsWith('.ttf')) return 'font/ttf'
  if (file.endsWith('.svg')) return 'image/svg+xml'
  if (file.endsWith('.png')) return 'image/png'
  return 'application/octet-stream'
}

// Vditor loads lute, KaTeX, and themes from its cdn option. Serve the package locally
// so the editor does not depend on unpkg. Diagram languages stay source code.
function stripDiagrams(code) {
  let next = code
  for (const lang of diagramLangs) next = next.replaceAll(`language === "${lang}"`, `language === "${lang}__off"`)
  return next
}

const vditorDepRewrite = {
  name: 'vditor-no-diagrams',
  setup(build) {
    build.onLoad({ filter: /vditor\/dist\/index\.js$/ }, (args) => ({
      contents: stripDiagrams(readFileSync(args.path, 'utf8')),
      loader: 'js',
    }))
  },
}

function vditorAssets() {
  const serve = (req, res, next) => {
    const pathname = new URL(req.url, 'http://local').pathname
    const file = vditorFile(pathname)
    if (!file) return next()
    res.setHeader('content-type', vditorType(file))
    createReadStream(file).pipe(res)
  }
  return {
    name: 'vditor-assets',
    enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0].replaceAll('\\', '/')
      if (!file.endsWith('/vditor/dist/index.js')) return null
      return { code: stripDiagrams(code), map: null }
    },
    configureServer(server) { server.middlewares.use(serve) },
    configurePreviewServer(server) { server.middlewares.use(serve) },
    async writeBundle() {
      const dest = fileURLToPath(new URL('./ui/dist/vditor', import.meta.url))
      const parts = [
        'dist/js/lute',
        'dist/js/i18n/zh_CN.js',
        'dist/js/icons/ant.js',
        'dist/js/katex',
        'dist/js/highlight.js',
        'dist/css/content-theme',
        'dist/images/emoji',
      ]
      for (const part of parts) {
        await cp(path.join(vditorRoot, part), path.join(dest, part), { recursive: true })
      }
    },
  }
}

export default defineConfig({
  root: fileURLToPath(new URL('./ui', import.meta.url)),
  base: './',
  plugins: [ownPrimitives, vditorAssets(), kernelProxy()],
  resolve: { dedupe: ['react', 'react-dom'] },
  optimizeDeps: { esbuildOptions: { plugins: [vditorDepRewrite] } },
  server: { host: '127.0.0.1', port: 5173 },
  preview: { host: '127.0.0.1', port: 4173 },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 2048 },
})
