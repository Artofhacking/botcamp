/** One 主编 send, including browser and workspace tools on this machine. */

import { allowedHosts } from './policy.ts'
import type { LedgerResult } from './ledger.ts'

export interface ChiefLine {
  readonly kind: 'user' | 'bot'
  readonly text: string
}

export interface ChiefTool {
  readonly tool: string
  readonly url: string
  readonly path: string
  readonly hosts: readonly string[]
}

export class ChiefTurnError extends Error {
  readonly status: number
  readonly reachedLedger: boolean

  constructor(message: string, status: number, reachedLedger: boolean) {
    super(message)
    this.name = 'ChiefTurnError'
    this.status = status
    this.reachedLedger = reachedLedger
  }
}

const STEPS = 3
const STOP = '本机工具已经用过了。请根据已有结果直接回答，不要再要工具。'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function lineFrom(item: unknown): ChiefLine | null {
  if (!isRecord(item) || typeof item.text !== 'string' || item.text.length === 0) return null
  return { kind: item.kind === 'user' ? 'user' : 'bot', text: item.text }
}

/**
 * Keep the lines already on screen unless the ledger actually returned a page.
 * A missed refresh must not wipe the conversation.
 */
export function transcriptFromLedger(previous: readonly ChiefLine[], result: LedgerResult): ChiefLine[] {
  if (result.status === 401) return [...previous]
  const items = result.data.value?.items
  if (!Array.isArray(items)) return [...previous]
  const lines: ChiefLine[] = []
  for (const item of items) {
    const line = lineFrom(item)
    if (line) lines.push(line)
  }
  return lines
}

function toolFrom(result: LedgerResult): ChiefTool | null {
  const value = result.data.value
  if (!isRecord(value) || !isRecord(value.tool) || typeof value.tool.tool !== 'string') return null
  return {
    tool: value.tool.tool,
    url: typeof value.tool.url === 'string' ? value.tool.url : '',
    path: typeof value.tool.path === 'string' ? value.tool.path : '',
    hosts: allowedHosts(value.tool.hosts),
  }
}

function assertAccepted(result: LedgerResult): void {
  if (result.status === 401) throw new ChiefTurnError('需要登录', 401, true)
  if (result.data.ok === false) {
    const message = result.data.error?.message
    throw new ChiefTurnError(
      typeof message === 'string' && message ? message : '模型这次没有答上来。',
      result.status,
      true,
    )
  }
  if (result.status < 200 || result.status >= 300) {
    throw new ChiefTurnError('账本暂时没有连上。', result.status, true)
  }
}

/** Ask 主编. Tool JSON is run here and is not stored by this function. */
export async function sendChiefTurn(options: {
  text: string
  ledger: (payload: Record<string, unknown>) => Promise<LedgerResult>
  runTool: (tool: ChiefTool) => Promise<string>
}): Promise<void> {
  const text = options.text.trim()
  if (!text) throw new ChiefTurnError('写一句再发送。', 0, false)
  let payload: Record<string, unknown> = {
    sessionId: 'co_chief',
    botId: 'co_chief',
    text,
    desktop: true,
  }
  for (let step = 0; step < STEPS; step += 1) {
    const result = await options.ledger(payload)
    const tool = toolFrom(result)
    if (!tool) {
      assertAccepted(result)
      return
    }
    const observed = String(await options.runTool(tool)).slice(0, 6000)
    payload = {
      sessionId: 'co_chief',
      botId: 'co_chief',
      text,
      desktop: true,
      resume: true,
      toolResult: { text: observed },
    }
  }
  const last = await options.ledger({
    ...payload,
    resume: true,
    toolResult: { text: STOP },
  })
  if (toolFrom(last)) throw new ChiefTurnError('模型这次没有答上来。', last.status, true)
  assertAccepted(last)
}
