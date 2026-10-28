/** cookies.txt, a JSON cookie array, or a Playwright storageState. Values stay on this machine. */

function skipped(reason, name = '') {
  return { name, reason }
}

function normalizeList(list, notes) {
  const cookies = []
  const skippedRows = []
  for (const item of list) {
    if (!item || typeof item !== 'object') {
      skippedRows.push(skipped('not a cookie'))
      continue
    }
    const name = typeof item.name === 'string' ? item.name : ''
    const value = typeof item.value === 'string' ? item.value : ''
    const domain = typeof item.domain === 'string' ? item.domain.trim() : ''
    if (!name || !domain) {
      skippedRows.push(skipped('missing name or domain', name))
      continue
    }
    const expires = Number(item.expires ?? item.expirationDate ?? 0)
    cookies.push({
      name,
      value,
      domain,
      path: typeof item.path === 'string' && item.path ? item.path : '/',
      expires: Number.isFinite(expires) && expires > 0 ? expires : 0,
      httpOnly: item.httpOnly === true,
      secure: item.secure === true,
      sameSite: typeof item.sameSite === 'string' ? item.sameSite : '',
    })
  }
  return { cookies, skipped: skippedRows, notes }
}

function parseNetscape(text) {
  const cookies = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const fields = line.split('\t')
    if (fields.length < 7) continue
    const [domain, , path, secure, expiration, name, ...rest] = fields
    cookies.push({
      name,
      value: rest.join('\t'),
      domain: domain.trim(),
      path: path || '/',
      expires: Number(expiration) > 0 ? Number(expiration) : 0,
      httpOnly: false,
      secure: /^TRUE$/i.test(secure),
      sameSite: '',
    })
  }
  return { cookies, skipped: cookies.length ? [] : [skipped('no cookies in that file')], notes: [] }
}

export function parseCookieExport(text) {
  const raw = String(text ?? '').replace(/^\uFEFF/, '').trim()
  if (!raw) return { cookies: [], skipped: [skipped('empty file')], notes: [] }
  if (raw.startsWith('{') || raw.startsWith('[')) {
    let data
    try { data = JSON.parse(raw) } catch { return { cookies: [], skipped: [skipped('invalid JSON')], notes: [] } }
    const list = Array.isArray(data) ? data : Array.isArray(data?.cookies) ? data.cookies : null
    if (!list) return { cookies: [], skipped: [skipped('not a cookie JSON or Playwright storageState')], notes: [] }
    const notes = Array.isArray(data?.origins) && data.origins.some((origin) => (origin?.localStorage || []).length > 0)
      ? ['local-storage-left']
      : []
    return normalizeList(list, notes)
  }
  return parseNetscape(raw)
}

export function cookiePreview(parsed, label) {
  const sites = new Map()
  for (const cookie of parsed.cookies) {
    const site = cookie.domain.replace(/^\./, '')
    const row = sites.get(site) || { site, cookies: 0, session: 0 }
    row.cookies += 1
    if (!cookie.expires) row.session += 1
    sites.set(site, row)
  }
  return {
    cookies: parsed.cookies.length,
    source: { label: label || 'file' },
    sites: [...sites.values()],
    skipped: parsed.skipped,
    warnings: [],
    notes: parsed.notes || [],
  }
}

export function cookiesForHosts(cookies, hosts) {
  const kept = []
  const dropped = []
  const allowed = Array.isArray(hosts) ? hosts : []
  for (const cookie of cookies) {
    const domain = cookie.domain.replace(/^\./, '').toLowerCase()
    const ok = allowed.some((host) => domain === host || domain.endsWith(`.${host}`))
    if (ok) kept.push(cookie)
    else dropped.push({ name: cookie.name, reason: 'not this account' })
  }
  return { kept, dropped }
}
