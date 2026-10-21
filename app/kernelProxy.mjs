const KERNEL = (process.env.DSH_KERNEL_ORIGIN ?? 'https://camp.aigc.sx.cn').replace(/\/$/, '')

function readSetCookie(response) {
  const headers = response.headers
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie()
  const single = headers.get('set-cookie')
  return single ? [single] : []
}

function storeCookies(jar, response) {
  for (const cookie of readSetCookie(response)) {
    const pair = cookie.split(';', 1)[0] ?? ''
    const eq = pair.indexOf('=')
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
  }
}

function cookieHeader(jar) {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks)
}

export function kernelProxy() {
  const jar = new Map()

  async function refreshCookie() {
    jar.clear()
    let url = `${KERNEL}/`
    for (let hop = 0; hop < 6; hop += 1) {
      const response = await fetch(url, {
        redirect: 'manual',
        headers: cookieHeader(jar) ? { cookie: cookieHeader(jar) } : {},
      })
      storeCookies(jar, response)
      const location = response.headers.get('location')
      if (!location || response.status < 300 || response.status >= 400) break
      url = new URL(location, url).toString()
    }
  }

  const middleware = async (req, res, next) => {
    const url = req.url ?? ''
    if (!url.startsWith('/api/')) {
      next()
      return
    }
    try {
      if (jar.size === 0) await refreshCookie()
      const body = await readBody(req)
      const send = () => fetch(new URL(url, `${KERNEL}/`), {
        method: req.method,
        headers: {
          origin: KERNEL,
          cookie: cookieHeader(jar),
          'content-type': String(req.headers['content-type'] ?? 'application/json'),
        },
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
        redirect: 'manual',
      })
      let upstream = await send()
      if (upstream.status === 401) {
        await refreshCookie()
        upstream = await send()
      }
      storeCookies(jar, upstream)
      res.statusCode = upstream.status
      const contentType = upstream.headers.get('content-type')
      if (contentType) res.setHeader('content-type', contentType)
      res.setHeader('cache-control', 'no-store')
      if (upstream.body == null) {
        res.end()
        return
      }
      const reader = upstream.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!res.write(value)) await new Promise(resolve => res.once('drain', resolve))
      }
      res.end()
    } catch (error) {
      res.statusCode = 502
      res.setHeader('content-type', 'application/json')
      const message = error instanceof Error ? error.message : 'kernel proxy failed'
      res.end(JSON.stringify({ error: message }))
    }
  }

  return {
    name: 'dsh-kernel-proxy',
    configureServer(server) {
      server.middlewares.use(middleware)
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware)
    },
  }
}
