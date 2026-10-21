import { describe, expect, it, vi } from 'vitest'
import { callRemote, KernelError, messagesFromPage, sessionTitle } from './kernel'

describe('callRemote', () => {
  it('posts the typert envelope and returns the value', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      type: 'server-response',
      result: { ok: true, value: { items: [] } },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const value = await callRemote<{ items: unknown[] }>('session/list', { _request: {} }, fetchImpl)
    expect(value.items).toEqual([])
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/session/list')
    const body = JSON.parse(String(init.body))
    expect(body).toMatchObject({
      type: 'client-request',
      method: 'session/list',
      payload: { args: { _request: {} } },
    })
  })

  it('raises the kernel error message', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      result: { ok: false, error: { code: 'gateway/arguments-invalid', message: 'missing request' } },
    }), { status: 200 }))
    await expect(callRemote('session/create', {}, fetchImpl)).rejects.toBeInstanceOf(KernelError)
  })
})

describe('messagesFromPage', () => {
  it('keeps the human turn and the assistant text, skipping runtime context', () => {
    const messages = messagesFromPage([
      { event: { type: 'user/message', seq: 8, data: { content: [{ type: 'text', text: '只回复一个字：好' }], source: { kind: 'user' } } } },
      { event: { type: 'user/message', seq: 9, data: { content: [{ type: 'text', text: 'Current runtime context' }] } } },
      { event: { type: 'assistant/message', seq: 17, data: { message: { content: [{ type: 'reasoning', text: '' }, { type: 'text', text: '好' }] } } } },
      { event: { type: 'system/message', seq: 7, data: { message: { content: [{ type: 'text', text: 'system' }] } } } },
    ])
    expect(messages).toEqual([
      { id: 'u-8', role: 'user', text: '只回复一个字：好' },
      { id: 'a-17', role: 'assistant', text: '好' },
    ])
  })
})

describe('sessionTitle', () => {
  it('prefers the projection title', () => {
    expect(sessionTitle({
      sessionId: 's',
      updatedAt: 1,
      running: false,
      blank: false,
      projections: { values: { title: '好' } },
    })).toBe('好')
  })
})
