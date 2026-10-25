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
    throw Object.assign(new Error(data.error?.message ?? '白板请求失败'), { status: response.status })
  }
  return data
}

export const listBoards = () => send('whiteboard/list')
export const getBoard = (payload) => send('whiteboard/get', payload)
export const createBoard = (payload) => send('whiteboard/create', payload)
export const updateBoard = (payload) => send('whiteboard/update', payload)
export const upsertObjects = (payload) => send('whiteboard/objects/upsert', payload)
export const archiveObjects = (payload) => send('whiteboard/objects/archive', payload)
export const restoreObjects = (payload) => send('whiteboard/objects/restore', payload)
export const listWarehouse = () => send('whiteboard/warehouse')
export const placeOnBoard = (payload) => send('whiteboard/place', payload)

export function parseBoardHref(href) {
  if (typeof href !== 'string' || !href.startsWith('board://')) return null
  const rest = href.slice('board://'.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) return { boardId: rest, objectId: null }
  return { boardId: rest.slice(0, slash), objectId: rest.slice(slash + 1) || null }
}
