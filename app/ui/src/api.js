// The window talks only to ds-bot's own channel in the engine: POST api/bot for reads and
// actions (the Bot views' own `call`), and the live feed api/bot/feed for what changes.
const RETRY_MS = [500, 1000, 2000, 5000]
// The Demox function closes the feed after the first event. Reconnecting at once
// would hammer it, so a stream that ends on its own within a few seconds waits.
const QUIET_MS = 5000
const IMMEDIATE_MS = 3500

export function feedRetryDelay(elapsedMs, ended, failures) {
  if (ended && elapsedMs < IMMEDIATE_MS) return QUIET_MS
  return RETRY_MS[Math.min(failures, RETRY_MS.length - 1)]
}

function parseEvent(block) {
  let event = 'message'
  const data = []
  for (const line of block.split('\n')) {
    if (line.startsWith('event: ')) event = line.slice(7)
    else if (line.startsWith('data: ')) data.push(line.slice(6))
  }
  if (data.length === 0) return undefined
  try { return { event, data: JSON.parse(data.join('\n')) } } catch { return undefined }
}

// Read over fetch: EventSource does not load from the window's own scheme. After a
// break the feed reconnects, and its first event (`hello`) tells the window to catch up.
export function openFeed(onEvent) {
  let stopped = false
  let controller
  const run = async () => {
    for (let failures = 0; !stopped;) {
      controller = new AbortController()
      const openedAt = Date.now()
      let ended = false
      try {
        const response = await fetch('api/bot/feed', { signal: controller.signal, cache: 'no-store', credentials: 'same-origin' })
        if (response.status === 401) {
          stopped = true
          onEvent('lost', {})
          return
        }
        if (!response.ok || response.body === null) throw new Error(`HTTP ${response.status}`)
        failures = 0
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
            const parsed = parseEvent(buffer.slice(0, end))
            buffer = buffer.slice(end + 2)
            if (parsed !== undefined) onEvent(parsed.event, parsed.data)
          }
        }
        ended = true
      } catch {
        // The engine restarted or the window is going away; the loop decides.
      }
      if (stopped) return
      onEvent('lost', {})
      const elapsed = Date.now() - openedAt
      const immediate = ended && elapsed < IMMEDIATE_MS
      const wait = feedRetryDelay(elapsed, ended, failures)
      await new Promise(resolve => setTimeout(resolve, wait))
      if (!immediate) failures += 1
    }
  }
  void run()
  return () => {
    stopped = true
    controller?.abort()
  }
}
