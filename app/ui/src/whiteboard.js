import { createElement as h, useCallback, useEffect, useRef, useState } from 'react'
import {
  archiveObjects,
  createBoard,
  getBoard,
  listBoards,
  listWarehouse,
  parseBoardHref,
  restoreObjects,
  updateBoard,
  upsertObjects,
} from './whiteboardApi.js'

const TOOLS = [
  { id: 'select', label: '选择' },
  { id: 'pan', label: '平移' },
  { id: 'table', label: '表格' },
  { id: 'article', label: '文章' },
  { id: 'icon', label: '图标' },
]

const ICON_GLYPH = {
  column: '▣',
  post: '✎',
  draft: '◌',
  alert: '!',
  ok: '✓',
  marker: '●',
}

function iconGlyph(name) {
  return ICON_GLYPH[name] || ICON_GLYPH.marker
}

function TableView({ obj }) {
  const columns = Array.isArray(obj.columns) && obj.columns.length ? obj.columns : ['列']
  const rows = Array.isArray(obj.rows) ? obj.rows : []
  return h('div', { className: 'wb-comp wb-table' },
    obj.title ? h('div', { className: 'wb-comp-title' }, obj.title) : null,
    h('table', null,
      h('thead', null, h('tr', null, columns.map((c, i) => h('th', { key: i }, c)))),
      h('tbody', null,
        rows.length
          ? rows.map((row, ri) => h('tr', { key: ri },
            columns.map((_, ci) => h('td', { key: ci }, row[ci] ?? ''))))
          : h('tr', null, h('td', { colSpan: columns.length }, '（无行）')))))
}

function ArticleView({ obj }) {
  return h('div', { className: 'wb-comp wb-article' },
    h('div', { className: 'wb-comp-title' }, obj.title || '文章'),
    h('div', { className: 'wb-comp-body' }, obj.body || obj.text || ''))
}

function IconView({ obj }) {
  return h('div', { className: 'wb-comp wb-icon' },
    h('span', { className: 'wb-icon-glyph', 'aria-hidden': true }, iconGlyph(obj.icon)),
    h('span', { className: 'wb-icon-label' }, obj.label || obj.title || '标记'))
}

function CanvasObject({ obj, selected, onPointerDown }) {
  if (obj.archived_at) return null
  let body = null
  if (obj.type === 'table') body = h(TableView, { obj })
  else if (obj.type === 'icon') body = h(IconView, { obj })
  else body = h(ArticleView, { obj })
  return h('div', {
    className: `wb-node${selected ? ' selected' : ''}`,
    'data-id': obj.id,
    'data-type': obj.type,
    style: {
      transform: `translate(${obj.x}px, ${obj.y}px)`,
      width: obj.w,
      minHeight: obj.h,
    },
    onPointerDown: (e) => onPointerDown(e, obj),
  }, body)
}

function World({ objects, selectedId, camera, onPointerDown, onWheel, onPointerMove, onPointerUp, surfaceRef }) {
  const sorted = [...objects].sort((a, b) => (a.z || 0) - (b.z || 0))
  return h('div', {
    ref: surfaceRef,
    className: 'wb-surface',
    onWheel,
    onPointerMove,
    onPointerUp,
    onPointerLeave: onPointerUp,
    onPointerDown: (e) => {
      if (e.target === e.currentTarget || e.target.classList?.contains('wb-world')) onPointerDown(e, null)
    },
  },
    h('div', {
      className: 'wb-world',
      style: { transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})` },
    },
      sorted.map((obj) => h(CanvasObject, {
        key: obj.id,
        obj,
        selected: obj.id === selectedId,
        onPointerDown,
      }))))
}

function blankComponent(type, world) {
  if (type === 'table') {
    return {
      type: 'table',
      x: world.x,
      y: world.y,
      w: 360,
      h: 180,
      title: '新表格',
      columns: ['项目', '状态'],
      rows: [['示例', '进行中']],
      created_by: 'user',
    }
  }
  if (type === 'icon') {
    return {
      type: 'icon',
      x: world.x,
      y: world.y,
      w: 140,
      h: 44,
      icon: 'marker',
      label: '标记',
      title: '标记',
      created_by: 'user',
    }
  }
  return {
    type: 'article',
    x: world.x,
    y: world.y,
    w: 240,
    h: 140,
    title: '新文章',
    body: '在此写正文。',
    created_by: 'user',
  }
}

export function WhiteboardPanel({
  open,
  sessionId,
  focusLink,
  onClose,
  onConsumedFocus,
}) {
  const [boards, setBoards] = useState([])
  const [board, setBoard] = useState(null)
  const [tool, setTool] = useState('select')
  const [selectedId, setSelectedId] = useState(null)
  const [error, setError] = useState('')
  const [picker, setPicker] = useState(false)
  const [warehouse, setWarehouse] = useState(null)
  const [busy, setBusy] = useState(false)
  const drag = useRef(null)
  const surfaceRef = useRef(null)

  const camera = board?.camera || { x: 0, y: 0, zoom: 1 }

  const refreshList = useCallback(async () => {
    const res = await listBoards()
    setBoards(res.boards || [])
    return res
  }, [])

  const load = useCallback(async (boardId, session) => {
    setBusy(true)
    setError('')
    try {
      const res = await getBoard({ boardId, sessionId: session })
      setBoard(res.board)
      await refreshList()
    } catch (failure) {
      setError(failure?.message || '加载看板失败')
    } finally {
      setBusy(false)
    }
  }, [refreshList])

  useEffect(() => {
    if (!open) return undefined
    void load(undefined, sessionId)
  }, [open, sessionId, load])

  useEffect(() => {
    if (!open || !focusLink) return
    const parsed = typeof focusLink === 'string' ? parseBoardHref(focusLink) : focusLink
    if (!parsed?.boardId) return
    void (async () => {
      await load(parsed.boardId, sessionId)
      if (parsed.objectId) {
        setSelectedId(parsed.objectId)
        setTool('select')
      }
      onConsumedFocus?.()
    })()
  }, [open, focusLink, load, sessionId, onConsumedFocus])

  const persistCamera = async (nextCam) => {
    if (!board) return
    setBoard({ ...board, camera: nextCam })
    try {
      await updateBoard({ boardId: board.id, camera: nextCam, sessionId })
    } catch { /* local camera still moves */ }
  }

  const persistObjects = async (objects) => {
    if (!board) return
    const res = await upsertObjects({ boardId: board.id, objects })
    setBoard(res.board)
  }

  const clientToWorld = (event) => {
    const rect = surfaceRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    return {
      x: (event.clientX - rect.left - camera.x) / camera.zoom,
      y: (event.clientY - rect.top - camera.y) / camera.zoom,
    }
  }

  const onWheel = (event) => {
    event.preventDefault()
    const factor = event.deltaY > 0 ? 0.92 : 1.08
    const zoom = Math.min(3, Math.max(0.2, camera.zoom * factor))
    const rect = surfaceRef.current?.getBoundingClientRect()
    if (!rect) return
    const mx = event.clientX - rect.left
    const my = event.clientY - rect.top
    const x = mx - ((mx - camera.x) / camera.zoom) * zoom
    const y = my - ((my - camera.y) / camera.zoom) * zoom
    void persistCamera({ x, y, zoom })
  }

  const onPointerDown = (event, obj) => {
    if (!board) return
    event.stopPropagation()
    const world = clientToWorld(event)
    if (tool === 'pan' || event.button === 1) {
      drag.current = { kind: 'pan', x: event.clientX, y: event.clientY, cam: { ...camera } }
      event.currentTarget?.setPointerCapture?.(event.pointerId)
      return
    }
    if (tool !== 'select' && !obj) {
      const draft = blankComponent(tool, world)
      void (async () => {
        const res = await upsertObjects({ boardId: board.id, objects: [draft] })
        setBoard(res.board)
        const created = res.objects?.[0]
        if (created) setSelectedId(created.id)
        setTool('select')
      })()
      return
    }
    if (obj) {
      setSelectedId(obj.id)
      drag.current = {
        kind: 'move',
        id: obj.id,
        ox: world.x,
        oy: world.y,
        baseX: obj.x,
        baseY: obj.y,
      }
    } else {
      setSelectedId(null)
    }
  }

  const onPointerMove = (event) => {
    const d = drag.current
    if (!d || !board) return
    if (d.kind === 'pan') {
      const next = {
        ...d.cam,
        x: d.cam.x + (event.clientX - d.x),
        y: d.cam.y + (event.clientY - d.y),
      }
      setBoard({ ...board, camera: next })
      return
    }
    if (d.kind === 'move') {
      const world = clientToWorld(event)
      const objects = board.objects.map((o) => (o.id === d.id
        ? { ...o, x: d.baseX + (world.x - d.ox), y: d.baseY + (world.y - d.oy) }
        : o))
      setBoard({ ...board, objects })
    }
  }

  const onPointerUp = async () => {
    const d = drag.current
    drag.current = null
    if (!d || !board) return
    if (d.kind === 'pan') {
      await persistCamera(board.camera)
      return
    }
    if (d.kind === 'move') {
      const obj = board.objects.find((o) => o.id === d.id)
      if (obj) await persistObjects([obj])
    }
  }

  const onCreateBoard = async () => {
    const title = window.prompt('看板名称', '新看板')
    if (title == null) return
    const category = window.prompt('分类（可留空）', '') || null
    const res = await createBoard({ title, category, sessionId })
    setBoard(res.board)
    await refreshList()
    setPicker(false)
  }

  const onArchive = async () => {
    if (!board || !selectedId) return
    const res = await archiveObjects({ boardId: board.id, objectId: selectedId })
    setBoard(res.board)
    setSelectedId(null)
  }

  const openWarehouse = async () => {
    const res = await listWarehouse()
    setWarehouse(res.items || [])
  }

  const onRestore = async (boardId, objectId) => {
    await restoreObjects({ boardId, objectId })
    await openWarehouse()
    if (board?.id === boardId) await load(boardId, sessionId)
  }

  const focusObject = (objectId) => {
    const obj = board?.objects?.find((o) => o.id === objectId)
    if (!obj) return
    setSelectedId(objectId)
    const zoom = camera.zoom || 1
    const x = 120 - obj.x * zoom
    const y = 80 - obj.y * zoom
    void persistCamera({ x, y, zoom })
  }

  const selected = board?.objects?.find((o) => o.id === selectedId) || null

  const patchSelected = (patch) => {
    if (!board || !selected) return
    setBoard({
      ...board,
      objects: board.objects.map((o) => (o.id === selected.id ? { ...o, ...patch } : o)),
    })
  }

  const commitSelected = () => {
    if (!selected) return
    const current = board.objects.find((o) => o.id === selected.id)
    if (current) void persistObjects([current])
  }

  if (!open) return null

  const categories = [...new Set(boards.map((b) => b.category || '未分类'))]

  return h('section', { className: 'wb-panel', 'aria-label': '看板' },
    h('header', { className: 'wb-head' },
      h('button', { type: 'button', className: 'wb-quiet', onClick: () => setPicker((v) => !v) },
        board ? board.title : '选择看板'),
      board?.category ? h('span', { className: 'wb-cat' }, board.category) : null,
      h('div', { className: 'wb-head-actions' },
        h('button', { type: 'button', className: 'wb-quiet', onClick: openWarehouse }, '仓库'),
        h('button', {
          type: 'button',
          className: 'wb-close',
          onClick: onClose,
          'aria-label': '关闭白板',
          title: '关闭白板，恢复对话全宽',
        }, '关闭白板'))),
    picker
      ? h('div', { className: 'wb-picker' },
        h('button', { type: 'button', className: 'wb-primary', onClick: onCreateBoard }, '新建看板'),
        categories.map((cat) => h('div', { key: cat, className: 'wb-picker-group' },
          h('div', { className: 'wb-picker-label' }, cat),
          boards.filter((b) => (b.category || '未分类') === cat).map((b) => h('button', {
            key: b.id,
            type: 'button',
            className: b.id === board?.id ? 'active' : undefined,
            onClick: () => { void load(b.id, sessionId); setPicker(false) },
          }, `${b.title} · ${b.object_count}`)))))
      : null,
    h('div', { className: 'wb-tools', role: 'toolbar' },
      TOOLS.map((t) => h('button', {
        key: t.id,
        type: 'button',
        className: tool === t.id ? 'active' : undefined,
        onClick: () => setTool(t.id),
      }, t.label)),
      h('button', {
        type: 'button',
        disabled: !selectedId,
        onClick: () => void onArchive(),
        title: '下墙进仓库（不删除）',
      }, '下墙')),
    error ? h('p', { className: 'wb-error', role: 'alert' }, error) : null,
    busy && !board ? h('p', { className: 'wb-muted' }, '加载看板…') : null,
    board
      ? h(World, {
        objects: board.objects || [],
        selectedId,
        camera,
        surfaceRef,
        onPointerDown,
        onPointerMove,
        onPointerUp,
        onWheel,
      })
      : null,
    selected
      ? h('div', { className: 'wb-inspector' },
        h('button', { type: 'button', className: 'wb-quiet', onClick: () => focusObject(selected.id) }, '定位'),
        selected.type === 'table'
          ? h('textarea', {
            rows: 4,
            value: [
              selected.title || '',
              (selected.columns || []).join('\t'),
              ...(selected.rows || []).map((r) => r.join('\t')),
            ].join('\n'),
            onChange: (e) => {
              const lines = e.target.value.split('\n')
              const title = lines[0] || ''
              const columns = (lines[1] || '').split('\t').filter(Boolean)
              const rows = lines.slice(2).filter(Boolean).map((line) => line.split('\t'))
              patchSelected({ title, columns, rows, text: e.target.value })
            },
            onBlur: commitSelected,
          })
          : selected.type === 'icon'
            ? h('input', {
              value: selected.label || '',
              onChange: (e) => patchSelected({ label: e.target.value, title: e.target.value, text: e.target.value }),
              onBlur: commitSelected,
            })
            : h('textarea', {
              rows: 4,
              value: `${selected.title || ''}\n${selected.body || ''}`,
              onChange: (e) => {
                const i = e.target.value.indexOf('\n')
                const title = i < 0 ? e.target.value : e.target.value.slice(0, i)
                const body = i < 0 ? '' : e.target.value.slice(i + 1)
                patchSelected({ title, body, text: e.target.value })
              },
              onBlur: commitSelected,
            }))
      : null,
    warehouse
      ? h('div', { className: 'wb-warehouse' },
        h('div', { className: 'wb-warehouse-head' },
          h('strong', null, '仓库'),
          h('button', { type: 'button', className: 'wb-quiet', onClick: () => setWarehouse(null) }, '关闭')),
        warehouse.length === 0
          ? h('p', { className: 'wb-muted' }, '仓库是空的')
          : warehouse.map((item) => h('div', { key: `${item.board_id}:${item.object.id}`, className: 'wb-warehouse-row' },
            h('div', null,
              h('strong', null, item.board_title),
              h('p', null, (item.object.title || item.object.label || item.object.type || '').slice(0, 80))),
            h('button', {
              type: 'button',
              onClick: () => void onRestore(item.board_id, item.object.id),
            }, '放回看板'))))
      : null)
}

export function WhiteboardFab({ open, onClick }) {
  if (open) return null
  return h('button', {
    type: 'button',
    className: 'wb-fab',
    onClick,
    title: '打开白板',
  }, '白板')
}
