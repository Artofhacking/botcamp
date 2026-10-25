import { Component, createElement as h, Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { me } from './account.js'
import { ErrorToast } from '../../../ds-bot/src/client/feedback.js'
import { HeaderPill } from '../../../ds-bot/src/client/header.js'
import { t } from '../../../ds-bot/src/client/i18n.js'
import { Overlays } from '../../../ds-bot/src/client/overlays.js'
import { BrandMark, TeamSidebar, YouAvatar } from '../../../ds-bot/src/client/sidebar.js'
import { allThemes, themeCss } from '../../../ds-bot/src/client/themes.js'
import { Chat } from './chat.js'
import { MediaSidePanel, MediaTopBar, WORKBENCH_TABS, useMediaAccounts } from './mediaSide.js'
import { createTeam } from './team.js'

const SIDE_MIN = 280
const SIDE_MAX = 520
const SIDE_DEFAULT = 340

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
  const [sideWidth, setSideWidth] = useState(() => {
    const raw = Number(localStorage.getItem('botcamp_side_width') || SIDE_DEFAULT)
    return Number.isFinite(raw) ? Math.min(SIDE_MAX, Math.max(SIDE_MIN, raw)) : SIDE_DEFAULT
  })
  const [sessionsOpen, setSessionsOpen] = useState(() => localStorage.getItem('botcamp_sessions_open') !== '0')
  const [tab, setTab] = useState('board')
  const [mobilePane, setMobilePane] = useState('chat') // chat | workbench
  const [anchor, setAnchor] = useState(null)
  const [workspace, setWorkspace] = useState(null)
  const [reloadToken, setReloadToken] = useState(0)
  const [switchBusy, setSwitchBusy] = useState(false)
  const mediaAccounts = useMediaAccounts(reloadToken)

  const bump = useCallback(() => setReloadToken(n => n + 1), [])

  const onAnchor = useCallback((next) => {
    setAnchor(next)
    if (next?.tab) setTab(next.tab)
    if (mobile) setMobilePane('chat')
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

  const startResize = (event) => {
    if (mobile || !wide) return
    event.preventDefault()
    const startX = event.clientX
    const startW = sideWidth
    let latest = startW
    const onMove = (e) => {
      latest = Math.min(SIDE_MAX, Math.max(SIDE_MIN, startW + (e.clientX - startX)))
      setSideWidth(latest)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      localStorage.setItem('botcamp_side_width', String(latest))
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  useEffect(() => {
    localStorage.setItem('botcamp_side_width', String(sideWidth))
  }, [sideWidth])

  const toggleSessions = () => {
    setSessionsOpen((v) => {
      const next = !v
      localStorage.setItem('botcamp_sessions_open', next ? '1' : '0')
      return next
    })
  }

  const { hooks, actions } = team
  const views = { ...hooks, actions }
  const wide = hooks.useLayout(state => state.wide)
  const shown = hooks.useShown(id => id)
  useTheme(hooks.useRoster(value => value.prefs))
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

  const account = workspace?.account
  // Top bar spans full width; columns are side | resizer | chat.
  const frameStyle = (!mobile && wide)
    ? { gridTemplateColumns: `${sideWidth}px 6px minmax(0,1fr)` }
    : undefined

  const workbench = h(MediaSidePanel, {
    wide: wide || mobile,
    mobile,
    tab,
    onTab: setTab,
    reloadToken,
    onWorkspace: setWorkspace,
    onAnchor,
    anchor,
    onWrote: bump,
  })

  const sessions = h('div', { className: `dsb-side-sessions${sessionsOpen ? '' : ' collapsed'}` },
    wide || mobile
      ? h('button', { type: 'button', className: 'dsb-side-sessions-toggle', onClick: toggleSessions },
        sessionsOpen ? '收起会话' : '展开会话')
      : h('button', { type: 'button', className: 'dsb-expand', 'aria-label': t('Expand sidebar'), title: t('Expand sidebar'), onClick: () => actions.toggleSidebar() }, h(BrandMark, { size: 22 })),
    sessionsOpen || !(wide || mobile)
      ? h(Fragment, null,
        h('div', { className: 'dsb-side-sessions-label' }, wide || mobile ? '会话' : null),
        h(TeamSidebar, { ...views, wide: wide || mobile }))
      : null)

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
    : h('div', { className: 'dsb-mw-muted', style: { padding: 24 } }, '正在准备主编对话…')

  return h('div', {
    className: `dsb-frame dsb-frame-media${mobile ? ' dsb-mobile' : ''}`,
    'data-rail': !mobile && !wide ? '' : undefined,
    'data-mobile-pane': mobile ? mobilePane : undefined,
    style: frameStyle,
  },
    h(MediaTopBar, {
      account,
      accounts: mediaAccounts.accounts,
      onFocus: onFocusAccount,
      onCreate: onCreateAccount,
      busy: switchBusy,
    }),
    h('aside', { className: 'dsb-side' },
      h('div', { className: 'dsb-band', 'data-tauri-drag-region': '' }),
      workbench,
      sessions,
      h('div', { className: 'dsb-side-foot' },
        user ? h('div', { className: 'dsb-account' },
          h('span', { className: 'dsb-account-mail', title: user.email }, user.email),
          h('span', { className: 'dsb-account-quota' }, `已用 ${user.used} / ${user.quota} 条`),
          h('span', { className: 'dsb-account-actions' },
            user.role === 'admin' ? h('button', { type: 'button', onClick: onAdmin }, '用户与配额') : null,
            h('button', { type: 'button', onClick: onPassword }, '修改密码'),
            h('button', { type: 'button', onClick: onLogout }, '退出'))) : null,
        h('button', { type: 'button', className: 'dsb-settings', title: t('Settings'), onClick: () => actions.openSettings() }, h(YouAvatar)))),
    mobile ? null : h('div', {
      className: 'dsb-side-resizer',
      role: 'separator',
      'aria-orientation': 'vertical',
      'aria-label': '调整工作台宽度',
      onMouseDown: startResize,
    }),
    h('main', { className: 'dsb-main dsb_centerCol' },
      h('div', { className: 'dsb-band', 'data-tauri-drag-region': '' }),
      chatMain),
    mobile
      ? h('nav', { className: 'dsb-mobile-bar', 'aria-label': '主区切换' },
        h('button', {
          type: 'button',
          className: mobilePane === 'chat' ? 'active' : undefined,
          onClick: () => setMobilePane('chat'),
        }, '对话'),
        h('button', {
          type: 'button',
          className: mobilePane === 'workbench' ? 'active' : undefined,
          onClick: () => setMobilePane('workbench'),
        }, '看板'),
        WORKBENCH_TABS.slice(0, 3).map(t => h('button', {
          key: t.id,
          type: 'button',
          className: mobilePane === 'workbench' && tab === t.id ? 'active' : undefined,
          onClick: () => { setTab(t.id); setMobilePane('workbench') },
        }, t.label)))
      : null,
    h('div', { className: 'dsb-chrome-float', 'aria-hidden': false },
      h(Contain, { onError: closeOverlays }, h(Overlays, views)),
      h(ErrorToast, views)))
}
