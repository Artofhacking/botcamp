import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply } from '../lib/index.js'

const here = fileURLToPath(new URL('.', import.meta.url))
process.env.BOTCAMP_LIBRARY_ROOT = join(here, 'library')

const routes = []
apply({
  webServer: {
    register(route) {
      routes.push(route)
      return () => {}
    },
  },
  systemPrompt: { section: () => () => {} },
  effect(factory) {
    const dispose = factory()
    return typeof dispose === 'function' ? dispose : () => {}
  },
})

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.tgz': 'application/gzip',
}

async function sendFile(res, path) {
  try {
    const body = await readFile(path)
    res.writeHead(200, {
      'content-type': MIME[extname(path).toLowerCase()] ?? 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-store',
    })
    res.end(body)
  } catch {
    res.writeHead(404)
    res.end('not found')
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  // Mimic the BotCamp nginx rewrite: /desk/dN/* -> /*
  const pathname = url.pathname.replace(/^\/desk\/d\d+/, '') || '/'
  if (pathname !== url.pathname) req.url = pathname + url.search
  if (pathname === '/' || pathname === '/index.html') {
    await sendFile(res, join(here, 'index.html'))
    return
  }
  if (pathname === '/client.js') {
    await sendFile(res, join(here, '..', 'lib', 'client.cjs'))
    return
  }
  if (pathname === '/react.js') {
    await sendFile(res, join(here, '..', 'standalone', 'react.js'))
    return
  }
  if (pathname === '/react-dom.js') {
    await sendFile(res, join(here, '..', 'standalone', 'react-dom.js'))
    return
  }
  if (pathname === '/plugin.tgz') {
    await sendFile(res, join(here, '..', 'botcamp-dsh-library-0.1.0.tgz'))
    return
  }
  for (const route of routes) {
    if (pathname === route.path || pathname.startsWith(`${route.path}/`) || pathname.startsWith(route.path)) {
      await route.handler(req, res)
      return
    }
  }
  res.writeHead(404)
  res.end('not found')
})

const port = Number(process.env.PORT ?? 4173)
server.listen(port, '127.0.0.1', () => {
  console.log(`BotCamp Library preview: http://127.0.0.1:${port}/`)
})
