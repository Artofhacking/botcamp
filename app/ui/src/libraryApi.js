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
    throw Object.assign(new Error(data.error?.message ?? '文档请求失败'), { status: response.status })
  }
  return data
}

export const listLibrary = () => send('library/list')
export const getLibraryNode = (id) => send('library/get', { id })
export const createLibraryNode = (payload) => send('library/create', payload)
export const updateLibraryNode = (payload) => send('library/update', payload)
export const deleteLibraryNode = (id) => send('library/delete', { id })

export function uploadLibraryAsset(file) {
  const contentType = file?.contentType || ''
  const data = file?.data || ''
  return send('library/asset', { contentType, data })
}

export function parseDocHref(href) {
  if (typeof href !== 'string' || !href.startsWith('doc://')) return null
  const id = href.slice('doc://'.length).split(/[?#]/)[0]
  if (!/^doc_[a-f0-9]+$/.test(id)) return null
  return id
}
