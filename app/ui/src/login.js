import { createElement as h, useState } from 'react'
import { BrandMark, BrandName } from '../../../ds-bot/src/client/sidebar.js'
import { login } from './account.js'

export function Login({ onSuccess }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (event) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const result = await login(email, password)
      onSuccess(result.user)
    } catch (failure) {
      setError(failure?.message ?? '登录失败')
      setBusy(false)
    }
  }
  return h('div', { className: 'dsb-auth' },
    h('form', { className: 'dsb-auth-card', onSubmit: submit },
      h('div', { className: 'dsb-auth-brand' }, h(BrandMark, { size: 36 }), h(BrandName)),
      h('h1', null, 'DeepSeek Bot'),
      h('p', null, '使用邮箱登录。账号由管理员开通，不能自行注册。'),
      h('label', null, '邮箱',
        h('input', {
          type: 'email', autoComplete: 'username', required: true, value: email, spellCheck: false,
          onChange: event => setEmail(event.target.value),
        })),
      h('label', null, '密码',
        h('input', {
          type: 'password', autoComplete: 'current-password', required: true, value: password,
          onChange: event => setPassword(event.target.value),
        })),
      error ? h('div', { className: 'dsb-auth-error', role: 'alert' }, error) : null,
      h('button', { type: 'submit', disabled: busy }, busy ? '正在登录…' : '登录')))
}
