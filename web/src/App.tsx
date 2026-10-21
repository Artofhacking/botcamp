import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  createSession,
  KernelError,
  listSessions,
  messagesFromPage,
  modelCatalog,
  promptSession,
  sessionPage,
  sessionProjections,
  sessionTitle,
  type ModelCatalog,
  type SessionSummary,
  type TranscriptMessage,
} from './kernel'

function formatTime(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return ''
  const millis = value < 1_000_000_000_000 ? value * 1000 : value
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(millis))
}

async function loadTranscript(sessionId: string): Promise<{ title: string | null; messages: TranscriptMessage[] }> {
  const projections = await sessionProjections(sessionId)
  const throughSeq = projections.asOfSeq ?? 0
  const page = await sessionPage(sessionId, throughSeq)
  return {
    title: typeof projections.values?.title === 'string' ? projections.values.title : null,
    messages: messagesFromPage(page.records ?? []),
  }
}

export function App() {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [messages, setMessages] = useState<TranscriptMessage[]>([])
  const [draft, setDraft] = useState('')
  const [booting, setBooting] = useState(true)
  const [busy, setBusy] = useState(false)
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const selectedRef = useRef<string | null>(null)
  const selected = sessions.find(session => session.sessionId === selectedId) ?? null
  const modelLabel = catalog
    ? `${catalog.default.model}`
    : '连接内核…'

  const refreshSessions = useCallback(async () => {
    const listed = await listSessions()
    const items = [...listed.items].sort((a, b) => b.updatedAt - a.updatedAt)
    setSessions(items)
    return items
  }, [])

  const openSession = useCallback(async (sessionId: string) => {
    const same = selectedRef.current === sessionId
    selectedRef.current = sessionId
    setSelectedId(sessionId)
    setLoadingId(sessionId)
    setError(null)
    if (!same) setMessages([])
    try {
      const transcript = await loadTranscript(sessionId)
      setMessages(transcript.messages)
      if (transcript.title) {
        setSessions(current => current.map(session => (
          session.sessionId === sessionId
            ? {
                ...session,
                projections: { ...session.projections, values: { ...session.projections?.values, title: transcript.title } },
              }
            : session
        )))
      }
    } catch (cause) {
      setMessages([])
      setError(cause instanceof Error ? cause.message : '无法打开会话')
    } finally {
      setLoadingId(current => (current === sessionId ? null : current))
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [listed, models] = await Promise.all([listSessions(), modelCatalog()])
        if (cancelled) return
        const items = [...listed.items].sort((a, b) => b.updatedAt - a.updatedAt)
        setSessions(items)
        setCatalog(models)
        setError(null)
        if (items[0]) await openSession(items[0].sessionId)
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : '无法连接内核')
      } finally {
        if (!cancelled) setBooting(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [openSession])

  useEffect(() => {
    if (!selected?.running) return undefined
    const timer = window.setInterval(() => {
      openSession(selected.sessionId).then(() => refreshSessions()).catch(() => undefined)
    }, 1500)
    return () => window.clearInterval(timer)
  }, [openSession, refreshSessions, selected?.running, selected?.sessionId])

  const placeholder = useMemo(() => {
    if (!selected) return '写一条消息，会在腾讯云上的 dsh 内核里新建会话'
    return '发给当前会话'
  }, [selected])

  async function send() {
    const text = draft.trim()
    if (!text || busy) return
    setBusy(true)
    setError(null)
    setDraft('')
    const optimistic: TranscriptMessage = { id: `local-${Date.now()}`, role: 'user', text }
    setMessages(current => [...current, optimistic])
    try {
      let sessionId = selectedRef.current
      if (!sessionId) {
        const created = await createSession()
        sessionId = created.sessionId
        selectedRef.current = sessionId
        setSelectedId(sessionId)
      }
      await promptSession(sessionId, text)
      await refreshSessions()
      const started = Date.now()
      let transcript = await loadTranscript(sessionId)
      while (Date.now() - started < 25_000) {
        const answered = transcript.messages.some(message => message.role === 'assistant' && message.text)
        const userCount = transcript.messages.filter(message => message.role === 'user' && message.text === text).length
        if (answered && userCount > 0 && transcript.messages.at(-1)?.role === 'assistant') break
        await new Promise(resolve => setTimeout(resolve, 1200))
        transcript = await loadTranscript(sessionId)
      }
      setMessages(transcript.messages)
      await refreshSessions()
      await openSession(sessionId)
    } catch (cause) {
      const message = cause instanceof KernelError ? cause.message : cause instanceof Error ? cause.message : '发送失败'
      setError(message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="mark" aria-hidden="true" />
          <div>
            <strong>BotCamp</strong>
            <em>纯前端 · dsh</em>
          </div>
        </div>
        <button
          className="new-session"
          type="button"
          onClick={() => {
            selectedRef.current = null
            setSelectedId(null)
            setLoadingId(null)
            setMessages([])
            setError(null)
          }}
        >
          新会话
        </button>
        <div className="session-list" role="list">
          {sessions.map(session => (
            <button
              key={session.sessionId}
              type="button"
              role="listitem"
              className={session.sessionId === selectedId ? 'session active' : 'session'}
              onClick={() => {
                void openSession(session.sessionId)
              }}
            >
              <span>{sessionTitle(session)}</span>
              <small>
                {session.running ? '进行中' : formatTime(session.updatedAt)}
              </small>
            </button>
          ))}
          {!booting && sessions.length === 0 && <p className="empty-side">还没有会话</p>}
        </div>
        <footer className="side-foot">
          <span className={catalog ? 'dot on' : 'dot'} />
          <div>
            <b>{catalog ? '内核已连接' : booting ? '正在连接' : '未连接'}</b>
            <small>camp.aigc.sx.cn</small>
          </div>
        </footer>
      </aside>
      <main className="stage">
        <header className="top">
          <div>
            <h1>{selected ? sessionTitle(selected) : '新会话'}</h1>
            <p>页面跑在前端，会话、模型和工具都在腾讯云上的 dsh 内核里执行。</p>
          </div>
          <span className="model">{modelLabel}</span>
        </header>
        {error && <div className="banner" role="alert">{error}</div>}
        <section className="transcript" aria-live="polite">
          {loadingId && messages.length === 0 && (
            <p className="loading">正在读取会话…</p>
          )}
          {!selected && messages.length === 0 && !busy && !loadingId && (
            <div className="hero">
              <h2>从这里跟内核说话</h2>
              <p>BotCamp 只负责界面。发送后的请求走同源 <code>/api</code>，由开发代理或 camp 上的 nginx 转到腾讯云里的 dsh。</p>
            </div>
          )}
          {selected && messages.length === 0 && !busy && !loadingId && (
            <p className="loading">这个会话还没有对话。</p>
          )}
          {messages.map(message => (
            <article key={message.id} className={`bubble ${message.role}`}>
              <span>{message.role === 'user' ? '你' : 'dsh'}</span>
              <p>{message.text}</p>
            </article>
          ))}
          {busy && <article className="bubble assistant pending"><span>dsh</span><p>正在等内核…</p></article>}
        </section>
        <form
          className="composer"
          onSubmit={event => {
            event.preventDefault()
            void send()
          }}
        >
          <textarea
            value={draft}
            placeholder={placeholder}
            rows={3}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void send()
              }
            }}
          />
          <button type="submit" disabled={busy || draft.trim().length === 0}>
            {busy ? '发送中' : '发送'}
          </button>
        </form>
      </main>
    </div>
  )
}
