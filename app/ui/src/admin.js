import { createElement as h, useEffect, useState } from 'react'
import { createUser, deleteUser, listUsers, updateUser } from './account.js'

function IssuedPassword({ issued, onClose }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(issued.password)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }
  return h('div', { className: 'dsb-issued' },
    h('p', null, `${issued.email} 的初始密码只显示这一次。交给用户后，对方第一次登录必须修改。`),
    h('input', { readOnly: true, value: issued.password, spellCheck: false, 'aria-label': '初始密码', onFocus: event => event.target.select() }),
    h('div', { className: 'dsb-issued-actions' },
      h('button', { type: 'button', onClick: copy }, copied ? '已复制' : '复制'),
      h('button', { type: 'button', onClick: onClose }, '我已抄下')))
}

function UserRow({ user, self, onChange, onIssued }) {
  const [quota, setQuota] = useState(String(user.quota))
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const save = async (patch) => {
    setBusy(true)
    setError('')
    try {
      await updateUser(user.id, patch)
      await onChange()
    } catch (failure) {
      setError(failure?.message ?? '保存失败')
    } finally {
      setBusy(false)
    }
  }
  return h('li', { className: 'dsb-admin-row' },
    h('div', null,
      h('strong', null, user.email),
      h('span', null, user.role === 'admin' ? '管理员' : '普通用户'),
      user.mustChangePassword ? h('span', null, '待修改初始密码') : null,
      h('span', null, `已用 ${user.used} / ${user.quota}`)),
    h('label', null, '配额',
      h('input', {
        type: 'number', min: 0, step: 1, value: quota, disabled: busy,
        onChange: event => setQuota(event.target.value),
      })),
    h('div', { className: 'dsb-admin-actions' },
      h('button', { type: 'button', disabled: busy, onClick: () => save({ quota: Number(quota) }) }, '保存配额'),
      h('button', { type: 'button', disabled: busy, onClick: () => save({ used: 0 }) }, '已用清零'),
      self ? null : h('button', { type: 'button', disabled: busy, onClick: () => {
        setBusy(true)
        setError('')
        updateUser(user.id, { resetPassword: true }).then((result) => {
          onIssued({ email: user.email, password: result.password })
          return onChange()
        }, failure => setError(failure?.message ?? '重置失败')).finally(() => setBusy(false))
      } }, '重置初始密码'),
      self ? null : h('button', { type: 'button', disabled: busy, onClick: () => {
        if (!window.confirm(`删除 ${user.email}？该账号的机器人记录会从这台网关的账本里去掉。`)) return
        deleteUser(user.id).then(onChange, failure => setError(failure?.message ?? '删除失败'))
      } }, '删除')),
    error ? h('div', { className: 'dsb-auth-error', role: 'alert' }, error) : null)
}

export function Admin({ user, onClose }) {
  const [users, setUsers] = useState(null)
  const [error, setError] = useState('')
  const [form, setForm] = useState({ email: '', quota: '200' })
  const [issued, setIssued] = useState(null)
  const [busy, setBusy] = useState(false)
  const load = () => listUsers().then(result => setUsers(result.users)).catch(failure => setError(failure?.message ?? '读不到用户列表'))
  useEffect(() => { void load() }, [])
  const set = (key) => (event) => setForm(current => ({ ...current, [key]: event.target.value }))
  const create = async (event) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const created = await createUser({ email: form.email, quota: Number(form.quota) })
      setIssued({ email: created.user.email, password: created.password })
      setForm({ email: '', quota: form.quota })
      await load()
    } catch (failure) {
      setError(failure?.message ?? '创建失败')
    } finally {
      setBusy(false)
    }
  }
  return h('div', { className: 'dsb-auth dsb-admin' },
    h('div', { className: 'dsb-admin-card' },
      h('div', { className: 'dsb-admin-head' },
        h('div', null,
          h('h1', null, '用户与配额'),
          h('p', null, '配额按消息条数计算。每发送一条，或向记忆提问一次，计 1 次。用尽后不能再发送。')),
        h('button', { type: 'button', onClick: onClose }, '返回')),
      h('form', { className: 'dsb-admin-create', onSubmit: create },
        h('label', null, '邮箱', h('input', { type: 'email', required: true, value: form.email, autoComplete: 'off', onChange: set('email') })),
        h('label', null, '配额', h('input', { type: 'number', min: 0, step: 1, required: true, value: form.quota, onChange: set('quota') })),
        h('button', { type: 'submit', disabled: busy }, busy ? '正在创建…' : '开通账号')),
      error ? h('div', { className: 'dsb-auth-error', role: 'alert' }, error) : null,
      issued ? h(IssuedPassword, { issued, onClose: () => setIssued(null) }) : null,
      users === null ? h('p', null, '正在读取用户…') : h('ul', { className: 'dsb-admin-list' },
        users.map(entry => h(UserRow, { key: entry.id, user: entry, self: entry.id === user.id, onChange: load, onIssued: setIssued })))))
}
