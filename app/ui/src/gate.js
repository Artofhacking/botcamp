import { createElement as h, useEffect, useState } from 'react'
import { allThemes, themeCss } from '../../../ds-bot/src/client/themes.js'
import { logout, me } from './account.js'
import { Admin } from './admin.js'
import { App } from './app.js'
import { Login, PasswordForm } from './login.js'

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
  const [changing, setChanging] = useState(false)
  useShellTheme()
  useEffect(() => {
    let stopped = false
    me().then(next => { if (!stopped) setUser(next) }).catch(() => { if (!stopped) setUser(null) })
    return () => { stopped = true }
  }, [])
  const signOut = async () => {
    await logout()
    setAdmin(false)
    setChanging(false)
    setUser(null)
  }
  if (user === undefined) return h('div', { className: 'dsb-auth' }, h('p', null, '正在进入…'))
  if (!user) return h(Login, { onSuccess: setUser })
  if (user.mustChangePassword || changing) {
    return h(PasswordForm, {
      forced: user.mustChangePassword === true,
      onSuccess: (next) => { setChanging(false); setUser(next) },
      onCancel: () => setChanging(false),
      onLogout: signOut,
    })
  }
  if (admin) return h(Admin, { user, onClose: () => setAdmin(false) })
  return h(App, {
    user,
    onUser: setUser,
    onAdmin: () => setAdmin(true),
    onPassword: () => setChanging(true),
    onLogout: signOut,
  })
}
