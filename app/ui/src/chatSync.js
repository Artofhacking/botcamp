// The live feed on Demox closes after its first event, then reconnects and sends
// `hello`. That refresh must not look like a request for older history, and a
// message already in the page must not stay as a second optimistic bubble.

export function visiblePending(pending, items) {
  const pool = (items ?? []).filter(item => item?.kind === 'user')
  const used = new Set()
  const left = []
  for (const entry of pending ?? []) {
    const at = pool.findIndex((item, index) => !used.has(index) && item.text === entry.text)
    if (at < 0) left.push(entry)
    else used.add(at)
  }
  return left
}

// A feed event belongs to this open conversation when its bot and session are
// the bot, the part on screen, or the page the host just returned. A user
// event for some other session must not retire the optimistic bubble.
export function acceptFeedItem(data, thread) {
  const ids = new Set([thread?.botId, thread?.part, thread?.sessionId].filter(id => typeof id === 'string' && id))
  if (!data?.item || ids.size === 0 || !ids.has(data.botId)) return false
  if (typeof data.sessionId === 'string' && !ids.has(data.sessionId)) return false
  return true
}

// 'loading' is only for a page of older messages. A refresh of the latest page
// keeps the current banner (older pages stay available, a failed refresh does not).
export function earlierBanner({ loadingEarlier, failed, cursor }) {
  if (loadingEarlier) return 'loading'
  if (failed) return 'failed'
  if (cursor) return 'more'
  return 'none'
}
