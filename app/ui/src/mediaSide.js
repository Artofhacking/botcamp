import { createElement as h, useCallback, useEffect, useState } from 'react'
import {
  createMediaAccount,
  fetchMediaAccounts,
  fetchMediaManuscript,
  fetchMediaWorkspace,
  focusMediaAccount,
} from './account.js'

export const WORKBENCH_TABS = [
  { id: 'board', label: '看板' },
  { id: 'posts', label: '帖子/选题' },
  { id: 'manuscripts', label: '历史稿件' },
  { id: 'published', label: '已发作品' },
  { id: 'engagement', label: '互动快照' },
  { id: 'followers', label: '粉丝' },
  { id: 'revenue', label: '收益' },
  { id: 'events', label: '事件' },
]

function fmt(n) {
  if (n == null) return '—'
  return Number(n).toLocaleString('zh-CN')
}

function BoardBody({ data, onAnchor }) {
  const { board, account } = data
  return h('div', { className: 'dsb-mw-body' },
    h('div', { className: 'dsb-mw-account' },
      h('strong', null, account.display_name),
      h('span', null, `${account.platform} · ${account.status}`)),
    h('div', { className: 'dsb-mw-funnel' },
      Object.entries(board.post_funnel || {}).map(([k, v]) =>
        h('span', { key: k }, `${k} ${v}`))),
    board.positioning
      ? h('p', { className: 'dsb-mw-muted' }, board.positioning.what_it_is)
      : null,
    h('p', { className: 'dsb-mw-muted' },
      `粉丝 ${fmt(board.followers_latest?.followers)} · KPI ¥${board.revenue_kpi_cny}`),
    (board.pending_final_review || []).length
      ? h('div', { className: 'dsb-mw-focus' },
        h('div', { className: 'dsb-mw-label' }, '此刻焦点 · 待确认'),
        board.pending_final_review.slice(0, 5).map(p =>
          h('button', {
            key: p.id,
            type: 'button',
            className: 'dsb-mw-item',
            onClick: () => onAnchor({ kind: 'post', id: p.id, title: p.title, tab: 'posts' }),
          }, p.title)))
      : null,
    (board.writing || []).length
      ? h('div', { className: 'dsb-mw-focus' },
        h('div', { className: 'dsb-mw-label' }, '写稿中'),
        board.writing.slice(0, 5).map(p =>
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
        }, `${account.display_name} · ${account.platform}`)
        : h('span', { className: 'dsb-mw-muted' }, '加载自媒体账号…')),
    open ? h('div', { className: 'dsb-media-switch', role: 'menu' },
      (accounts || []).map(a => h('button', {
        key: a.id,
        type: 'button',
        role: 'menuitem',
        className: a.id === account?.id ? 'active' : undefined,
        disabled: busy,
        onClick: () => { setOpen(false); onFocus(a.id) },
      }, `${a.display_name} · ${a.platform}`)),
      h('button', {
        type: 'button',
        role: 'menuitem',
        disabled: busy,
        onClick: () => { setOpen(false); onCreate() },
      }, '+ 起新号')) : null)
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
}) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState(null)

  const load = useCallback(() => {
    fetchMediaWorkspace()
      .then((result) => {
        setData(result.workspace)
        setError('')
        onWorkspace?.(result.workspace)
      })
      .catch((failure) => setError(failure?.message ?? '工作台加载失败'))
  }, [onWorkspace])

  useEffect(() => { load() }, [load, reloadToken])

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
    return h('div', { className: 'dsb-mw-rail', title: '展开侧栏查看工作台' }, '台')
  }

  let body = null
  if (error) body = h('p', { className: 'dsb-mw-error', role: 'alert' }, error)
  else if (!data) body = h('p', { className: 'dsb-mw-muted' }, '加载工作台…')
  else if (tab === 'board') body = h(BoardBody, { data, onAnchor })
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
      title: '已发作品',
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
      title: '互动快照（趋势 SoT）',
      rows: [...data.engagement_snapshots]
        .sort((a, b) => `${b.snapshot_date}`.localeCompare(a.snapshot_date))
        .slice(0, 20)
        .map(e => ({
          id: e.id,
          title: e.title,
          meta: `${e.snapshot_date} · 浏览 ${fmt(e.views)} · 赞 ${fmt(e.likes)}`,
          onClick: () => onAnchor({ kind: 'engagement', id: e.id, title: e.title, tab: 'engagement' }),
        })),
    })
  } else if (tab === 'followers') {
    body = h(ListBody, {
      title: '粉丝',
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
      title: '平台事件',
      rows: data.platform_events.map(e => ({
        id: e.id,
        title: e.name,
        meta: `${e.event_type} · ${e.occurred_at}`,
        onClick: () => onAnchor({ kind: 'event', id: e.id, title: e.name, tab: 'events' }),
      })),
    })
  }

  return h('div', { className: `dsb-mw${mobile ? ' mobile' : ''}` },
    h('div', { className: 'dsb-mw-tabs', role: 'tablist', 'aria-label': '号工作台' },
      WORKBENCH_TABS.map(t => h('button', {
        key: t.id,
        type: 'button',
        role: 'tab',
        'aria-selected': tab === t.id,
        className: `dsb-mw-tab${tab === t.id ? ' active' : ''}`,
        onClick: () => onTab(t.id),
      }, t.label))),
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
