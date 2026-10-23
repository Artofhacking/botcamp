import { createElement as h, useEffect, useMemo, useState } from 'react'
import { fetchMediaManuscript, fetchMediaWorkspace } from './account.js'

const TABS = [
  { id: 'board', label: '运营看板' },
  { id: 'posts', label: '帖子 / 选题' },
  { id: 'manuscripts', label: '历史稿件' },
  { id: 'published', label: '已发作品' },
  { id: 'engagement', label: '互动快照' },
  { id: 'followers', label: '粉丝' },
  { id: 'revenue', label: '收益' },
  { id: 'events', label: '平台事件' },
]

function fmt(n) {
  if (n == null) return '—'
  return Number(n).toLocaleString('zh-CN')
}

function statusClass(status) {
  if (status === '已发布') return 'dsb-media-badge pub'
  if (status === '写稿中' || status === '待确认') return 'dsb-media-badge draft'
  return 'dsb-media-badge'
}

function Stat({ label, value }) {
  return h('div', { className: 'dsb-media-stat' },
    h('div', { className: 'dsb-media-stat-label' }, label),
    h('div', { className: 'dsb-media-stat-value' }, value))
}

function BoardTab({ data }) {
  const { board } = data
  return h('div', { className: 'dsb-media-section' },
    h('div', { className: 'dsb-media-stats' },
      h(Stat, { label: '收益 KPI（¥）', value: board.revenue_kpi_cny }),
      h(Stat, { label: '粉丝（最新）', value: fmt(board.followers_latest?.followers) }),
      h(Stat, { label: '互动快照', value: board.trend_hint.snapshot_count }),
      h(Stat, { label: '帖子总数', value: data.posts.length })),
    board.positioning ? h('div', { className: 'dsb-media-card' },
      h('h3', null, board.positioning.what_it_is),
      h('p', null, board.positioning.goal),
      board.positioning.redlines_summary
        ? h('p', { className: 'dsb-media-muted' }, `红线：${board.positioning.redlines_summary}`)
        : null) : null,
    h('h3', null, board.publish_window ? `规矩 · 发帖窗口 ${board.publish_window}` : '规矩'),
    h('div', { className: 'dsb-media-pills' },
      (board.rules_enabled || []).map(r => h('span', { key: r.rule_id, className: 'dsb-media-pill' }, r.label))),
    h('h3', null, '帖子漏斗'),
    h('div', { className: 'dsb-media-stats' },
      Object.entries(board.post_funnel || {}).map(([k, v]) => h(Stat, { key: k, label: k, value: v }))),
    h('h3', null, '近作当前镜像（非趋势）'),
    h('ul', { className: 'dsb-media-list' },
      (board.recent_published_mirror || []).map(p => h('li', { key: p.id },
        h('strong', null, p.url
          ? h('a', { href: p.url, target: '_blank', rel: 'noreferrer' }, p.title)
          : p.title),
        h('span', { className: 'dsb-media-muted' },
          `浏览 ${fmt(p.metrics_views)} · 赞 ${fmt(p.metrics_likes)} · ${p.note}`)))),
    h('p', { className: 'dsb-media-muted' }, board.revenue_kpi_note))
}

function PostsTab({ data }) {
  return h('div', { className: 'dsb-media-table-wrap' },
    h('table', { className: 'dsb-media-table' },
      h('thead', null, h('tr', null,
        h('th', null, '标题'), h('th', null, '状态'), h('th', null, '类型'),
        h('th', null, '浏览'), h('th', null, '赞'))),
      h('tbody', null, data.posts.map(p => h('tr', { key: p.id },
        h('td', null,
          h('div', null, p.title),
          p.url ? h('a', { href: p.url, target: '_blank', rel: 'noreferrer' }, '链接') : null),
        h('td', null, h('span', { className: statusClass(p.status) }, p.status)),
        h('td', null, p.content_type),
        h('td', null, fmt(p.metrics_views)),
        h('td', null, fmt(p.metrics_likes)))))))
}

function ManuscriptsTab({ data, onOpen, preview }) {
  return h('div', { className: 'dsb-media-section' },
    h('p', { className: 'dsb-media-muted' }, '写作稿 ≠ 发布版。空正文页合法。'),
    h('ul', { className: 'dsb-media-list' },
      data.manuscripts.map(m => h('li', { key: m.id },
        h('strong', null, m.title),
        h('span', { className: 'dsb-media-muted' },
          `${m.status} · ${m.archive_bucket} · 终审 ${m.final_review_passed ? '通过' : '未过'}`),
        h('button', { type: 'button', className: 'dsb-media-link', onClick: () => onOpen(m.id) }, '查看稿正文')))),
    preview ? h('div', { className: 'dsb-media-preview' },
      h('h3', null, `预览：${preview.title}`),
      h('pre', null, preview.body || '（无写作稿）'),
      preview.published_edition
        ? h('div', null,
          h('h3', null, '发布版节'),
          h('pre', null, preview.published_edition))
        : null) : null)
}

function PublishedTab({ data }) {
  return h('div', { className: 'dsb-media-table-wrap' },
    h('table', { className: 'dsb-media-table' },
      h('thead', null, h('tr', null,
        h('th', null, '标题'), h('th', null, '发布时间'), h('th', null, '浏览'),
        h('th', null, '赞'), h('th', null, '稿'))),
      h('tbody', null, data.published_works.map(p => h('tr', { key: p.id },
        h('td', null, p.url
          ? h('a', { href: p.url, target: '_blank', rel: 'noreferrer' }, p.title)
          : p.title),
        h('td', null, p.published_at || '—'),
        h('td', null, fmt(p.metrics_views)),
        h('td', null, fmt(p.metrics_likes)),
        h('td', null, p.manuscript_id ? '有' : '空（合法）'))))))
}

function EngagementTab({ data }) {
  const rows = useMemo(() => [...data.engagement_snapshots].sort((a, b) =>
    `${b.snapshot_date}${b.title}`.localeCompare(`${a.snapshot_date}${a.title}`)), [data])
  return h('div', { className: 'dsb-media-section' },
    h('p', { className: 'dsb-media-muted' },
      `趋势 SoT：每日追加。日期 ${data.board.trend_hint.latest_dates.join('、') || '—'}`),
    h('div', { className: 'dsb-media-table-wrap' },
      h('table', { className: 'dsb-media-table' },
        h('thead', null, h('tr', null,
          h('th', null, '日期'), h('th', null, '标题'), h('th', null, '浏览'),
          h('th', null, '赞'), h('th', null, '评'), h('th', null, '藏'))),
        h('tbody', null, rows.map(e => h('tr', { key: e.id },
          h('td', null, e.snapshot_date),
          h('td', null, e.post_url
            ? h('a', { href: e.post_url, target: '_blank', rel: 'noreferrer' }, e.title)
            : e.title),
          h('td', null, fmt(e.views)),
          h('td', null, fmt(e.likes)),
          h('td', null, fmt(e.comments)),
          h('td', null, fmt(e.favorites))))))))
}

function FollowersTab({ data }) {
  const rows = [...data.follower_snapshots].sort((a, b) => b.record_date.localeCompare(a.record_date))
  return h('div', { className: 'dsb-media-table-wrap' },
    h('table', { className: 'dsb-media-table' },
      h('thead', null, h('tr', null,
        h('th', null, '日期'), h('th', null, '粉丝'), h('th', null, '帖子数'), h('th', null, '获赞与收藏'))),
      h('tbody', null, rows.map(f => h('tr', { key: f.id },
        h('td', null, f.record_date),
        h('td', null, fmt(f.followers)),
        h('td', null, fmt(f.post_count)),
        h('td', null, fmt(f.likes_and_favorites)))))))
}

function RevenueTab({ data }) {
  return h('div', { className: 'dsb-media-section' },
    h('p', { className: 'dsb-media-muted' },
      `KPI ≈ ¥${data.board.revenue_kpi_cny}（${data.board.revenue_kpi_note}）`),
    h('div', { className: 'dsb-media-table-wrap' },
      h('table', { className: 'dsb-media-table' },
        h('thead', null, h('tr', null,
          h('th', null, '记录'), h('th', null, '金额'), h('th', null, '类型'), h('th', null, '时间'))),
        h('tbody', null, data.revenue.map(r => h('tr', { key: r.id },
          h('td', null, r.record_title),
          h('td', null, `${r.amount} ${r.currency}`),
          h('td', null, h('span', { className: 'dsb-media-badge' }, r.revenue_type)),
          h('td', null, r.occurred_at)))))))
}

function EventsTab({ data }) {
  return h('ul', { className: 'dsb-media-list' },
    data.platform_events.map(e => h('li', { key: e.id },
      h('strong', null, h('span', { className: 'dsb-media-badge' }, e.event_type), ' ', e.name),
      h('span', { className: 'dsb-media-muted' },
        e.occurred_at + (e.related_title ? ` · ${e.related_title}` : '')),
      e.remark ? h('span', { className: 'dsb-media-muted' }, e.remark) : null)))
}

export function MediaWorkbench({ user, onClose }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [tab, setTab] = useState('board')
  const [preview, setPreview] = useState(null)

  useEffect(() => {
    let stopped = false
    fetchMediaWorkspace()
      .then((result) => { if (!stopped) setData(result.workspace) })
      .catch((failure) => { if (!stopped) setError(failure?.message ?? '加载失败') })
    return () => { stopped = true }
  }, [])

  const openManuscript = async (id) => {
    if (!data) return
    try {
      const res = await fetchMediaManuscript(data.account.id, id)
      setPreview({
        id,
        title: res.manuscript.title,
        body: res.body,
        published_edition: res.published_edition,
      })
    } catch (failure) {
      setError(failure?.message ?? '读稿失败')
    }
  }

  const account = data?.account
  const platformLabel = account?.platform === 'xiaoheihe' ? '小黑盒' : (account?.platform || '')

  return h('div', { className: 'dsb-media' },
    h('header', { className: 'dsb-media-head' },
      h('div', { className: 'dsb-media-head-text' },
        h('div', { className: 'dsb-media-brand' }, 'BotCamp · 自媒体账号'),
        h('h1', null, account?.display_name || (error ? '自媒体账号' : '加载中…')),
        account ? h('div', { className: 'dsb-media-meta' },
          h('span', { className: 'dsb-media-pill ok' }, `${platformLabel} · ${account.platform}`),
          h('span', { className: 'dsb-media-pill' }, account.status),
          h('span', { className: 'dsb-media-pill' }, `业务线 ${account.biz_line_tag}`),
          user?.email ? h('span', { className: 'dsb-media-pill' }, user.email) : null)
          : null),
      h('button', { type: 'button', className: 'dsb-media-back', onClick: onClose }, '返回对话')),
    error ? h('div', { className: 'dsb-auth-error', role: 'alert' }, error) : null,
    !data && !error ? h('p', { className: 'dsb-media-loading' }, '正在打开工作台…') : null,
    data ? h('nav', { className: 'dsb-media-tabs', 'aria-label': '工作台分区' },
      TABS.map(t => h('button', {
        key: t.id,
        type: 'button',
        className: `dsb-media-tab${tab === t.id ? ' active' : ''}`,
        onClick: () => setTab(t.id),
      }, t.label))) : null,
    data ? h('main', { className: 'dsb-media-body' },
      tab === 'board' ? h(BoardTab, { data }) : null,
      tab === 'posts' ? h(PostsTab, { data }) : null,
      tab === 'manuscripts' ? h(ManuscriptsTab, { data, onOpen: openManuscript, preview }) : null,
      tab === 'published' ? h(PublishedTab, { data }) : null,
      tab === 'engagement' ? h(EngagementTab, { data }) : null,
      tab === 'followers' ? h(FollowersTab, { data }) : null,
      tab === 'revenue' ? h(RevenueTab, { data }) : null,
      tab === 'events' ? h(EventsTab, { data }) : null) : null)
}
