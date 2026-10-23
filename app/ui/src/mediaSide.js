import { createElement as h, useEffect, useState } from 'react'
import { fetchMediaManuscript, fetchMediaWorkspace } from './account.js'

const TABS = [
  { id: 'board', label: '看板' },
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

function BoardBody({ data }) {
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
        board.pending_final_review.slice(0, 3).map(p =>
          h('button', { key: p.id, type: 'button', className: 'dsb-mw-item' }, p.title)))
      : null)
}

function ListBody({ title, rows }) {
  return h('div', { className: 'dsb-mw-body' },
    h('div', { className: 'dsb-mw-label' }, title),
    rows.length === 0
      ? h('p', { className: 'dsb-mw-muted' }, '暂无数据')
      : h('ul', { className: 'dsb-mw-list' },
        rows.map(row => h('li', { key: row.id },
          h('strong', null, row.title),
          row.meta ? h('span', { className: 'dsb-mw-muted' }, row.meta) : null))))
}

function ManuscriptBody({ data, onOpen, preview }) {
  return h('div', { className: 'dsb-mw-body' },
    h('div', { className: 'dsb-mw-label' }, '历史稿件'),
    h('p', { className: 'dsb-mw-muted' }, '写作稿 ≠ 发布版'),
    h('ul', { className: 'dsb-mw-list' },
      data.manuscripts.map(m => h('li', { key: m.id },
        h('strong', null, m.title),
        h('span', { className: 'dsb-mw-muted' },
          `${m.status} · 终审 ${m.final_review_passed ? '通过' : '未过'}`),
        h('button', { type: 'button', className: 'dsb-mw-link', onClick: () => onOpen(m.id) }, '看正文')))),
    preview
      ? h('pre', { className: 'dsb-mw-preview' }, preview.body || '（无写作稿）')
      : null)
}

/**
 * Side workbench: tabs on top, SoT content below. Sits above session list; chat stays main.
 */
export function MediaSidePanel({ wide }) {
  const [tab, setTab] = useState('board')
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState(null)

  useEffect(() => {
    let stopped = false
    fetchMediaWorkspace()
      .then((result) => { if (!stopped) { setData(result.workspace); setError('') } })
      .catch((failure) => { if (!stopped) setError(failure?.message ?? '工作台加载失败') })
    return () => { stopped = true }
  }, [])

  const openManuscript = async (id) => {
    if (!data) return
    try {
      const res = await fetchMediaManuscript(data.account.id, id)
      setPreview({ id, title: res.manuscript.title, body: res.body })
      setTab('manuscripts')
    } catch (failure) {
      setError(failure?.message ?? '读稿失败')
    }
  }

  if (!wide) {
    return h('div', { className: 'dsb-mw-rail', title: '展开侧栏查看工作台' }, '台')
  }

  let body = null
  if (error) body = h('p', { className: 'dsb-mw-error', role: 'alert' }, error)
  else if (!data) body = h('p', { className: 'dsb-mw-muted' }, '加载工作台…')
  else if (tab === 'board') body = h(BoardBody, { data })
  else if (tab === 'manuscripts') body = h(ManuscriptBody, { data, onOpen: openManuscript, preview })
  else if (tab === 'published') {
    body = h(ListBody, {
      title: '已发作品',
      rows: data.published_works.map(p => ({
        id: p.id,
        title: p.title,
        meta: `浏览 ${fmt(p.metrics_views)} · 赞 ${fmt(p.metrics_likes)}`,
      })),
    })
  } else if (tab === 'engagement') {
    body = h(ListBody, {
      title: '互动快照（趋势 SoT）',
      rows: [...data.engagement_snapshots]
        .sort((a, b) => `${b.snapshot_date}`.localeCompare(a.snapshot_date))
        .slice(0, 12)
        .map(e => ({
          id: e.id,
          title: e.title,
          meta: `${e.snapshot_date} · 浏览 ${fmt(e.views)} · 赞 ${fmt(e.likes)}`,
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
      })),
    })
  }

  return h('div', { className: 'dsb-mw' },
    h('div', { className: 'dsb-mw-tabs', role: 'tablist', 'aria-label': '号工作台' },
      TABS.map(t => h('button', {
        key: t.id,
        type: 'button',
        role: 'tab',
        'aria-selected': tab === t.id,
        className: `dsb-mw-tab${tab === t.id ? ' active' : ''}`,
        onClick: () => setTab(t.id),
      }, t.label))),
    body)
}
