'use client'
import { useEffect, useRef, useState } from 'react'

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY || ''
const api = (p, init) => fetch(GATEWAY + p, { credentials: 'include', ...init })

/** Ensure the DSH cookie exists by loading the desk once in a hidden frame. */
function warmDesk(redirect) {
  return new Promise((resolve) => {
    const frame = document.createElement('iframe')
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0;opacity:0;pointer-events:none'
    frame.src = GATEWAY + redirect
    frame.onload = () => setTimeout(() => { frame.remove(); resolve() }, 300)
    document.body.appendChild(frame)
    setTimeout(() => { frame.remove(); resolve() }, 4000)
  })
}

export default function Page() {
  const [view, setView] = useState('boot')
  const [devices, setDevices] = useState([])
  const [dev, setDev] = useState('')
  const [bots, setBots] = useState([])
  const [active, setActive] = useState(null)
  const [items, setItems] = useState([])
  const [text, setText] = useState('')
  const [err, setErr] = useState('')
  const [sending, setSending] = useState(false)
  const bottom = useRef(null)

  const botApi = async (endpoint, payload) => {
    const r = await api(`/desk/${dev}/api/bot`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint, payload }),
    })
    if (r.status === 401) throw new Error('unauthorized')
    return await r.json()
  }

  async function loadDevices() {
    const r = await api('/botcamp/api/relay/devices')
    if (r.status === 401) { location.href = '/botcamp/relay'; return }
    const d = await r.json()
    setDevices(d.devices || [])
    setView('devices')
  }

  async function connect(slot) {
    setErr('')
    const r = await api('/botcamp/api/relay/go', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dev: slot }),
    })
    const d = await r.json()
    if (!r.ok) { setErr(d.error || '连接失败'); return }
    setDev(slot)
    setView('loading')
    await warmDesk(d.redirect)
    try {
      const state = await botApi('state')
      const list = (state.value?.bots || []).map((b) => ({ id: b.id, name: b.name, blurb: b.blurb }))
      setBots(list)
      setView('bots')
    } catch {
      setErr('无法进入团队，请重试')
      setView('devices')
    }
  }

  async function openBot(bot) {
    setActive(bot); setView('chat'); setItems([])
    await refresh(bot)
  }

  async function refresh(bot = active) {
    if (!bot) return
    try {
      const r = await botApi('chat', { botId: bot.id })
      const list = (r.value?.items || []).filter((m) => m.kind === 'user' || m.kind === 'bot')
      setItems(list)
      setTimeout(() => bottom.current?.scrollIntoView({ behavior: 'smooth' }), 30)
    } catch { /* keep current */ }
  }

  async function send() {
    const value = text.trim()
    if (!value || !active || sending) return
    setSending(true); setText('')
    try {
      await botApi('send', { sessionId: active.id, text: value })
      setItems((prev) => [...prev, { kind: 'user', text: value }])
      setTimeout(() => bottom.current?.scrollIntoView(), 30)
      for (let i = 0; i < 40; i += 1) {
        await new Promise((r) => setTimeout(r, 1500))
        const r = await botApi('chat', { botId: active.id })
        const list = (r.value?.items || []).filter((m) => m.kind === 'user' || m.kind === 'bot')
        setItems(list)
        if (list.length && list[list.length - 1]?.kind === 'bot' && list.length >= items.length + 2) break
      }
      setTimeout(() => bottom.current?.scrollIntoView({ behavior: 'smooth' }), 60)
    } catch (e) {
      setErr(e.message === 'unauthorized' ? '会话已失效，请重新连接' : '发送失败')
    } finally { setSending(false) }
  }

  useEffect(() => { loadDevices() }, [])

  if (view === 'boot') return <div className="center"><span className="muted">加载中…</span></div>
  if (view === 'loading') return <div className="center"><span className="muted">正在连接设备…</span></div>

  if (view === 'devices') {
    return (
      <main className="pad">
        <h1>我的设备</h1>
        <p className="muted small">登录过 BotCamp 客户端的电脑</p>
        {devices.length === 0 && <p className="muted">还没有设备。先在电脑上打开 BotCamp 客户端并登录。</p>}
        {devices.map((d) => (
          <button key={d.slot} className="card row" onClick={() => d.online && connect(d.slot)} disabled={!d.online}>
            <span className={d.online ? 'dot on' : 'dot'} />
            <span className="grow left">
              <span>{d.name || d.slot}</span>
              <span className="muted small">{d.platform} · {d.online ? '在线' : '离线'} · {d.last_seen}</span>
            </span>
            <span className="chip">{d.online ? '连接' : '离线'}</span>
          </button>
        ))}
        {err && <p className="error">{err}</p>}
      </main>
    )
  }

  if (view === 'bots') {
    return (
      <main className="pad">
        <header className="head"><h1>团队</h1><button className="link" onClick={loadDevices}>切换设备</button></header>
        {bots.length === 0 && <p className="muted">这个设备上还没有 bot。</p>}
        {bots.map((b) => (
          <button key={b.id} className="card row" onClick={() => openBot(b)}>
            <span className="avatar">{(b.name || '?').slice(0, 1)}</span>
            <span className="grow left"><span>{b.name}</span><span className="muted small">{b.blurb || '　'}</span></span>
            <span className="chev">›</span>
          </button>
        ))}
        {err && <p className="error">{err}</p>}
      </main>
    )
  }

  return (
    <main className="chat">
      <header className="head sticky">
        <button className="link" onClick={() => { setView('bots'); setActive(null) }}>‹</button>
        <h1>{active?.name}</h1>
        <span style={{ width: 32 }} />
      </header>
      <div className="messages">
        {items.map((m, i) => (
          <div key={i} className={m.kind === 'user' ? 'bubble me' : 'bubble them'}>{m.text}</div>
        ))}
        {sending && <div className="bubble them typing">正在输入…</div>}
        <div ref={bottom} />
      </div>
      {err && <p className="error pad0">{err}</p>}
      <footer className="composer">
        <textarea rows={1} value={text} placeholder="说点什么…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }} />
        <button onClick={send} disabled={sending || !text.trim()}>发送</button>
      </footer>
    </main>
  )
}
