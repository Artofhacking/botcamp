// 登录、会话和配额都走本站的 /api/bot。Demox 只把 /api/bot 和 /api/bot/feed
// 交给云函数，所以不能再请求 /api/auth。请求留在当前源，不跳去 camp。
async function send(endpoint, payload) {
  const response = await fetch('api/bot', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint, payload: payload ?? null }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || data.ok === false) {
    const message = data.error?.message ?? '请求失败'
    throw Object.assign(new Error(typeof message === 'string' ? message : '请求失败'), { status: response.status })
  }
  return data
}

export async function me() {
  const response = await fetch('api/bot', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: 'botcamp/me', payload: null }),
  })
  if (response.status === 401) return null
  const data = await response.json().catch(() => ({}))
  if (!response.ok || data.ok === false) throw new Error(data.error?.message ?? '无法确认登录状态')
  return data.user ?? null
}

export function login(email, password) {
  return send('botcamp/login', { email, password })
}

export function logout() {
  return send('botcamp/logout', {}).catch(() => {})
}

export function listUsers() {
  return send('botcamp/admin-list')
}

export function createUser(body) {
  return send('botcamp/admin-create', body)
}

export function updateUser(id, body) {
  return send('botcamp/admin-update', { ...body, id })
}

export function deleteUser(id) {
  return send('botcamp/admin-delete', { id })
}
