async function send(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || data.ok === false) {
    const message = data.error?.message ?? '请求失败'
    throw Object.assign(new Error(typeof message === 'string' ? message : '请求失败'), { status: response.status })
  }
  return data
}

export async function me() {
  const response = await fetch('api/auth/me', { credentials: 'same-origin', cache: 'no-store' })
  if (response.status === 401) return null
  const data = await response.json().catch(() => ({}))
  if (!response.ok || data.ok === false) throw new Error(data.error?.message ?? '无法确认登录状态')
  return data.user ?? null
}

export function login(email, password) {
  return send('api/auth/login', { method: 'POST', body: { email, password } })
}

export function logout() {
  return send('api/auth/logout', { method: 'POST', body: {} }).catch(() => {})
}

export function listUsers() {
  return send('api/admin/users')
}

export function createUser(body) {
  return send('api/admin/users', { method: 'POST', body })
}

export function updateUser(id, body) {
  return send(`api/admin/users/${encodeURIComponent(id)}`, { method: 'PATCH', body })
}

export function deleteUser(id) {
  return send(`api/admin/users/${encodeURIComponent(id)}`, { method: 'DELETE' })
}
