import { createElement as h, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { call } from '../../../ds-bot/src/client/api.js'
import { Bubbles, ChatRows, Shimmer } from '../../../ds-bot/src/client/cells.js'
import { noteMediaEntity } from './account.js'
import { acceptFeedItem, earlierBanner, visiblePending } from './chatSync.js'
import { ComposerPlus, ComposerVoice } from '../../../ds-bot/src/client/composer.js'
import { t } from '../../../ds-bot/src/client/i18n.js'
import { ArrowUpIcon } from '../../../ds-bot/src/client/icons.js'
import { ModelChoiceDock } from '../../../ds-bot/src/client/model-menu.js'
import { PendingQuestion } from '../../../ds-bot/src/client/questions.js'

// The chat follows its end while the user is this close to it.
const FOLLOW_PX = 80
const sameItem = (a, b) => a.kind === b.kind && a.time === b.time && a.text === b.text

// A Bot's own chat: pages from the `chat` endpoint, new entries and the reply being
// written from the feed. Entries that arrive while the first page loads wait for it.
function useChat(botId, part, feed) {
  const [view, setView] = useState({ sessionId: null, items: [], cursor: null, loading: botId !== undefined, loadingEarlier: false, failed: false })
  const [stream, setStream] = useState(null)
  const [pending, setPending] = useState([])
  const ready = useRef(false)
  const early = useRef([])
  const busy = useRef(false)
  const keep = useRef(null)

  const load = useCallback(async (cursor, scroller) => {
    if (busy.current || botId === undefined) return
    busy.current = true
    const older = cursor !== undefined
    if (!older) ready.current = false
    // Refreshing the latest page stays quiet. Only scrolling up shows the earlier-message line.
    if (older) setView(current => ({ ...current, loading: true, loadingEarlier: true, failed: false }))
    try {
      const page = await call('chat', { botId, ...(cursor ? { cursor } : {}) })
      if (!older) {
        const thread = { botId, part, sessionId: page.sessionId }
        const later = early.current.filter(entry => acceptFeedItem(entry, thread) && !page.items.some(item => sameItem(item, entry.item)))
        early.current = []
        ready.current = true
        const items = [...page.items, ...later.map(entry => entry.item)]
        setView({ sessionId: page.sessionId, items, cursor: page.cursor, loading: false, loadingEarlier: false, failed: false })
        setPending(list => visiblePending(list, items))
      } else {
        // Content added above the viewport would push the view down; keep its distance from the end.
        if (scroller) keep.current = scroller.scrollHeight - scroller.scrollTop
        setView(current => ({ ...current, items: [...page.items, ...current.items], cursor: page.cursor, loading: false, loadingEarlier: false }))
      }
    } catch {
      ready.current = older || ready.current
      setView(current => ({ ...current, loading: false, loadingEarlier: false, failed: older ? true : current.failed }))
    } finally {
      busy.current = false
    }
  }, [botId, part])

  // A new part starts the chat over.
  useEffect(() => { void load(undefined) }, [load, part])

  useEffect(() => feed.on((event, data) => {
    // The feed came back after a break: entries may have been missed.
    if (event === 'hello') { if (ready.current) void load(undefined); return }
    if (botId === undefined) return
    if (event === 'message') {
      if (!data?.item) return
      const thread = { botId, part, sessionId: part }
      if (!ready.current) {
        if (acceptFeedItem(data, thread)) early.current.push(data)
        return
      }
      let accepted = false
      setView(current => {
        const here = { botId, part, sessionId: current.sessionId || part }
        if (!acceptFeedItem(data, here)) return current
        accepted = true
        if (current.items.some(item => sameItem(item, data.item))) return current
        return { ...current, items: [...current.items, data.item] }
      })
      if (!accepted) return
      if (data.item.kind === 'user') setPending(list => visiblePending(list, [data.item]))
      if (data.item.kind === 'bot') setStream(null)
    } else if (data?.botId !== botId && data?.botId !== part) {
      return
    } else if (event === 'stream') {
      if (data.phase === 'start') setStream({ attemptId: data.attemptId, text: '' })
      else if (data.phase === 'end') setStream(current => (current?.attemptId === data.attemptId ? null : current))
      else setStream(current => (current?.attemptId === data.attemptId ? { ...current, text: current.text + data.text } : current))
    }
  }), [feed, botId, part, load])

  // Shown at once: the message can come back on the feed before the request returns.
  const send = async (text, actions, sessionId) => {
    const entry = { kind: 'user', text, time: Date.now() }
    setPending(list => [...list, entry])
    actions.noteSent(sessionId)
    try {
      await actions.send(sessionId, text)
    } catch (error) {
      setPending(list => list.filter(item => item !== entry))
      throw error
    }
    // The host has the line now. Reload so the bubble is the stored one, and
    // keep the optimistic copy if that reload has not caught up yet.
    await load()
  }
  return { view, stream, pending, load, send, keep }
}

// What the Bot views' voice button asks of a composer (DSH's composer in the plugin):
// where the caret is, and text put in there.
function useInput(field, setText) {
  return useMemo(() => ({
    captureInsertion: () => (field.current ? { start: field.current.selectionStart, end: field.current.selectionEnd } : null),
    insertText: (value, at) => setText((current) => {
      const start = Math.min(at?.start ?? current.length, current.length)
      return current.slice(0, start) + value + current.slice(Math.max(start, at?.end ?? start))
    }),
  }), [field, setText])
}

function Composer({ sessionId, placeholder, disabled, onSend, actions, useUi, useRoster }) {
  const [text, setText] = useState('')
  const [error, setError] = useState(null)
  const field = useRef(null)
  const inputActions = useInput(field, setText)
  useLayoutEffect(() => {
    const node = field.current
    node.style.height = 'auto'
    node.style.height = `${node.scrollHeight}px`
  }, [text])
  useEffect(() => { if (!disabled) field.current?.focus() }, [sessionId, disabled])
  const submit = async () => {
    const value = text.trim()
    if (value === '' || disabled) return
    setError(null)
    setText('')
    try {
      await onSend(value)
    } catch (failure) {
      setText(current => (current === '' ? value : current))
      setError(failure.message)
    }
  }
  return h('div', { className: 'dsb-composer-wrap' },
    error ? h('p', { className: 'dsb-composer-error', role: 'alert' }, error) : null,
    h('div', { className: 'dsb-composer', 'data-composer-card': '', 'data-multiline': text.includes('\n') || undefined },
      h('div', { className: 'dsb-composer-tools' }, h(ComposerPlus, { sessionId, inputActions, useRoster, actions })),
      h('div', { className: 'dsb-composer-input', 'data-input-scroll': '' },
        h('textarea', {
          ref: field,
          rows: 1,
          value: text,
          disabled,
          placeholder,
          'aria-label': placeholder,
          'data-composer-input': '',
          onChange: event => setText(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void submit()
            }
          },
        })),
      h('div', { className: 'dsb-composer-trailing' },
        h(ComposerVoice, { sessionId, inputActions, actions, useUi }),
        h('button', { type: 'button', className: 'dsb-send', disabled: disabled || text.trim() === '', 'aria-label': t('Send message'), title: t('Send message'), onClick: () => { void submit() } }, h(ArrowUpIcon)))))
}

// One conversation in the main view, drawn with the Bot views' own rows, cards and docks.
// `anchor` / `workspace` bind the 主编 chat to the left workbench SoT.
export function Chat({ sessionId, team, anchor, onClearAnchor, workspace, onWorkbenchWrite }) {
  const { actions, hooks, chat: feed } = team
  const roster = hooks.useRoster(value => value)
  const bot = roster.byId[sessionId]
  const name = bot?.name ?? roster.roomsById[sessionId]?.name ?? ''
  // A project room is not a bot row. Its chat id is the room id itself.
  const chatId = bot?.id ?? (typeof sessionId === 'string' && sessionId.startsWith('co_') ? sessionId : undefined)
  const { view, stream, pending, load, send, keep } = useChat(chatId, sessionId, feed)
  const scroller = useRef(null)
  const follow = useRef(true)
  const question = roster.questions?.[sessionId]
  const running = hooks.useSessionStatus(map => map.get(sessionId)?.running === true)

  useLayoutEffect(() => {
    const node = scroller.current
    if (keep.current !== null) {
      node.scrollTop = node.scrollHeight - keep.current
      keep.current = null
    } else if (follow.current) node.scrollTop = node.scrollHeight
  }, [view.items, stream, pending, running, question])

  const onScroll = () => {
    const node = scroller.current
    follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < FOLLOW_PX
  }
  const banner = earlierBanner(view)
  const outgoing = visiblePending(pending, view.items)
  const earlier = banner === 'loading' ? h(Shimmer, null, t('Loading earlier messages…'))
    : banner === 'failed' ? h('button', { type: 'button', className: 'bt-soft', onClick: () => load(view.cursor ?? undefined, scroller.current) }, t('Couldn’t load earlier messages · Retry'))
      : banner === 'more' ? h('button', { type: 'button', className: 'bt-soft', onClick: () => load(view.cursor, scroller.current) }, t('Load earlier')) : null
  const waiting = bot?.waiting === true

  const sendBound = async (text) => {
    const account = workspace?.account
    const prefix = anchor && account
      ? `【锚定工作台 · ${anchor.kind} · ${anchor.title} · ${account.display_name}】\n`
      : account
        ? `【当前号 · ${account.display_name} · ${account.platform}】\n`
        : ''
    const outbound = prefix + text
    await send(outbound, actions, sessionId)
    // Persist into workbench SoT so left pane stays the authority.
    if (account) {
      try {
        await noteMediaEntity({
          accountId: account.id,
          kind: anchor?.kind === 'post' ? 'post' : 'event',
          entityId: anchor?.kind === 'post' ? anchor.id : undefined,
          title: anchor?.title || null,
          text,
        })
        onWorkbenchWrite?.()
      } catch {
        // Chat already sent; workbench write failure should not block the turn.
      }
    }
  }

  return h('div', { className: 'dsb-chat' },
    anchor ? h('div', { className: 'dsb-anchor-bar' },
      h('span', null, `锚定：${anchor.kind} · ${anchor.title}`),
      h('button', { type: 'button', onClick: onClearAnchor }, '取消')) : null,
    h('div', { ref: scroller, className: 'dsb-scroll', 'data-conversation-scroll': '', onScroll },
      h('div', { className: 'dsb-column' },
        earlier ? h('div', { className: 'bt-earlier-top' }, earlier) : null,
        h('div', { className: 'dsb-flow', 'data-chat-flow': '', role: 'feed', 'aria-label': name, 'aria-busy': view.loading },
          h(ChatRows, { items: view.items, sessionId, roster, actions, useUi: hooks.useUi, clock: true }),
          outgoing.length ? h('div', { className: 'dsb-pending' }, h(ChatRows, { items: outgoing, sessionId, roster, actions })) : null,
          stream?.text ? h(Bubbles, { texts: [stream.text], roster, selfId: bot?.id, actions, streaming: true, sessionId }) : null,
          h('div', { 'data-chat-running': '' }),
          question ? h(PendingQuestion, { key: JSON.stringify([sessionId, question.id]), sessionId, question, actions, inline: true }) : null))),
    h('div', { className: 'dsb-composer-root' },
      typeof sessionId === 'string' && sessionId.startsWith('co_')
        ? null
        : h(ModelChoiceDock, { sessionId, useRoster: hooks.useRoster, actions }),
      h(Composer, {
        sessionId,
        disabled: waiting,
        placeholder: waiting ? t('Pick a model and {name} can start.', { name }) : name ? t('Message {name}', { name }) : t('Message'),
        onSend: sendBound,
        actions,
        useUi: hooks.useUi,
        useRoster: hooks.useRoster,
      })))
}
