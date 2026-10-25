import { Component, createElement as h, Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { me } from './account.js'
import { ErrorToast } from '../../../ds-bot/src/client/feedback.js'
import { HeaderPill } from '../../../ds-bot/src/client/header.js'
import { t } from '../../../ds-bot/src/client/i18n.js'
import { Overlays } from '../../../ds-bot/src/client/overlays.js'
import { BrandMark, TeamSidebar, YouAvatar } from '../../../ds-bot/src/client/sidebar.js'
import { allThemes, themeCss } from '../../../ds-bot/src/client/themes.js'
import { Chat } from './chat.js'
import { BoardAccountHead, MediaSidePanel, useMediaAccounts } from './mediaSide.js'
import { createTeam } from './team.js'
import { WhiteboardFab, WhiteboardPanel } from './whiteboard.js'
import { parseBoardHref } from './whiteboardApi.js'

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
  const [tab, setTab] = useState('board')
  const [reportOpen, setReportOpen] = useState(false)
  const [whiteboardOpen, setWhiteboardOpen] = useState(false)
  const [boardFocus, setBoardFocus] = useState(null)
  const [anchor, setAnchor] = useState(null)
  const [workspace, setWorkspace] = useState(null)
  const [reloadToken, setReloadToken] = useState(0)
  const [switchBusy, setSwitchBusy] = useState(false)
  const mediaAccounts = useMediaAccounts(reloadToken)

  const bump = useCallback(() => setReloadToken(n => n + 1), [])

  const onAnchor = useCallback((next) => {
    setAnchor(next)
    if (next?.tab) setTab(next.tab)
    if (mobile) setReportOpen(false)
  }, [mobile])

  const onFocusAccount = async (id) => {
    setSwitchBusy(true)
    try {
      const res = await mediaAccounts.focus(id)
      setWorkspace(res.workspace)
      setAnchor(null)
      bump()
    } finally {
      setSwitchBusy(false)
    }
  }

  const onCreateAccount = async () => {
    setSwitchBusy(true)
    try {
      const res = await mediaAccounts.create()
      setWorkspace(res.workspace)
      setAnchor(null)
      setTab('board')
      bump()
    } finally {
      setSwitchBusy(false)
    }
  }

  const { hooks, actions } = team
  const views = { ...hooks, actions }
  const wide = hooks.useLayout(state => state.wide)
  const shown = hooks.useShown(id => id)
  const roster = hooks.useRoster(value => value)
  useTheme(hooks.useRoster(value => value.prefs))

  useEffect(() => {
    if (!roster?.ready || shown) return
    const chief = (roster.bots || []).find((b) => b.name === '总负责人' || b.name === '主编' || b.id === 'co_chief')
      || (roster.bots || [])[0]
    if (chief?.id) actions.landOn(chief.id)
  }, [roster?.ready, roster?.bots, shown, actions])

  useEffect(() => {
    const onLink = (event) => {
      const href = event.detail?.href
      const parsed = parseBoardHref(href)
      if (!parsed) return
      setBoardFocus(parsed)
      setWhiteboardOpen(true)
    }
    window.addEventListener('botcamp:board-link', onLink)
    return () => window.removeEventListener('botcamp:board-link', onLink)
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
      h(Chat, {
        sessionId: shown,
        team,
        anchor,
        onClearAnchor: () => setAnchor(null),
        workspace,
        onWorkbenchWrite: bump,
      }))
    : h('div', { className: 'dsb-mw-muted', style: { padding: 24 } }, '正在准备对话…')

  const reportDrawer = reportOpen
    ? h(Fragment, null,
      h('button', {
        type: 'button',
        className: 'dsb-board-scrim',
        'aria-label': '关闭报表',
        onClick: () => setReportOpen(false),
      }),
      h('aside', {
        className: 'dsb-board-drawer',
        role: 'dialog',
        'aria-label': '号报表',
      },
        h('div', { className: 'dsb-board-drawer-head' },
          h('button', { type: 'button', className: 'dsb-board-close', onClick: () => setReportOpen(false) }, '关闭'),
          h(BoardAccountHead, {
            account: workspace?.account,
            accounts: mediaAccounts.accounts,
            onFocus: onFocusAccount,
            onCreate: onCreateAccount,
            busy: switchBusy,
          })),
        h(MediaSidePanel, {
          wide: true,
          mobile: false,
          drawer: true,
          tab,
          onTab: setTab,
          reloadToken,
          onWorkspace: setWorkspace,
          onAnchor,
          anchor,
          onWrote: bump,
        })))
    : null

  return h('div', {
    className: `dsb-frame${mobile ? ' dsb-mobile' : ''}`,
    'data-rail': !mobile && !wide ? '' : undefined,
    'data-whiteboard': whiteboardOpen ? '' : undefined,
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
        h('button', {
          type: 'button',
          className: 'dsb-board-entry',
          onClick: () => setReportOpen(true),
          title: '报表面板（也可在对话里问总负责人）',
        }, wide || mobile ? '报表' : '报'),
        user && (wide || mobile)
          ? h('div', { className: 'dsb-account' },
            h('span', { className: 'dsb-account-mail', title: user.email }, user.email),
            h('span', { className: 'dsb-account-actions' },
              user.role === 'admin' ? h('button', { type: 'button', onClick: onAdmin }, '用户') : null,
              h('button', { type: 'button', onClick: onPassword }, '密码'),
              h('button', { type: 'button', onClick: onLogout }, '退出')))
          : null,
        h('button', { type: 'button', className: 'dsb-settings', title: t('Settings'), onClick: () => actions.openSettings() }, h(YouAvatar)))),
    h('main', { className: 'dsb-main dsb_centerCol' },
      h('div', { className: 'dsb-band', 'data-tauri-drag-region': '' }),
      chatMain),
    h(WhiteboardFab, {
      open: whiteboardOpen,
      onClick: () => setWhiteboardOpen((v) => !v),
    }),
    h(WhiteboardPanel, {
      open: whiteboardOpen,
      sessionId: shown,
      focusLink: boardFocus,
      onClose: () => setWhiteboardOpen(false),
      onConsumedFocus: () => setBoardFocus(null),
    }),
    mobile
      ? h('nav', { className: 'dsb-mobile-bar', 'aria-label': '主区切换' },
        h('button', {
          type: 'button',
          className: !whiteboardOpen && !reportOpen ? 'active' : undefined,
          onClick: () => { setWhiteboardOpen(false); setReportOpen(false) },
        }, '对话'),
        h('button', {
          type: 'button',
          className: whiteboardOpen ? 'active' : undefined,
          onClick: () => { setReportOpen(false); setWhiteboardOpen(true) },
        }, '白板'))
      : null,
    reportDrawer,
    h('div', { className: 'dsb-chrome-float', 'aria-hidden': false },
      h(Contain, { onError: closeOverlays }, h(Overlays, views)),
      h(ErrorToast, views)))
}
