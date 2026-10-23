import { Component, createElement as h, Fragment, useEffect, useMemo } from 'react'
import { me } from './account.js'
import { ErrorToast } from '../../../ds-bot/src/client/feedback.js'
import { HeaderPill } from '../../../ds-bot/src/client/header.js'
import { t } from '../../../ds-bot/src/client/i18n.js'
import { Overlays } from '../../../ds-bot/src/client/overlays.js'
import { BrandMark, TeamSidebar, YouAvatar } from '../../../ds-bot/src/client/sidebar.js'
import { allThemes, themeCss } from '../../../ds-bot/src/client/themes.js'
import { Chat } from './chat.js'
import { createTeam } from './team.js'

// The team's theme and accent, as the plugin paints them.
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

// A dialog or panel that fails closes, and the failure shows as a toast; the window stays.
// One that fails again at once stays closed.
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

export function App({ user, onLogout, onAdmin, onMedia, onPassword, onUser }) {
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
  return h('div', { className: 'dsb-frame', 'data-rail': wide ? undefined : '' },
    h('aside', { className: 'dsb-side' },
      h('div', { className: 'dsb-band', 'data-tauri-drag-region': '' }),
      h('div', { className: 'dsb-side-list' },
        wide ? null : h('button', { type: 'button', className: 'dsb-expand', 'aria-label': t('Expand sidebar'), title: t('Expand sidebar'), onClick: () => actions.toggleSidebar() }, h(BrandMark, { size: 22 })),
        h(TeamSidebar, { ...views, wide })),
      h('div', { className: 'dsb-side-foot' },
        user ? h('div', { className: 'dsb-account' },
          h('span', { className: 'dsb-account-mail', title: user.email }, user.email),
          h('span', { className: 'dsb-account-quota' }, `已用 ${user.used} / ${user.quota} 条`),
          h('span', { className: 'dsb-account-actions' },
            h('button', { type: 'button', onClick: onMedia }, '自媒体账号'),
            user.role === 'admin' ? h('button', { type: 'button', onClick: onAdmin }, '用户与配额') : null,
            h('button', { type: 'button', onClick: onPassword }, '修改密码'),
            h('button', { type: 'button', onClick: onLogout }, '退出'))) : null,
        // Rail 模式会藏掉账号区，保留独立入口，避免「找不到自媒体账号」。
        h('button', {
          type: 'button',
          className: 'dsb-media-rail',
          title: '自媒体账号',
          'aria-label': '自媒体账号',
          onClick: onMedia,
        }, '自媒体'),
        h('button', { type: 'button', className: 'dsb-settings', title: t('Settings'), onClick: () => actions.openSettings() }, h(YouAvatar)))),
    // The details panel makes room by giving the shell's `_centerCol` column a right margin.
    h('main', { className: 'dsb-main dsb_centerCol' },
      h('div', { className: 'dsb-band', 'data-tauri-drag-region': '' }),
      shown ? h(Fragment, { key: shown },
        h('div', { className: 'dsb-head' }, h(HeaderPill, { ...views, sessionId: shown, useSession: team.sessionHook(shown) })),
        h(Chat, { sessionId: shown, team })) : null),
    h(Contain, { onError: closeOverlays }, h(Overlays, views)),
    h(ErrorToast, views))
}
