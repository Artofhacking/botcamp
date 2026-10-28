/** Read and write 主编 on the shared project ledger. This module never deletes a transcript. */

import { CHIEF_LEDGER_URL, CHIEF_SESSION_ID } from './contract.ts'

const ENDPOINTS = new Set(['auth/login', 'chat', 'send'])

export interface LedgerResult {
  readonly status: number
  readonly data: {
    readonly ok?: boolean
    readonly token?: string
    readonly error?: { readonly message?: string }
    readonly value?: { readonly items?: unknown; readonly tool?: unknown }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Drop a token that could not be a session, without echoing it. */
export function cleanToken(value: unknown): string {
  if (typeof value !== 'string') return ''
  const token = value.trim()
  if (token.length === 0 || token.length > 400 || /[\s\u0000-\u001f]/u.test(token)) return ''
  return token
}

function ledgerPayload(endpoint: string, payload: unknown): unknown {
  if (endpoint === 'chat' || endpoint === 'send') {
    const body = isRecord(payload) ? { ...payload } : {}
    body.sessionId = CHIEF_SESSION_ID
    body.botId = CHIEF_SESSION_ID
    return body
  }
  if (endpoint === 'auth/login') {
    const body = isRecord(payload) ? payload : {}
    const email = typeof body.email === 'string' ? body.email.trim() : ''
    const password = typeof body.password === 'string' ? body.password : ''
    if (!email || email.length > 200 || password.length === 0 || password.length > 200) {
      throw new Error('需要邮箱和密码。')
    }
    return { email, password }
  }
  return null
}

/**
 * POST one allowed ledger call.
 * Network failures use a fixed message so a token in a lower-level error cannot surface.
 */
export async function postLedger(
  endpoint: string,
  payload: unknown,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LedgerResult> {
  if (!ENDPOINTS.has(endpoint)) throw new Error('没有这个接口。')
  const body = ledgerPayload(endpoint, payload)
  const encoded = JSON.stringify({ endpoint, payload: body })
  if (encoded.length > 20_000) throw new Error('这条消息太长了。')
  const headers = new Headers({
    'content-type': 'application/json',
    'x-botcamp-client': '1',
  })
  const session = cleanToken(token)
  if (session) headers.set('authorization', `Bearer ${session}`)
  let response: Response
  try {
    response = await fetchImpl(CHIEF_LEDGER_URL, {
      method: 'POST',
      headers,
      body: encoded,
      cache: 'no-store',
    })
  } catch {
    throw new Error('账本暂时没有连上。')
  }
  let data: LedgerResult['data'] = {}
  try {
    const parsed: unknown = await response.json()
    if (isRecord(parsed)) data = parsed as LedgerResult['data']
  } catch {
    data = {}
  }
  return { status: response.status, data }
}
