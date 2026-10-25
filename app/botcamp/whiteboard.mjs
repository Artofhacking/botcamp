/**
 * Whiteboard SoT: infinite canvas of readable components only —
 * table / article / icon. Archive → warehouse (not delete).
 * Bots place kanban status via placeKanban / place().
 */
import crypto from 'node:crypto'
import { kvGet, kvSet } from '../../server/kv.mjs'
import { ensureMediaSeeded, mediaOwnerIdFor } from './mediaControl.mjs'

const SCHEMA = '1.1.0'
const COMPONENT_TYPES = Object.freeze(['table', 'article', 'icon'])
const LEGACY_SHAPE_TYPES = new Set(['rect', 'ellipse', 'diamond', 'text', 'note', 'frame', 'connector'])

function nowIso() {
  return new Date().toISOString()
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`
}

function boardsIndexKey(ownerId) {
  return `whiteboard:${ownerId}:boards`
}

function boardKey(ownerId, boardId) {
  return `whiteboard:${ownerId}:board:${boardId}`
}

function prefsKey(ownerId) {
  return `whiteboard:${ownerId}:prefs`
}

function listBoardMeta(ownerId) {
  const ids = kvGet(boardsIndexKey(ownerId)) || []
  return ids
    .map((id) => kvGet(boardKey(ownerId, id)))
    .filter((b) => b && !b.deleted_at)
    .map((b) => ({
      id: b.id,
      title: b.title,
      category: b.category ?? null,
      session_id: b.session_id ?? null,
      object_count: (b.objects || []).filter((o) => !o.archived_at).length,
      archived_count: (b.objects || []).filter((o) => o.archived_at).length,
      updated_at: b.updated_at,
      created_at: b.created_at,
    }))
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
}

function loadBoard(ownerId, boardId) {
  const board = kvGet(boardKey(ownerId, boardId))
  if (!board || board.deleted_at || board.owner_user_id !== ownerId) return null
  return board
}

function saveBoard(board) {
  board.updated_at = nowIso()
  board.version = (board.version || 0) + 1
  kvSet(boardKey(board.owner_user_id, board.id), board)
  return board
}

function defaultCamera() {
  return { x: 0, y: 0, zoom: 1 }
}

function createBoardRecord(ownerId, { title, category, sessionId } = {}) {
  const stamp = nowIso()
  const id = newId('wb')
  const board = {
    id,
    owner_user_id: ownerId,
    title: (title && String(title).trim()) || '未命名看板',
    category: category == null || category === '' ? null : String(category),
    session_id: sessionId || null,
    camera: defaultCamera(),
    objects: [],
    schema_version: SCHEMA,
    version: 1,
    created_at: stamp,
    updated_at: stamp,
    deleted_at: null,
  }
  const ids = kvGet(boardsIndexKey(ownerId)) || []
  ids.unshift(id)
  kvSet(boardsIndexKey(ownerId), ids)
  kvSet(boardKey(ownerId, id), board)
  const prefs = kvGet(prefsKey(ownerId)) || { owner_user_id: ownerId }
  prefs.last_board_id = id
  if (sessionId) {
    prefs.session_boards = { ...(prefs.session_boards || {}), [sessionId]: id }
  }
  prefs.updated_at = stamp
  kvSet(prefsKey(ownerId), prefs)
  return board
}

function resolveDefaultBoard(ownerId, sessionId) {
  const prefs = kvGet(prefsKey(ownerId)) || {}
  if (sessionId && prefs.session_boards?.[sessionId]) {
    const b = loadBoard(ownerId, prefs.session_boards[sessionId])
    if (b) return b
  }
  if (prefs.last_board_id) {
    const b = loadBoard(ownerId, prefs.last_board_id)
    if (b) return b
  }
  const list = listBoardMeta(ownerId)
  if (list[0]) return loadBoard(ownerId, list[0].id)
  return createBoardRecord(ownerId, {
    title: '公司看板',
    category: null,
    sessionId: sessionId || null,
  })
}

function rememberOpen(ownerId, boardId, sessionId) {
  const prefs = kvGet(prefsKey(ownerId)) || { owner_user_id: ownerId }
  prefs.last_board_id = boardId
  if (sessionId) {
    prefs.session_boards = { ...(prefs.session_boards || {}), [sessionId]: boardId }
  }
  prefs.updated_at = nowIso()
  kvSet(prefsKey(ownerId), prefs)
}

function coerceType(rawType) {
  if (COMPONENT_TYPES.includes(rawType)) return rawType
  if (LEGACY_SHAPE_TYPES.has(rawType)) return 'article'
  return 'article'
}

function defaultSize(type) {
  if (type === 'table') return { w: 360, h: 220 }
  if (type === 'icon') return { w: 140, h: 48 }
  return { w: 240, h: 140 }
}

function normalizeObject(raw, board) {
  if (!raw || typeof raw !== 'object') return null
  const type = coerceType(raw.type)
  const id = typeof raw.id === 'string' && raw.id ? raw.id : newId('obj')
  const stamp = nowIso()
  const existing = (board.objects || []).find((o) => o.id === id)
  const size = defaultSize(type)
  const base = existing ? { ...existing } : {
    id,
    type,
    x: 80,
    y: 80,
    w: size.w,
    h: size.h,
    title: '',
    body: '',
    text: '',
    icon: 'marker',
    label: '',
    columns: [],
    rows: [],
    z: (board.objects || []).length,
    created_by: 'user',
    created_at: stamp,
    archived_at: null,
  }
  const title = raw.title != null ? String(raw.title) : (base.title || '')
  const body = raw.body != null ? String(raw.body) : (base.body || '')
  let text = raw.text != null ? String(raw.text) : base.text
  if (!text) text = [title, body].filter(Boolean).join('\n')
  const columns = Array.isArray(raw.columns)
    ? raw.columns.map((c) => String(c))
    : (Array.isArray(base.columns) ? base.columns : [])
  const rows = Array.isArray(raw.rows)
    ? raw.rows.map((row) => (Array.isArray(row) ? row.map((cell) => (cell == null ? '' : String(cell))) : [String(row)]))
    : (Array.isArray(base.rows) ? base.rows : [])
  const label = raw.label != null ? String(raw.label) : (base.label || title || '')
  const icon = raw.icon != null ? String(raw.icon) : (base.icon || 'marker')
  return {
    ...base,
    type,
    x: Number.isFinite(raw.x) ? raw.x : base.x,
    y: Number.isFinite(raw.y) ? raw.y : base.y,
    w: Number.isFinite(raw.w) ? Math.max(48, raw.w) : base.w,
    h: Number.isFinite(raw.h) ? Math.max(36, raw.h) : base.h,
    title,
    body,
    text,
    icon,
    label,
    columns,
    rows,
    z: Number.isFinite(raw.z) ? raw.z : base.z,
    created_by: raw.created_by || base.created_by,
    updated_at: stamp,
    archived_at: raw.archived_at === undefined ? base.archived_at : raw.archived_at,
  }
}

function scrubCopy(value) {
  if (typeof value !== 'string') return value
  return value
    .replaceAll('进度汇报', '看板更新')
    .replaceAll('总负责人报表', '总负责人看板')
    .replaceAll('报表', '看板')
}

function publicBoard(board, { includeArchived = false } = {}) {
  const objects = (board.objects || [])
    .filter((o) => includeArchived || !o.archived_at)
    .map((o) => {
      const n = normalizeObject(o, board) || o
      return {
        ...n,
        title: scrubCopy(n.title),
        body: scrubCopy(n.body),
        text: scrubCopy(n.text),
        label: scrubCopy(n.label),
      }
    })
  return {
    id: board.id,
    title: board.title,
    category: board.category,
    session_id: board.session_id,
    camera: board.camera || defaultCamera(),
    objects,
    updated_at: board.updated_at,
    created_at: board.created_at,
    schema_version: board.schema_version,
  }
}

function linkFor(board, object) {
  const labelBit = object.title || object.label || object.type
  return {
    board_id: board.id,
    object_id: object.id,
    board_title: board.title,
    href: `board://${board.id}/${object.id}`,
    label: `看板·${board.title}·${labelBit}`.slice(0, 48),
  }
}

function appendObjects(board, drafts) {
  const next = []
  for (const raw of drafts) {
    const obj = normalizeObject(raw, { ...board, objects: [...(board.objects || []), ...next] })
    if (obj) next.push(obj)
  }
  board.objects = [...(board.objects || []), ...next]
  return next
}

/** Place one readable component (table / article / icon only). */
export function placeOnBoard(ownerId, {
  sessionId,
  boardId,
  title,
  body,
  category,
  type = 'article',
  icon,
  label,
  columns,
  rows,
  x,
  y,
  w,
  h,
  createdBy = 'bot',
} = {}) {
  ensureMediaSeeded()
  let board = boardId ? loadBoard(ownerId, boardId) : null
  if (!board) board = resolveDefaultBoard(ownerId, sessionId)
  if (category != null && board.category == null) board.category = String(category) || null
  if (sessionId && !board.session_id) board.session_id = sessionId
  const active = (board.objects || []).filter((o) => !o.archived_at)
  const col = active.length % 3
  const row = Math.floor(active.length / 3)
  const size = defaultSize(coerceType(type))
  const [object] = appendObjects(board, [{
    type: coerceType(type),
    x: Number.isFinite(x) ? x : 80 + col * 280,
    y: Number.isFinite(y) ? y : 80 + row * 180,
    w: Number.isFinite(w) ? w : size.w,
    h: Number.isFinite(h) ? h : size.h,
    title: title || '',
    body: body || '',
    text: [title, body].filter(Boolean).join('\n\n'),
    icon: icon || 'marker',
    label: label || title || '',
    columns: columns || [],
    rows: rows || [],
    created_by: createdBy,
  }])
  saveBoard(board)
  rememberOpen(ownerId, board.id, sessionId)
  return { board: publicBoard(board), object, link: linkFor(board, object) }
}

/**
 * Place a kanban of real items: column icons + article cards + one summary table.
 * `columns`: [{ name, icon, items: [{ title, body }] }]
 */
export function placeKanban(ownerId, {
  sessionId,
  boardId,
  category,
  heading,
  columns = [],
  table,
  createdBy = 'bot',
} = {}) {
  ensureMediaSeeded()
  let board = boardId ? loadBoard(ownerId, boardId) : null
  if (!board) board = resolveDefaultBoard(ownerId, sessionId)
  if (category != null) board.category = String(category) || null
  if (sessionId && !board.session_id) board.session_id = sessionId

  const stamp = nowIso()
  // Archive prior non-user components so the board stays current (warehouse, not delete).
  board.objects = (board.objects || []).map((o) => (
    !o.archived_at && o.created_by !== 'user'
      ? { ...o, archived_at: stamp, updated_at: stamp }
      : o
  ))

  const drafts = []
  const colW = 260
  const gap = 28
  const originX = 48
  const originY = 48

  if (heading) {
    drafts.push({
      type: 'article',
      x: originX,
      y: originY - 8,
      w: Math.max(320, columns.length * (colW + gap) - gap),
      h: 64,
      title: heading,
      body: '看板组件：表格 · 文章 · 图标。数字来自 MediaAccount SoT。',
      created_by: createdBy,
    })
  }

  columns.forEach((col, i) => {
    const x = originX + i * (colW + gap)
    drafts.push({
      type: 'icon',
      x,
      y: originY + 72,
      w: colW - 20,
      h: 44,
      icon: col.icon || 'column',
      label: col.name,
      title: col.name,
      created_by: createdBy,
    })
    const items = Array.isArray(col.items) ? col.items : []
    items.slice(0, 8).forEach((item, j) => {
      drafts.push({
        type: 'article',
        x,
        y: originY + 132 + j * 128,
        w: colW - 20,
        h: 112,
        title: item.title || '未命名',
        body: item.body || '',
        created_by: createdBy,
      })
    })
    if (items.length === 0) {
      drafts.push({
        type: 'article',
        x,
        y: originY + 132,
        w: colW - 20,
        h: 72,
        title: '（空）',
        body: '这一栏暂时没有条目。',
        created_by: createdBy,
      })
    }
  })

  if (table && Array.isArray(table.columns) && Array.isArray(table.rows)) {
    drafts.push({
      type: 'table',
      x: originX,
      y: originY + 132 + 8 * 128 + 24,
      w: Math.max(360, columns.length * (colW + gap) - gap),
      h: 48 + Math.max(1, table.rows.length) * 28,
      title: table.title || '汇总表',
      columns: table.columns,
      rows: table.rows,
      created_by: createdBy,
    })
  }

  const placed = appendObjects(board, drafts)
  saveBoard(board)
  rememberOpen(ownerId, board.id, sessionId)
  const focus = placed.find((o) => o.type === 'table') || placed[0]
  return {
    board: publicBoard(board),
    objects: placed,
    object: focus,
    link: focus ? linkFor(board, focus) : null,
  }
}

function ownerFrom(req, botcampUser) {
  ensureMediaSeeded()
  if (botcampUser?.id) return mediaOwnerIdFor(botcampUser)
  return null
}

export function handleWhiteboardControl(req, endpoint, payload, botcampUser) {
  const ownerId = ownerFrom(req, botcampUser)
  if (!ownerId) {
    return { status: 401, body: { ok: false, error: { code: 'auth/required', message: '请先登录' } } }
  }

  if (endpoint === 'whiteboard/list') {
    return {
      status: 200,
      body: {
        ok: true,
        boards: listBoardMeta(ownerId),
        prefs: kvGet(prefsKey(ownerId)) || {},
      },
    }
  }

  if (endpoint === 'whiteboard/get') {
    const boardId = payload?.boardId
    const board = boardId ? loadBoard(ownerId, boardId) : resolveDefaultBoard(ownerId, payload?.sessionId)
    if (!board) {
      return { status: 404, body: { ok: false, error: { message: '看板不存在' } } }
    }
    rememberOpen(ownerId, board.id, payload?.sessionId)
    return {
      status: 200,
      body: {
        ok: true,
        board: publicBoard(board, { includeArchived: payload?.includeArchived === true }),
      },
    }
  }

  if (endpoint === 'whiteboard/create') {
    const board = createBoardRecord(ownerId, {
      title: payload?.title,
      category: payload?.category,
      sessionId: payload?.sessionId,
    })
    return { status: 200, body: { ok: true, board: publicBoard(board) } }
  }

  if (endpoint === 'whiteboard/update') {
    const board = loadBoard(ownerId, payload?.boardId)
    if (!board) return { status: 404, body: { ok: false, error: { message: '看板不存在' } } }
    if (payload?.title != null) board.title = String(payload.title).trim() || board.title
    if (payload?.category !== undefined) {
      board.category = payload.category == null || payload.category === '' ? null : String(payload.category)
    }
    if (payload?.sessionId !== undefined) board.session_id = payload.sessionId || null
    if (payload?.camera && typeof payload.camera === 'object') {
      board.camera = {
        x: Number(payload.camera.x) || 0,
        y: Number(payload.camera.y) || 0,
        zoom: Math.min(3, Math.max(0.2, Number(payload.camera.zoom) || 1)),
      }
    }
    saveBoard(board)
    rememberOpen(ownerId, board.id, payload?.sessionId)
    return { status: 200, body: { ok: true, board: publicBoard(board) } }
  }

  if (endpoint === 'whiteboard/objects/upsert') {
    const board = loadBoard(ownerId, payload?.boardId)
    if (!board) return { status: 404, body: { ok: false, error: { message: '看板不存在' } } }
    const items = Array.isArray(payload?.objects) ? payload.objects : [payload?.object].filter(Boolean)
    const byId = new Map((board.objects || []).map((o) => [o.id, o]))
    const touched = []
    for (const raw of items) {
      const obj = normalizeObject(raw, board)
      if (!obj) continue
      byId.set(obj.id, obj)
      touched.push(obj)
    }
    board.objects = [...byId.values()].sort((a, b) => (a.z || 0) - (b.z || 0))
    saveBoard(board)
    return {
      status: 200,
      body: { ok: true, board: publicBoard(board), objects: touched },
    }
  }

  if (endpoint === 'whiteboard/objects/archive') {
    const board = loadBoard(ownerId, payload?.boardId)
    if (!board) return { status: 404, body: { ok: false, error: { message: '看板不存在' } } }
    const ids = new Set(Array.isArray(payload?.objectIds) ? payload.objectIds : [payload?.objectId].filter(Boolean))
    const stamp = nowIso()
    board.objects = (board.objects || []).map((o) => (ids.has(o.id) ? { ...o, archived_at: stamp, updated_at: stamp } : o))
    saveBoard(board)
    return { status: 200, body: { ok: true, board: publicBoard(board) } }
  }

  if (endpoint === 'whiteboard/objects/restore') {
    const board = loadBoard(ownerId, payload?.boardId)
    if (!board) return { status: 404, body: { ok: false, error: { message: '看板不存在' } } }
    const ids = new Set(Array.isArray(payload?.objectIds) ? payload.objectIds : [payload?.objectId].filter(Boolean))
    const stamp = nowIso()
    board.objects = (board.objects || []).map((o) => (ids.has(o.id) ? { ...o, archived_at: null, updated_at: stamp } : o))
    saveBoard(board)
    return { status: 200, body: { ok: true, board: publicBoard(board, { includeArchived: true }) } }
  }

  if (endpoint === 'whiteboard/warehouse') {
    const boards = listBoardMeta(ownerId)
    const items = []
    for (const meta of boards) {
      const board = loadBoard(ownerId, meta.id)
      if (!board) continue
      for (const o of board.objects || []) {
        if (!o.archived_at) continue
        items.push({
          board_id: board.id,
          board_title: board.title,
          object: normalizeObject(o, board) || o,
        })
      }
    }
    items.sort((a, b) => String(b.object.archived_at).localeCompare(String(a.object.archived_at)))
    return { status: 200, body: { ok: true, items } }
  }

  if (endpoint === 'whiteboard/place') {
    if (payload?.kanban || Array.isArray(payload?.columns)) {
      const placed = placeKanban(ownerId, {
        sessionId: payload?.sessionId,
        boardId: payload?.boardId,
        category: payload?.category,
        heading: payload?.heading || payload?.title,
        columns: payload?.columns || payload?.kanban?.columns,
        table: payload?.table || payload?.kanban?.table,
        createdBy: payload?.createdBy || 'bot',
      })
      return { status: 200, body: { ok: true, ...placed } }
    }
    const placed = placeOnBoard(ownerId, {
      sessionId: payload?.sessionId,
      boardId: payload?.boardId,
      title: payload?.title,
      body: payload?.body,
      category: payload?.category,
      type: payload?.type,
      icon: payload?.icon,
      label: payload?.label,
      columns: payload?.columns,
      rows: payload?.rows,
      x: payload?.x,
      y: payload?.y,
      w: payload?.w,
      h: payload?.h,
      createdBy: payload?.createdBy || 'bot',
    })
    return { status: 200, body: { ok: true, ...placed } }
  }

  return { status: 404, body: { ok: false, error: { message: '未知的白板接口。' } } }
}

export const WHITEBOARD_CONTROL = Object.freeze([
  'whiteboard/list',
  'whiteboard/get',
  'whiteboard/create',
  'whiteboard/update',
  'whiteboard/objects/upsert',
  'whiteboard/objects/archive',
  'whiteboard/objects/restore',
  'whiteboard/warehouse',
  'whiteboard/place',
])
