/**
 * ProcessOn-class whiteboard SoT: boards + freeform canvas objects in host.kv.
 * Archive goes to warehouse (not delete). Bots place lasting content via place().
 */
import crypto from 'node:crypto'
import { kvGet, kvSet } from '../../server/kv.mjs'
import { ensureMediaSeeded, mediaOwnerIdFor } from './mediaControl.mjs'

const SCHEMA = '1.0.0'

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
    title: (title && String(title).trim()) || '未命名白板',
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
    title: '公司白板',
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

function layoutSlot(board, index) {
  const col = index % 3
  const row = Math.floor(index / 3)
  return { x: 80 + col * 280, y: 80 + row * 200, w: 240, h: 140 }
}

function normalizeObject(raw, board) {
  if (!raw || typeof raw !== 'object') return null
  const type = ['rect', 'ellipse', 'diamond', 'text', 'note', 'frame', 'connector'].includes(raw.type)
    ? raw.type
    : 'note'
  const id = typeof raw.id === 'string' && raw.id ? raw.id : newId('obj')
  const stamp = nowIso()
  const existing = (board.objects || []).find((o) => o.id === id)
  const base = existing ? { ...existing } : {
    id,
    type,
    x: 80,
    y: 80,
    w: 200,
    h: 120,
    text: '',
    fill: type === 'frame' ? 'transparent' : '#ffffff',
    stroke: '#334155',
    stroke_width: type === 'frame' ? 1.5 : 1.25,
    parent_id: null,
    from_id: null,
    to_id: null,
    z: (board.objects || []).length,
    created_by: 'user',
    created_at: stamp,
    archived_at: null,
  }
  const next = {
    ...base,
    type,
    x: Number.isFinite(raw.x) ? raw.x : base.x,
    y: Number.isFinite(raw.y) ? raw.y : base.y,
    w: Number.isFinite(raw.w) ? Math.max(40, raw.w) : base.w,
    h: Number.isFinite(raw.h) ? Math.max(28, raw.h) : base.h,
    text: raw.text != null ? String(raw.text) : base.text,
    fill: raw.fill != null ? String(raw.fill) : base.fill,
    stroke: raw.stroke != null ? String(raw.stroke) : base.stroke,
    stroke_width: Number.isFinite(raw.stroke_width) ? raw.stroke_width : base.stroke_width,
    parent_id: raw.parent_id === undefined ? base.parent_id : raw.parent_id,
    from_id: raw.from_id === undefined ? base.from_id : raw.from_id,
    to_id: raw.to_id === undefined ? base.to_id : raw.to_id,
    z: Number.isFinite(raw.z) ? raw.z : base.z,
    created_by: raw.created_by || base.created_by,
    updated_at: stamp,
    archived_at: raw.archived_at === undefined ? base.archived_at : raw.archived_at,
  }
  if (type === 'connector') {
    next.w = 0
    next.h = 0
  }
  return next
}

function publicBoard(board, { includeArchived = false } = {}) {
  const objects = (board.objects || []).filter((o) => includeArchived || !o.archived_at)
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
  return {
    board_id: board.id,
    object_id: object.id,
    board_title: board.title,
    href: `board://${board.id}/${object.id}`,
    label: `白板·${board.title}`,
  }
}

/** Place lasting bot content with non-overlapping layout. */
export function placeOnBoard(ownerId, {
  sessionId,
  boardId,
  title,
  body,
  category,
  type = 'note',
  createdBy = 'bot',
} = {}) {
  ensureMediaSeeded()
  let board = boardId ? loadBoard(ownerId, boardId) : null
  if (!board) board = resolveDefaultBoard(ownerId, sessionId)
  if (category != null && board.category == null) board.category = String(category) || null
  if (sessionId && !board.session_id) board.session_id = sessionId
  const active = (board.objects || []).filter((o) => !o.archived_at && o.type !== 'connector')
  const slot = layoutSlot(board, active.length)
  const text = [title, body].filter(Boolean).join('\n\n')
  const object = normalizeObject({
    type: type === 'rect' || type === 'ellipse' || type === 'text' || type === 'frame' ? type : 'note',
    x: slot.x,
    y: slot.y,
    w: slot.w,
    h: Math.max(slot.h, Math.min(320, 60 + String(text).split('\n').length * 18)),
    text,
    fill: type === 'frame' ? 'transparent' : '#f8fafc',
    stroke: '#0f172a',
    created_by: createdBy,
  }, board)
  board.objects = [...(board.objects || []), object]
  saveBoard(board)
  rememberOpen(ownerId, board.id, sessionId)
  return { board: publicBoard(board), object, link: linkFor(board, object) }
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
      return { status: 404, body: { ok: false, error: { message: '白板不存在' } } }
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
    if (!board) return { status: 404, body: { ok: false, error: { message: '白板不存在' } } }
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
    if (!board) return { status: 404, body: { ok: false, error: { message: '白板不存在' } } }
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
    if (!board) return { status: 404, body: { ok: false, error: { message: '白板不存在' } } }
    const ids = new Set(Array.isArray(payload?.objectIds) ? payload.objectIds : [payload?.objectId].filter(Boolean))
    const stamp = nowIso()
    board.objects = (board.objects || []).map((o) => (ids.has(o.id) ? { ...o, archived_at: stamp, updated_at: stamp } : o))
    saveBoard(board)
    return { status: 200, body: { ok: true, board: publicBoard(board) } }
  }

  if (endpoint === 'whiteboard/objects/restore') {
    const board = loadBoard(ownerId, payload?.boardId)
    if (!board) return { status: 404, body: { ok: false, error: { message: '白板不存在' } } }
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
          object: o,
        })
      }
    }
    items.sort((a, b) => String(b.object.archived_at).localeCompare(String(a.object.archived_at)))
    return { status: 200, body: { ok: true, items } }
  }

  if (endpoint === 'whiteboard/place') {
    const placed = placeOnBoard(ownerId, {
      sessionId: payload?.sessionId,
      boardId: payload?.boardId,
      title: payload?.title,
      body: payload?.body,
      category: payload?.category,
      type: payload?.type,
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
