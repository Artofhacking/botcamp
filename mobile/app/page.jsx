'use client'
import { useEffect, useState } from 'react'

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY || 'https://camp.aigc.sx.cn'

export default function Home() {
  const [devices, setDevices] = useState(null)
  const [err, setErr] = useState('')

  async function load() {
    const r = await fetch(`${GATEWAY}/botcamp/api/relay/devices`, { credentials: 'include' })
    if (r.status === 401) { location.href = `${GATEWAY}/botcamp/relay`; return }
    const d = await r.json()
    setDevices(d.devices || [])
  }
  useEffect(() => { load() }, [])

  async function connect(slot) {
    const r = await fetch(`${GATEWAY}/botcamp/api/relay/go`, {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dev: slot }),
    })
    const d = await r.json()
    if (!r.ok) { setErr(d.error || '连接失败'); return }
    location.href = `${GATEWAY}${d.redirect}`
  }

  return (
    <main style={{ padding: '28px 16px', maxWidth: 460, margin: '0 auto' }}>
      <h1 style={{ fontSize: 18, margin: '0 0 4px' }}>我的设备</h1>
      <p style={{ color: '#8b8b98', fontSize: 13, margin: '0 0 20px' }}>登录过 BotCamp 客户端的电脑</p>
      {devices === null && <p style={{ color: '#8b8b98' }}>加载中…</p>}
      {devices?.length === 0 && <p style={{ color: '#8b8b98' }}>还没有设备。先在电脑上安装并登录 BotCamp 客户端。</p>}
      {devices?.map(d => (
        <div key={d.slot} style={{ display: 'flex', alignItems: 'center', gap: 12, border: '1px solid #26262e', background: '#141418', borderRadius: 12, padding: '14px 16px', marginBottom: 10 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: d.online ? '#3fbf7f' : '#555' }} />
          <div style={{ flex: 1 }}>
            <div>{d.name || d.slot}</div>
            <div style={{ color: '#8b8b98', fontSize: 12 }}>{d.platform} · {d.online ? '在线' : '离线'} · {d.last_seen}</div>
          </div>
          <button disabled={!d.online} onClick={() => connect(d.slot)}
            style={{ border: 0, borderRadius: 9, padding: '9px 14px', background: d.online ? '#6c8cff' : '#2a2a33', color: d.online ? '#fff' : '#777', fontSize: 15 }}>
            连接
          </button>
        </div>
      ))}
      {err && <p style={{ color: '#e5574f', fontSize: 13 }}>{err}</p>}
    </main>
  )
}
