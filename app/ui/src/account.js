import { clearToken, clientMode, readToken, saveToken } from './session.js'

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

// Demox 上已有的云函数只挂了 /api/bot 和 /api/bot/feed。登录和管理因此走这一条 POST，
// 网关在进内核之前把它改写成原来的账号接口。
export async function me() {
  if (clientMode() && !readToken()) return null
  const response = await fetch('api/bot', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: 'auth/me', payload: null }),
  })
  if (response.status === 401) return null
  const data = await response.json().catch(() => ({}))
  if (!response.ok || data.ok === false) throw new Error(data.error?.message ?? '无法确认登录状态')
  return data.user ?? null
}

export async function login(email, password) {
  const data = await send('auth/login', { email, password })
  if (clientMode()) {
    if (typeof data.token !== 'string' || data.token.length < 20) throw new Error('登录没有返回客户端会话')
    saveToken(data.token)
  }
  return data
}

export function changePassword(current, next) {
  return send('auth/password', { current, next })
}

export async function logout() {
  try { await send('auth/logout', {}) } catch { /* leave the window either way */ }
  clearToken()
}

export function listUsers() {
  return send('admin/list', null)
}

export function createUser(body) {
  return send('admin/create', body)
}

export function updateUser(id, body) {
  return send('admin/update', { id, ...body })
}

export function deleteUser(id) {
  return send('admin/delete', { id })
}

export function fetchMediaWorkspace() {
  return send('media/workspace', null)
}

export function fetchMediaManuscript(accountId, manuscriptId) {
  return send('media/manuscript', { accountId, manuscriptId })
}

export function fetchMediaAccounts() {
  return send('media/accounts', null)
}

export function focusMediaAccount(accountId) {
  return send('media/focus', { accountId })
}

export function createMediaAccount(body) {
  return send('media/create-account', body ?? {})
}

export function noteMediaEntity(body) {
  return send('media/note', body)
}
