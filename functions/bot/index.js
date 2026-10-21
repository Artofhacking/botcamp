// Demox entry. The gate implementation lives in app/botcamp so a forged client
// hits the same rules as the Vite proxy. If that module cannot be loaded, fail
// closed: do not proxy the body to the kernel.

exports.handler = async (request, env) => {
  try {
    const gate = await import('../../app/botcamp/demoxGate.mjs')
    return await gate.handleDemox(request || {}, env || {})
  } catch (error) {
    console.error('[botcamp]', error instanceof Error ? error.message : 'gate failed')
    return {
      statusCode: 401,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
      body: JSON.stringify({ ok: false, error: { code: 'auth/required', message: '请先登录' } }),
    }
  }
}
