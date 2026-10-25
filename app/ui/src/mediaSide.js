import { createElement as h, useCallback, useEffect, useMemo, useState } from 'react'
import {
  createMediaAccount,
  fetchMediaAccounts,
  fetchMediaManuscript,
  fetchMediaWorkspace,
  focusMediaAccount,
  updateMediaEntity,
} from './account.js'

export const WORKBENCH_TABS = [
  { id: 'board', label: '看板' },
  { id: 'posts', label: '帖子' },
  { id: 'manuscripts', label: '稿件' },
  { id: 'published', label: '已发' },
  { id: 'engagement', label: '互动' },
  { id: 'followers', label: '粉丝' },
  { id: 'revenue', label: '收益' },
  { id: 'events', label: '事件' },
]

const FUNNEL_ORDER = ['选题', '写稿中', '待确认', '已发布', '被隐藏', '搁置']

function fmt(n) {
  if (n == null) return '—'
  return Number(n).toLocaleString('zh-CN')
}

function buildNeeds(data) {
  const items = []
  for (const p of data.posts || []) {
    if (p.status === '待确认' || p.status === '选题') {
      items.push({
        id: `need-post-${p.id}`,
        kind: p.status === '选题' ? 'topic' : 'pending',
        title: p.title,
        meta: p.status === '选题' ? '选题待确认' : '待确认 · 发布闸门',
        anchor: { kind: 'post', id: p.id, title: p.title, tab: 'posts' },
        entityKind: 'post',
        entityId: p.id,
      })
    }
  }
  for (const m of data.manuscripts || []) {
    const active = m.status === '写稿中' || m.status === '待确认'
      || (m.post_id && (data.posts || []).some(p => p.id === m.post_id && (p.status === '写稿中' || p.status === '待确认')))
    if (!m.final_review_passed && active) {
      items.push({
        id: `need-ms-${m.id}`,
        kind: 'review',
        title: m.title,
        meta: '终审未过',
        anchor: { kind: 'manuscript', id: m.id, title: m.title, tab: 'manuscripts' },
        entityKind: 'manuscript',
        entityId: m.id,
      })
    }
  }
  for (const e of data.platform_events || []) {
    const t = `${e.event_type || ''} ${e.name || ''} ${e.remark || ''}`
    if (/未通过|拒绝|隐藏|下架|违规|失败/.test(t) || (/审核/.test(t) && !/通过|成功/.test(t))) {
      items.push({
        id: `need-ev-${e.id}`,
        kind: 'event',
        title: e.name,
        meta: `${e.event_type} · ${e.occurred_at}`,
        anchor: { kind: 'event', id: e.id, title: e.name, tab: 'events' },
      })
    }
  }
  const seen = new Set()
  return items.filter((it) => {
    const key = `${it.kind}:${it.entityId || it.anchor.id}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function BoardBody({ data, onAnchor, onAct, busy }) {
  const { board, account } = data
  const needs = useMemo(() => buildNeeds(data), [data])
  const funnel = board.post_funnel || {}
  return h('div', { className: 'dsb-mw-body' },
    h('div', { className: 'dsb-mw-account' },
      h('strong', null, account.display_name),
      h('span', null, `${account.platform === 'xiaoheihe' ? '小黑盒' : account.platform} · ${account.status}`)),
    board.positioning
      ? h('p', { className: 'dsb-mw-muted' }, `${board.positioning.what_it_is} · ${board.positioning.goal || ''}`)
      : null,
    h('p', { className: 'dsb-mw-muted' },
      `粉丝 ${fmt(board.followers_latest?.followers)} · KPI ¥${board.revenue_kpi_cny}`),
    h('div', { className: 'dsb-mw-label' }, '帖状态漏斗'),
    h('div', { className: 'dsb-mw-funnel' },
      FUNNEL_ORDER.map((k) => h('span', { key: k }, `${k} ${funnel[k] || 0}`))),
    h('div', { className: 'dsb-mw-focus' },
      h('div', { className: 'dsb-mw-label' }, `Needs you · ${needs.length}`),
      needs.length === 0
        ? h('p', { className: 'dsb-mw-muted' }, '没有等你拍板的项')
        : needs.slice(0, 8).map((it) => h('div', { key: it.id, className: 'dsb-mw-need' },
          h('button', {
            type: 'button',
            className: 'dsb-mw-item',
            onClick: () => onAnchor(it.anchor),
          }, it.title),
          h('span', { className: 'dsb-mw-muted' }, it.meta),
          it.kind === 'event'
            ? null
            : h('div', { className: 'dsb-mw-actions' },
              it.kind === 'topic' || it.kind === 'pending'
                ? h('button', {
                  type: 'button',
                  className: 'dsb-mw-act',
                  disabled: busy,
                  onClick: () => onAct(it, 'confirm_topic'),
                }, '确认选题')
                : null,
              it.kind === 'review'
                ? h('button', {
                  type: 'button',
                  className: 'dsb-mw-act',
                  disabled: busy,
                  onClick: () => onAct(it, 'pass_review'),
                }, '终审通过')
                : null,
              h('button', {
                type: 'button',
                className: 'dsb-mw-act ghost',
                disabled: busy,
                onClick: () => onAct(it, 'hold'),
              }, '搁置'),
              h('button', {
                type: 'button',
                className: 'dsb-mw-act ghost',
                onClick: () => onAnchor(it.anchor),
              }, '锚定对话'))))),
    (board.writing || []).length
      ? h('div', { className: 'dsb-mw-focus' },
        h('div', { className: 'dsb-mw-label' }, '进行中'),
        board.writing.slice(0, 5).map((p) =>
          h('button', {
            key: p.id,
            type: 'button',
            className: 'dsb-mw-item',
            onClick: () => onAnchor({ kind: 'post', id: p.id, title: p.title, tab: 'posts' }),
          }, `${p.title} · ${p.status}`)))
      : null)
}

function PostsBody({ data, onAnchor, activeId }) {
  return h('div', { className: 'dsb-mw-body' },
    h('div', { className: 'dsb-mw-label' }, '帖子 / 选题发布'),
    h('ul', { className: 'dsb-mw-list' },
      data.posts.map(p => h('li', {
        key: p.id,
        className: activeId === p.id ? 'active' : undefined,
      },
        h('button', {
          type: 'button',
          className: 'dsb-mw-item',
          onClick: () => onAnchor({ kind: 'post', id: p.id, title: p.title, tab: 'posts' }),
        }, p.title),
        h('span', { className: 'dsb-mw-muted' },
          `${p.status} · ${p.content_type || ''} · 浏览 ${fmt(p.metrics_views)}`),
        p.remark ? h('span', { className: 'dsb-mw-muted' }, p.remark.split('\n').slice(-1)[0]) : null))))
}

function ListBody({ title, rows, activeId }) {
  return h('div', { className: 'dsb-mw-body' },
    h('div', { className: 'dsb-mw-label' }, title),
    rows.length === 0
      ? h('p', { className: 'dsb-mw-muted' }, '暂无数据')
      : h('ul', { className: 'dsb-mw-list' },
        rows.map(row => h('li', {
          key: row.id,
          className: activeId === row.id ? 'active' : undefined,
        },
          row.onClick
            ? h('button', { type: 'button', className: 'dsb-mw-item', onClick: row.onClick }, row.title)
            : h('strong', null, row.title),
          row.meta ? h('span', { className: 'dsb-mw-muted' }, row.meta) : null))))
}

function ManuscriptBody({ data, onOpen, preview, onAnchor, activeId }) {
  return h('div', { className: 'dsb-mw-body' },
    h('div', { className: 'dsb-mw-label' }, '历史稿件'),
    h('p', { className: 'dsb-mw-muted' }, '写作稿 ≠ 发布版'),
    h('ul', { className: 'dsb-mw-list' },
      data.manuscripts.map(m => h('li', {
        key: m.id,
        className: activeId === m.id ? 'active' : undefined,
      },
        h('button', {
          type: 'button',
          className: 'dsb-mw-item',
          onClick: () => onAnchor({ kind: 'manuscript', id: m.id, title: m.title, tab: 'manuscripts' }),
        }, m.title),
        h('span', { className: 'dsb-mw-muted' },
          `${m.status} · 终审 ${m.final_review_passed ? '通过' : '未过'}`),
        h('button', { type: 'button', className: 'dsb-mw-link', onClick: () => onOpen(m.id) }, '看正文')))),
    preview
      ? h('pre', { className: 'dsb-mw-preview' }, preview.body || '（无写作稿）')
      : null)
}

export function MediaTopBar({ account, accounts, onFocus, onCreate, busy }) {
  const [open, setOpen] = useState(false)
  const platform = account?.platform === 'xiaoheihe' ? '小黑盒' : account?.platform
  return h('div', { className: 'dsb-media-top' },
    h('div', { className: 'dsb-media-top-brand' },
      h('strong', null, 'BotCamp'),
      account
        ? h('button', {
          type: 'button',
          className: 'dsb-media-top-focus',
          disabled: busy,
          onClick: () => setOpen(v => !v),
          'aria-expanded': open,
          title: '切换自媒体账号',
        }, `${account.display_name} · ${platform}`)
        : h('span', { className: 'dsb-mw-muted' }, '加载账号…')),
    open ? h('div', { className: 'dsb-media-switch', role: 'menu' },
      (accounts || []).map(a => h('button', {
        key: a.id,
        type: 'button',
        role: 'menuitem',
        className: a.id === account?.id ? 'active' : undefined,
        disabled: busy,
        onClick: () => { setOpen(false); onFocus(a.id) },
      }, `${a.display_name} · ${a.platform === 'xiaoheihe' ? '小黑盒' : a.platform}`)),
      h('button', {
        type: 'button',
        role: 'menuitem',
        disabled: busy,
        onClick: () => { setOpen(false); onCreate() },
      }, '起新号')) : null)
}

/**
 * Side workbench: tabs on top, SoT content. Chat stays main; clicks emit onAnchor.
 */
export function MediaSidePanel({
  wide,
  mobile,
  tab,
  onTab,
  reloadToken,
  onWorkspace,
  onAnchor,
  anchor,
  onWrote,
}) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    fetchMediaWorkspace()
      .then((result) => {
        setData(result.workspace)
        setError('')
        onWorkspace?.(result.workspace)
      })
      .catch((failure) => setError(failure?.message ?? '看板加载失败'))
  }, [onWorkspace])

  useEffect(() => { load() }, [load, reloadToken])

  const onAct = async (item, action) => {
    if (!data?.account?.id || !item.entityId || busy) return
    setBusy(true)
    setError('')
    try {
      const res = await updateMediaEntity({
        accountId: data.account.id,
        kind: item.entityKind,
        entityId: item.entityId,
        action,
      })
      setData(res.workspace)
      onWorkspace?.(res.workspace)
      onWrote?.()
      if (item.anchor) onAnchor(item.anchor)
    } catch (failure) {
      setError(failure?.message ?? '操作失败')
    } finally {
      setBusy(false)
    }
  }

  const openManuscript = async (id) => {
    if (!data) return
    try {
      const res = await fetchMediaManuscript(data.account.id, id)
      setPreview({ id, title: res.manuscript.title, body: res.body })
      onTab('manuscripts')
    } catch (failure) {
      setError(failure?.message ?? '读稿失败')
    }
  }

  if (!wide && !mobile) {
    return h('div', { className: 'dsb-mw-rail', title: '展开侧栏查看看板' }, '板')
  }

  let body = null
  if (error && !data) body = h('p', { className: 'dsb-mw-error', role: 'alert' }, error)
  else if (!data) body = h('p', { className: 'dsb-mw-muted' }, '加载看板…')
  else if (tab === 'board') body = h(BoardBody, { data, onAnchor, onAct, busy })
  else if (tab === 'posts') body = h(PostsBody, { data, onAnchor, activeId: anchor?.id })
  else if (tab === 'manuscripts') {
    body = h(ManuscriptBody, {
      data,
      onOpen: openManuscript,
      preview,
      onAnchor,
      activeId: anchor?.id,
    })
  } else if (tab === 'published') {
    body = h(ListBody, {
      title: `已发作品 · ${data.published_works.length}`,
      activeId: anchor?.id,
      rows: data.published_works.map(p => ({
        id: p.id,
        title: p.title,
        meta: `浏览 ${fmt(p.metrics_views)} · 赞 ${fmt(p.metrics_likes)}`,
        onClick: () => onAnchor({ kind: 'post', id: p.id, title: p.title, tab: 'published' }),
      })),
    })
  } else if (tab === 'engagement') {
    body = h(ListBody, {
      title: `互动快照 · ${data.engagement_snapshots.length}`,
      rows: [...data.engagement_snapshots]
        .sort((a, b) => `${b.snapshot_date}`.localeCompare(a.snapshot_date))
        .map(e => ({
          id: e.id,
          title: e.title,
          meta: `${e.snapshot_date} · 浏览 ${fmt(e.views)} · 赞 ${fmt(e.likes)}`,
          onClick: () => onAnchor({ kind: 'engagement', id: e.id, title: e.title, tab: 'engagement' }),
        })),
    })
  } else if (tab === 'followers') {
    body = h(ListBody, {
      title: `粉丝 · ${data.follower_snapshots.length}`,
      rows: [...data.follower_snapshots]
        .sort((a, b) => b.record_date.localeCompare(a.record_date))
        .map(f => ({
          id: f.id,
          title: f.record_date,
          meta: `粉丝 ${fmt(f.followers)} · 帖 ${fmt(f.post_count)}`,
        })),
    })
  } else if (tab === 'revenue') {
    body = h(ListBody, {
      title: `收益 · KPI ¥${data.board.revenue_kpi_cny}`,
      rows: data.revenue.map(r => ({
        id: r.id,
        title: r.record_title,
        meta: `${r.amount} ${r.currency} · ${r.revenue_type}`,
      })),
    })
  } else if (tab === 'events') {
    body = h(ListBody, {
      title: `平台事件 · ${data.platform_events.length}`,
      rows: data.platform_events.map(e => ({
        id: e.id,
        title: e.name,
        meta: `${e.event_type} · ${e.occurred_at}`,
        onClick: () => onAnchor({ kind: 'event', id: e.id, title: e.name, tab: 'events' }),
      })),
    })
  }

  return h('div', { className: `dsb-mw${mobile ? ' mobile' : ''}` },
    h('div', { className: 'dsb-mw-tabs', role: 'tablist', 'aria-label': '号看板' },
      WORKBENCH_TABS.map(t => h('button', {
        key: t.id,
        type: 'button',
        role: 'tab',
        'aria-selected': tab === t.id,
        className: `dsb-mw-tab${tab === t.id ? ' active' : ''}`,
        onClick: () => onTab(t.id),
      }, t.label))),
    error && data ? h('p', { className: 'dsb-mw-error', role: 'alert' }, error) : null,
    body)
}

export function useMediaAccounts(reloadToken) {
  const [accounts, setAccounts] = useState([])
  const [currentId, setCurrentId] = useState(null)
  const refresh = useCallback(() => fetchMediaAccounts()
    .then((res) => {
      setAccounts(res.accounts || [])
      setCurrentId(res.current_media_account_id || null)
      return res
    }), [])
  useEffect(() => { void refresh().catch(() => {}) }, [refresh, reloadToken])
  return {
    accounts,
    currentId,
    refresh,
    focus: (id) => focusMediaAccount(id).then((res) => {
      setCurrentId(res.workspace?.account?.id || id)
      return res
    }),
    create: () => createMediaAccount({ display_name: '新自媒体账号' }).then((res) => {
      setCurrentId(res.workspace?.account?.id || null)
      return res
    }),
  }
}
