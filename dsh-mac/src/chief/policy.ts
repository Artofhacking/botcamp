/** Host and page checks for 主编's own browser. Cookies never leave this machine. */

const PRIVATE_HOST = /^(?:localhost|.*\.localhost|metadata\.google\.internal)$/u
const PRIVATE_ADDR = /^(?:127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0|\[)/u

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Hosts the ledger attached to a tool call. Anything else is dropped. */
export function allowedHosts(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const hosts: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const host = item.trim().toLowerCase().replace(/\.$/u, '')
    if (!/^[a-z0-9.-]{1,253}$/u.test(host) || PRIVATE_HOST.test(host)) continue
    hosts.push(host)
    if (hosts.length >= 32) break
  }
  return hosts
}

/** https pages on the signed-in user's own sites only. */
export function hostAllowed(url: string, hosts: readonly string[]): boolean {
  let parsed: URL
  try { parsed = new URL(url) } catch { return false }
  if (parsed.protocol !== 'https:') return false
  const name = parsed.hostname.toLowerCase().replace(/\.$/u, '')
  if (!name || PRIVATE_HOST.test(name) || PRIVATE_ADDR.test(name)) return false
  return hosts.some(host => name === host || name.endsWith(`.${host}`))
}

/** Text the model can use after this app reads a page it opened. */
export function pageBrief(page: unknown): string {
  const record = isRecord(page) ? page : {}
  const url = typeof record.url === 'string' ? record.url : ''
  const title = typeof record.title === 'string' ? record.title : ''
  const text = typeof record.text === 'string' ? record.text.trim() : ''
  const body = text.slice(0, 5000)
  if (!body) {
    return `打开了 ${url || '页面'}${title ? `（${title}）` : ''}。页面上没有读到正文。创作者后台需要这个号自己的登录 cookie。`
  }
  return [`页面 ${title}`.trim(), url, body].filter(Boolean).join('\n')
}
