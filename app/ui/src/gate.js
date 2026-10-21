import { createElement as h, useEffect, useState } from 'react'
import { allThemes, themeCss } from '../../../ds-bot/src/client/themes.js'
import { logout, me } from './account.js'
import { Admin } from './admin.js'
import { App } from './app.js'
import { Login } from './login.js'

function useShellTheme() {
  useEffect(() => {
    const style = document.createElement('style')
    style.textContent = themeCss(allThemes().deepseek)
    document.head.append(style)
    return () => { style.remove() }
  }, [])
}

export function Gate() {
  const [user, setUser] = useState(undefined)
  const [admin, setAdmin] = useState(false)
  useShellTheme()
  useEffect(() => {
    let stopped = false
    me().then(next => { if (!stopped) setUser(next) }).catch(() => { if (!stopped) setUser(null) })
    return () => { stopped = true }
  }, [])
  if (user === undefined) return h('div', { className: 'dsb-auth' }, h('p', null, '正在进入…'))
  if (!user) return h(Login, { onSuccess: setUser })
  if (admin) return h(Admin, { user, onClose: () => setAdmin(false) })
  return h(App, {
    user,
    onUser: setUser,
    onAdmin: () => setAdmin(true),
    onLogout: async () => {
      await logout()
      setAdmin(false)
      setUser(null)
    },
  })
}
