export interface SessionSummary {
  sessionId: string
  updatedAt: number
  running: boolean
  blank: boolean
  cwd?: string
  projections?: {
    values?: {
      title?: string | null
    }
  }
}

export interface ModelSelection {
  provider: string
  model: string
}

export interface ModelCatalog {
  default: ModelSelection
  groups: Array<{
    id: string
    name: string
    models: Array<{ id: string; name: string }>
  }>
}

export interface SessionProjections {
  kind?: string
  asOfSeq?: number
  values?: {
    title?: string | null
  }
}

export interface HistoryRecord {
  type?: string
  event?: {
    type?: string
    seq?: number
    data?: unknown
  }
}

export interface SessionPage {
  records: HistoryRecord[]
  hasMore: boolean
}

export class KernelError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'KernelError'
    this.code = code
  }
}

interface ServerResponse {
  type?: string
  result?: {
    ok?: boolean
    value?: unknown
    error?: { code?: string; message?: string }
  }
}

export async function callRemote<T>(
  endpoint: string,
  args: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const response = await fetchImpl(`/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: crypto.randomUUID(),
      method: endpoint,
      payload: { args },
    }),
  })
  if (!response.ok) {
    throw new KernelError('transport', `内核返回 HTTP ${response.status}`)
  }
  const body = await response.json() as ServerResponse
  if (body.result?.ok === true) return body.result.value as T
  const code = body.result?.error?.code ?? 'kernel'
  const message = body.result?.error?.message ?? '内核拒绝了这次调用'
  throw new KernelError(code, message)
}

export function listSessions(): Promise<{ items: SessionSummary[] }> {
  return callRemote('session/list', { _request: {} })
}

export function modelCatalog(): Promise<ModelCatalog> {
  return callRemote('session/modelCatalog', {})
}

export function createSession(): Promise<{ sessionId: string; agentPreset?: string }> {
  return callRemote('session/create', { request: {} })
}

export function promptSession(sessionId: string, text: string): Promise<{ accepted: true }> {
  return callRemote('session/prompt', {
    request: {
      requestId: crypto.randomUUID(),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
    },
  })
}

export function sessionProjections(sessionId: string): Promise<SessionProjections> {
  return callRemote('session/projections', { request: { sessionId } })
}

export function sessionPage(sessionId: string, throughSeq: number): Promise<SessionPage> {
  return callRemote('session/page', {
    request: {
      address: { kind: 'session', sessionId },
      throughSeq,
      maxMessages: 80,
    },
  })
}

export interface TranscriptMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
}

function textParts(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((part): part is { type: string; text: string } => {
      return !!part && typeof part === 'object' && (part as { type?: string }).type === 'text'
        && typeof (part as { text?: string }).text === 'string'
    })
    .map(part => part.text.trim())
    .filter(Boolean)
    .join('\n')
}

export function messagesFromPage(records: readonly HistoryRecord[]): TranscriptMessage[] {
  const messages: TranscriptMessage[] = []
  for (const record of records) {
    const event = record.event
    if (!event?.type) continue
    const data = event.data
    if (!data || typeof data !== 'object') continue
    const seq = event.seq ?? messages.length
    if (event.type === 'user/message') {
      const source = (data as { source?: { kind?: string } }).source
      if (source?.kind !== 'user') continue
      const text = textParts((data as { content?: unknown }).content)
      if (text) messages.push({ id: `u-${seq}`, role: 'user', text })
    }
    if (event.type === 'assistant/message') {
      const message = (data as { message?: { content?: unknown } }).message
      const text = textParts(message?.content)
      if (text) messages.push({ id: `a-${seq}`, role: 'assistant', text })
    }
  }
  return messages
}

export function sessionTitle(session: SessionSummary): string {
  const title = session.projections?.values?.title
  if (typeof title === 'string' && title.trim()) return title.trim()
  if (session.blank) return '新会话'
  return '未命名会话'
}
