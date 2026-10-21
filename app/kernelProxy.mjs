import { createBotcamp } from './botcamp/http.mjs'

// Auth, per-user isolation, and quotas run here, before anything reaches the
// single-tenant dsh kernel. The Demox function (functions/bot) calls the same
// createBotcamp session, so a botcamp_session cookie is checked in both places.
// The browser still only calls /api/bot and /api/bot/feed. The kernel's
// dsh-auth cookie stays in this process.
export function kernelProxy() {
  let ready
  const camp = () => {
    ready ??= createBotcamp()
    return ready
  }
  const middleware = async (req, res, next) => {
    if (!(req.url ?? '').startsWith('/api/')) {
      next()
      return
    }
    try {
      const gate = await camp()
      await gate.handle(req, res, next)
    } catch (error) {
      if (res.writableEnded || res.destroyed) return
      const message = error instanceof Error ? error.message : 'gate failed'
      console.error('[botcamp]', String(message).replace(/([?&#])token=[^&#\s]*/gi, '$1token=').replace(/dsh-auth-[^\s;,]*/gi, 'dsh-auth'))
      res.statusCode = 500
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(JSON.stringify({ ok: false, error: { message: '账号服务暂时不可用。' } }))
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
