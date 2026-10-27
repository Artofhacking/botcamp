/**
 * Company employees speak through DeepSeek official.
 * DeepSeek-V4.1-Flash is the model that completed a one-word reply.
 * The kernel bot that holds that model stays off the company roster.
 */

export const COMPANY_MODEL_REF = 'deepseek-official/deepseek-flash'
export const COMPANY_RELAY_NAME = 'botcamp-model'

export const COMPANY_MODELS = Object.freeze([
  Object.freeze({
    ref: COMPANY_MODEL_REF,
    provider: 'deepseek-official',
    providerName: 'DeepSeek',
    id: 'deepseek-flash',
    name: 'DeepSeek-V4.1-Flash',
    input: Object.freeze(['text', 'image']),
  }),
  Object.freeze({
    ref: 'deepseek-official/deepseek-v4-pro',
    provider: 'deepseek-official',
    providerName: 'DeepSeek',
    id: 'deepseek-v4-pro',
    name: 'DeepSeek-V4-Pro',
    input: Object.freeze(['text']),
  }),
])

const BUDGET_MS = 22_000
const KICKOFF_MS = 5_000
const GAP_MS = 400

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function itemText(item) {
  if (!item || typeof item !== 'object') return ''
  if (typeof item.text === 'string') return item.text
  if (typeof item.content === 'string') return item.content
  if (Array.isArray(item.content)) {
    return item.content.map(part => {
      if (typeof part === 'string') return part
      if (typeof part?.text === 'string') return part.text
      return ''
    }).join('')
  }
  return ''
}

function isUser(item) {
  const kind = item?.kind || item?.role
  return kind === 'user'
}

function isBot(item) {
  const kind = item?.kind || item?.role
  return kind === 'bot' || kind === 'assistant'
}

function pageItems(page) {
  if (Array.isArray(page)) return page
  if (Array.isArray(page?.items)) return page.items
  return []
}

/** Bot text that follows the user's own line. Earlier greetings stay out of the reply. */
export function modelReplyAfter(items, prompt) {
  if (!Array.isArray(items)) return ''
  const wanted = typeof prompt === 'string' ? prompt.trim() : ''
  if (!wanted) return ''
  let at = -1
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (isUser(items[i]) && itemText(items[i]).trim() === wanted) {
      at = i
      break
    }
  }
  if (at < 0) return ''
  const parts = []
  for (let i = at + 1; i < items.length; i += 1) {
    if (isUser(items[i])) break
    if (!isBot(items[i])) continue
    const text = itemText(items[i]).trim()
    if (text) parts.push(text)
  }
  return parts.join('\n').trim()
}

export function withoutRelayBots(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.bots)) return value
  const bots = value.bots.filter(bot => bot?.name !== COMPANY_RELAY_NAME)
  if (bots.length === value.bots.length) return value
  return { ...value, bots }
}

function unwrapBot(value) {
  if (!value || typeof value !== 'object') return null
  if (value.bot && typeof value.bot === 'object') return value.bot
  return value
}

async function findRelay(kernel) {
  const state = await kernel('state', { since: -1 })
  const bots = Array.isArray(state?.bots) ? state.bots : []
  return bots.find(bot => bot?.name === COMPANY_RELAY_NAME) ?? null
}

async function ensureRelay(kernel, brief) {
  let bot = await findRelay(kernel)
  let fresh = false
  if (!bot) {
    fresh = true
    try {
      bot = unwrapBot(await kernel('create-bot', {
        name: COMPANY_RELAY_NAME,
        brief,
        model: COMPANY_MODEL_REF,
        color: 'blue',
        avatar: { shape: 'star' },
      }))
    } catch (error) {
      if (error?.name === 'AbortError') throw error
      bot = await findRelay(kernel)
      fresh = false
    }
  }
  if (!bot || typeof bot !== 'object') throw new Error('no relay')
  const id = typeof bot.id === 'string' ? bot.id : ''
  const sessionId = typeof bot.sessionId === 'string' && bot.sessionId ? bot.sessionId : id
  if (!sessionId) throw new Error('no session')
  if (id && bot.model !== COMPANY_MODEL_REF) {
    try {
      await kernel('update-bot', { id, model: COMPANY_MODEL_REF })
    } catch (error) {
      if (error?.name === 'AbortError') throw error
    }
  }
  return { id, sessionId, fresh }
}

async function waitForKickoff(kernel, bot, until) {
  while (Date.now() < until) {
    try {
      const items = pageItems(await kernel('chat', { sessionId: bot.sessionId, botId: bot.id }))
      if (items.some(isBot)) return
    } catch (error) {
      if (error?.name === 'AbortError') throw error
    }
    await delay(GAP_MS)
  }
}

/**
 * kernel(endpoint, payload) returns the kernel value or throws.
 * It must not log the body. The reply is model text, or this throws.
 */
export async function askKernelModel(kernel, turn) {
  const text = typeof turn?.text === 'string' ? turn.text.trim() : ''
  if (!text) throw new Error('empty')
  const brief = typeof turn?.brief === 'string' ? turn.brief : ''
  const deadline = Date.now() + BUDGET_MS
  const bot = await ensureRelay(kernel, brief)
  if (bot.fresh) await waitForKickoff(kernel, bot, Math.min(deadline, Date.now() + KICKOFF_MS))
  let attempt = 0
  let sent = false
  while (Date.now() < deadline) {
    if (!sent) {
      if (attempt >= 3) break
      try {
        await kernel('send', { sessionId: bot.sessionId, text })
        sent = true
        attempt += 1
      } catch (error) {
        if (error?.name === 'AbortError') throw error
        attempt += 1
        if (attempt >= 3) throw error
        await delay(GAP_MS)
        continue
      }
    }
    const items = pageItems(await kernel('chat', { sessionId: bot.sessionId, botId: bot.id }))
    const reply = modelReplyAfter(items, text)
    if (reply) return reply
    const queued = items.some(item => isUser(item) && itemText(item).trim() === text)
    if (!queued && attempt < 3) sent = false
    await delay(GAP_MS)
  }
  throw new Error('no reply')
}
