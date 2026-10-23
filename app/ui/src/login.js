import { createElement as h, useState } from 'react'
import { BrandMark, BrandName } from '../../../ds-bot/src/client/sidebar.js'
import { changePassword, login } from './account.js'
import { clientMode } from './session.js'

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
      h('h1', null, clientMode() ? 'BotCamp' : 'DeepSeek Bot'),
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

export function PasswordForm({ forced, onSuccess, onCancel, onLogout }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (event) => {
    event.preventDefault()
    if (busy) return
    if (next !== again) {
      setError('两次输入的新密码不一致。')
      return
    }
    setBusy(true)
    setError('')
    try {
      const result = await changePassword(current, next)
      onSuccess(result.user)
    } catch (failure) {
      setError(failure?.message ?? '修改失败')
      setBusy(false)
    }
  }
  return h('div', { className: 'dsb-auth' },
    h('form', { className: 'dsb-auth-card', onSubmit: submit },
      h('div', { className: 'dsb-auth-brand' }, h(BrandMark, { size: 36 }), h(BrandName)),
      h('h1', null, forced ? '请修改初始密码' : '修改密码'),
      h('p', null, forced ? '这是第一次登录。设置一个新密码后才能使用。' : '输入当前密码，再设置一个新密码。'),
      h('label', null, '当前密码',
        h('input', {
          type: 'password', autoComplete: 'current-password', required: true, value: current,
          onChange: event => setCurrent(event.target.value),
        })),
      h('label', null, '新密码',
        h('input', {
          type: 'password', autoComplete: 'new-password', required: true, minLength: 8, value: next,
          onChange: event => setNext(event.target.value),
        })),
      h('label', null, '再输入一次新密码',
        h('input', {
          type: 'password', autoComplete: 'new-password', required: true, minLength: 8, value: again,
          onChange: event => setAgain(event.target.value),
        })),
      error ? h('div', { className: 'dsb-auth-error', role: 'alert' }, error) : null,
      h('div', { className: 'dsb-auth-actions' },
        h('button', { type: 'submit', disabled: busy }, busy ? '正在保存…' : '保存新密码'),
        forced
          ? h('button', { type: 'button', className: 'dsb-auth-quiet', onClick: onLogout }, '退出')
          : h('button', { type: 'button', className: 'dsb-auth-quiet', onClick: onCancel }, '返回'))))
}
