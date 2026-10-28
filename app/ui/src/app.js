import { Component, createElement as h, Fragment, useEffect, useMemo, useState } from 'react'
import { me } from './account.js'
import { ErrorToast } from '../../../ds-bot/src/client/feedback.js'
import { HeaderPill } from '../../../ds-bot/src/client/header.js'
import { t } from '../../../ds-bot/src/client/i18n.js'
import { Overlays } from '../../../ds-bot/src/client/overlays.js'
import { BrandMark, TeamSidebar, YouAvatar } from '../../../ds-bot/src/client/sidebar.js'
import { allThemes, themeCss } from '../../../ds-bot/src/client/themes.js'
import { Chat } from './chat.js'
import { LibraryPanel } from './library.js'
import { parseDocHref } from './libraryApi.js'
import { landingSession } from './land.js'
import { createTeam } from './team.js'

function DocsFab({ open, onClick }) {
  if (open) return null
  return h('button', {
    type: 'button',
    className: 'lib-fab',
    onClick,
    title: '打开文档库',
  }, '文档库')
}

function useTheme(prefs) {
  useEffect(() => {
    const theme = allThemes()[prefs?.theme] ?? allThemes().deepseek
    const style = document.createElement('style')
    style.textContent = themeCss(theme, prefs?.accent)
    document.head.append(style)
    if (prefs?.motion) document.body.dataset.btMotion = prefs.motion
    else delete document.body.dataset.btMotion
    return () => { style.remove() }
  }, [prefs?.theme, prefs?.accent, prefs?.motion])
}

function useMobile() {
  const [mobile, setMobile] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 820px)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 820px)')
    const onChange = () => setMobile(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return mobile
}

class Contain extends Component {
  constructor(props) {
    super(props)
    this.state = { failed: false }
    this.failedAt = 0
  }

  static getDerivedStateFromError() { return { failed: true } }

  componentDidCatch(error) {
    this.props.onError(error)
    if (Date.now() - this.failedAt > 1000) this.setState({ failed: false })
    this.failedAt = Date.now()
  }

  render() { return this.state.failed ? null : this.props.children }
}

export function App({ user, onLogout, onAdmin, onPassword, onUser }) {
  const team = useMemo(createTeam, [])
  useEffect(() => team.start(), [team])
  useEffect(() => {
    if (!onUser) return undefined
    let stopped = false
    const tick = () => {
      me().then((next) => {
        if (stopped) return
        if (!next) { onLogout?.(); return }
        if (next.mustChangePassword || next.used !== user?.used || next.quota !== user?.quota || next.email !== user?.email || next.role !== user?.role) onUser(next)
      }).catch(() => {})
    }
    const timer = setInterval(tick, 20000)
    window.addEventListener('focus', tick)
    return () => {
      stopped = true
      clearInterval(timer)
      window.removeEventListener('focus', tick)
    }
  }, [onUser, onLogout, user?.used, user?.quota, user?.email, user?.role, user?.mustChangePassword])

  const mobile = useMobile()
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [docFocus, setDocFocus] = useState(null)
  const [color, setColor] = useState(() => (document.body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light'))
  const setScheme = (next) => {
    localStorage.setItem('botcamp-color', next)
    document.body.toggleAttribute('data-ds-dark-theme', next === 'dark')
    window.dispatchEvent(new Event('botcamp:color'))
    setColor(next)
  }

  const { hooks, actions } = team
  const views = { ...hooks, actions }
  const wide = hooks.useLayout(state => state.wide)
  const shown = hooks.useShown(id => id)
  const roster = hooks.useRoster(value => value)
  useTheme(hooks.useRoster(value => value.prefs))

  const detailsId = hooks.useUi(state => state.details)
  useEffect(() => {
    if (!roster?.ready) return
    const next = landingSession(roster, shown)
    if (next && next !== shown) actions.landOn(next)
  }, [roster, shown, actions])
  useEffect(() => {
    if (!roster?.ready || !detailsId) return
    if (roster.byId?.[detailsId] || roster.roomsById?.[detailsId]) return
    actions.closePanel()
  }, [roster, detailsId, actions])

  useEffect(() => {
    const onLink = (event) => {
      const href = event.detail?.href
      const id = parseDocHref(href)
      if (!id) return
      setDocFocus(id)
      setLibraryOpen(true)
    }
    window.addEventListener('botcamp:doc-link', onLink)
    return () => window.removeEventListener('botcamp:doc-link', onLink)
  }, [])

  const closeOverlays = (error) => {
    actions.closeSettings()
    actions.closeMemory()
    actions.closeMenu()
    actions.closePanel()
    actions.closePalette()
    actions.closeVoice()
    actions.closeOverlay()
    actions.reportError(error, 'overlay')
  }

  const chatMain = shown
    ? h(Fragment, { key: shown },
      h('div', { className: 'dsb-head' }, h(HeaderPill, { ...views, sessionId: shown, useSession: team.sessionHook(shown) })),
      h(Chat, { sessionId: shown, team }))
    : h('div', { className: 'dsb-mw-muted', style: { padding: 24 } }, '正在准备对话…')

  return h('div', {
    className: `dsb-frame${mobile ? ' dsb-mobile' : ''}`,
    'data-rail': !mobile && !wide ? '' : undefined,
    'data-library': libraryOpen ? '' : undefined,
  },
    h('aside', { className: 'dsb-side' },
      h('div', { className: 'dsb-band', 'data-tauri-drag-region': '' }),
      wide || mobile
        ? null
        : h('button', {
          type: 'button',
          className: 'dsb-expand',
          'aria-label': t('Expand sidebar'),
          title: t('Expand sidebar'),
          onClick: () => actions.toggleSidebar(),
        }, h(BrandMark, { size: 22 })),
      h('div', { className: 'dsb-side-list' },
        h(TeamSidebar, { ...views, wide: wide || mobile })),
      h('div', { className: 'dsb-side-foot' },
        user && (wide || mobile)
          ? h('div', { className: 'dsb-account' },
            h('span', { className: 'dsb-account-mail', title: user.email }, user.email),
            h('span', { className: 'dsb-account-actions' },
              user.role === 'admin' ? h('button', { type: 'button', onClick: onAdmin }, '用户') : null,
              h('button', { type: 'button', onClick: onPassword }, '密码'),
              h('button', { type: 'button', onClick: onLogout }, '退出')))
          : null,
        h('button', {
          type: 'button',
          className: 'dsb-docs-entry',
          title: color === 'dark' ? '切换到浅色' : '切换到深色',
          onClick: () => setScheme(color === 'dark' ? 'light' : 'dark'),
        }, color === 'dark' ? (wide || mobile ? '浅色' : '浅') : (wide || mobile ? '深色' : '深')),
        h('button', { type: 'button', className: 'dsb-settings', title: t('Settings'), onClick: () => actions.openSettings() }, h(YouAvatar)))),
    h('main', { className: 'dsb-main dsb_centerCol' },
      h('div', { className: 'dsb-band', 'data-tauri-drag-region': '' }),
      chatMain),
    h(DocsFab, { open: libraryOpen, onClick: () => setLibraryOpen(true) }),
    libraryOpen
      ? h(LibraryPanel, {
        focusId: docFocus,
        onClose: () => setLibraryOpen(false),
        onConsumedFocus: () => setDocFocus(null),
      })
      : null,
    mobile
      ? h('nav', { className: 'dsb-mobile-bar', 'aria-label': '主区切换' },
        h('button', {
          type: 'button',
          className: !libraryOpen ? 'active' : undefined,
          onClick: () => setLibraryOpen(false),
        }, '对话'),
        h('button', {
          type: 'button',
          className: libraryOpen ? 'active' : undefined,
          onClick: () => setLibraryOpen(true),
        }, '文档'))
      : null,
    h('div', { className: 'dsb-chrome-float', 'aria-hidden': false },
      h(Contain, { onError: closeOverlays }, h(Overlays, views)),
      h(ErrorToast, views)))
}
