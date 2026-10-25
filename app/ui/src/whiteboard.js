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
  { id: 'rect', label: '矩形' },
  { id: 'ellipse', label: '椭圆' },
  { id: 'diamond', label: '菱形' },
  { id: 'text', label: '文本' },
  { id: 'note', label: '卡片' },
  { id: 'frame', label: '画框' },
  { id: 'connector', label: '连线' },
]

function diamondPoints(x, y, w, h) {
  const mx = x + w / 2
  const my = y + h / 2
  return `${mx},${y} ${x + w},${my} ${mx},${y + h} ${x},${my}`
}

function anchorPoint(obj, which = 'c') {
  const ax = { l: obj.x, c: obj.x + obj.w / 2, r: obj.x + obj.w }
  const ay = { t: obj.y, c: obj.y + obj.h / 2, b: obj.y + obj.h }
  if (which === 'n') return { x: ax.c, y: ay.t }
  if (which === 's') return { x: ax.c, y: ay.b }
  if (which === 'w') return { x: ax.l, y: ay.c }
  if (which === 'e') return { x: ax.r, y: ay.c }
  return { x: ax.c, y: ay.c }
}

function connectorPath(from, to) {
  if (!from || !to) return ''
  const a = anchorPoint(from, 'e')
  const b = anchorPoint(to, 'w')
  const mx = (a.x + b.x) / 2
  return `M ${a.x} ${a.y} C ${mx} ${a.y}, ${mx} ${b.y}, ${b.x} ${b.y}`
}

function CanvasObject({ obj, selected, byId, onPointerDown }) {
  if (obj.archived_at) return null
  const common = {
    'data-id': obj.id,
    onPointerDown: (e) => onPointerDown(e, obj),
    style: { cursor: 'pointer' },
  }
  if (obj.type === 'connector') {
    const d = connectorPath(byId.get(obj.from_id), byId.get(obj.to_id))
    if (!d) return null
    return h('path', {
      ...common,
      d,
      fill: 'none',
      stroke: selected ? '#2563eb' : (obj.stroke || '#334155'),
      strokeWidth: selected ? 2.5 : (obj.stroke_width || 1.5),
      markerEnd: 'url(#wb-arrow)',
    })
  }
  const stroke = selected ? '#2563eb' : (obj.stroke || '#334155')
  const fill = obj.fill || '#fff'
  const sw = selected ? 2.25 : (obj.stroke_width || 1.25)
  let shape = null
  if (obj.type === 'ellipse') {
    shape = h('ellipse', {
      cx: obj.x + obj.w / 2,
      cy: obj.y + obj.h / 2,
      rx: obj.w / 2,
      ry: obj.h / 2,
      fill,
      stroke,
      strokeWidth: sw,
    })
  } else if (obj.type === 'diamond') {
    shape = h('polygon', { points: diamondPoints(obj.x, obj.y, obj.w, obj.h), fill, stroke, strokeWidth: sw })
  } else if (obj.type === 'frame') {
    shape = h('rect', {
      x: obj.x,
      y: obj.y,
      width: obj.w,
      height: obj.h,
      rx: 4,
      fill: 'transparent',
      stroke,
      strokeWidth: sw,
      strokeDasharray: '6 4',
    })
  } else {
    shape = h('rect', {
      x: obj.x,
      y: obj.y,
      width: obj.w,
      height: obj.h,
      rx: obj.type === 'note' ? 10 : 6,
      fill: obj.type === 'note' ? (obj.fill || '#f8fafc') : fill,
      stroke,
      strokeWidth: sw,
    })
  }
  const lines = String(obj.text || '').split('\n').slice(0, 12)
  return h('g', common,
    shape,
    lines.length
      ? h('text', {
        x: obj.x + 12,
        y: obj.y + 22,
        fill: 'var(--bt-ink, #0f172a)',
        fontSize: 13,
        fontFamily: 'inherit',
      }, lines.map((line, i) => h('tspan', { key: i, x: obj.x + 12, dy: i === 0 ? 0 : 16 }, line.slice(0, 48))))
      : null)
}

function World({ objects, selectedId, camera, onPointerDown, onWheel, onPointerMove, onPointerUp, svgRef }) {
  const byId = new Map(objects.map((o) => [o.id, o]))
  const sorted = [...objects].sort((a, b) => {
    if (a.type === 'frame' && b.type !== 'frame') return -1
    if (b.type === 'frame' && a.type !== 'frame') return 1
    if (a.type === 'connector' && b.type !== 'connector') return 1
    if (b.type === 'connector' && a.type !== 'connector') return -1
    return (a.z || 0) - (b.z || 0)
  })
  return h('svg', {
    ref: svgRef,
    className: 'wb-svg',
    onWheel,
    onPointerMove,
    onPointerUp,
    onPointerLeave: onPointerUp,
  },
    h('defs', null,
      h('marker', {
        id: 'wb-arrow',
        viewBox: '0 0 10 10',
        refX: 8,
        refY: 5,
        markerWidth: 7,
        markerHeight: 7,
        orient: 'auto-start-reverse',
      }, h('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: '#334155' })),
      h('pattern', {
        id: 'wb-grid',
        width: 32,
        height: 32,
        patternUnits: 'userSpaceOnUse',
      }, h('path', {
        d: 'M 32 0 L 0 0 0 32',
        fill: 'none',
        stroke: 'color-mix(in srgb, var(--bt-ink) 10%, transparent)',
        strokeWidth: 1,
      }))),
    h('g', { transform: `translate(${camera.x},${camera.y}) scale(${camera.zoom})` },
      h('rect', {
        x: -4000,
        y: -4000,
        width: 8000,
        height: 8000,
        fill: 'url(#wb-grid)',
        onPointerDown: (e) => onPointerDown(e, null),
      }),
      sorted.map((obj) => h(CanvasObject, {
        key: obj.id,
        obj,
        selected: obj.id === selectedId,
        byId,
        onPointerDown,
      }))))
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
  const svgRef = useRef(null)
  const connectFrom = useRef(null)

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
      setError(failure?.message || '加载白板失败')
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
    const rect = svgRef.current?.getBoundingClientRect()
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
    const rect = svgRef.current?.getBoundingClientRect()
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
    if (tool === 'pan' || event.button === 1 || event.spaceKey) {
      drag.current = { kind: 'pan', x: event.clientX, y: event.clientY, cam: { ...camera } }
      event.currentTarget?.setPointerCapture?.(event.pointerId)
      return
    }
    if (tool === 'connector') {
      if (!obj || obj.type === 'connector') return
      if (!connectFrom.current) {
        connectFrom.current = obj.id
        setSelectedId(obj.id)
        return
      }
      if (connectFrom.current === obj.id) return
      const connector = {
        type: 'connector',
        from_id: connectFrom.current,
        to_id: obj.id,
        x: 0,
        y: 0,
        w: 0,
        h: 0,
        text: '',
        created_by: 'user',
      }
      connectFrom.current = null
      void persistObjects([connector])
      return
    }
    if (tool !== 'select' && !obj) {
      const type = tool
      const draft = {
        type,
        x: world.x,
        y: world.y,
        w: type === 'text' ? 160 : 200,
        h: type === 'text' ? 40 : type === 'frame' ? 220 : 120,
        text: type === 'text' ? '文本' : type === 'frame' ? '画框' : type === 'note' ? '卡片' : '',
        fill: type === 'frame' ? 'transparent' : type === 'note' ? '#f8fafc' : '#ffffff',
        created_by: 'user',
      }
      drag.current = { kind: 'create', draft, ox: world.x, oy: world.y }
      setSelectedId(null)
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
    const world = clientToWorld(event)
    if (d.kind === 'move') {
      const objects = board.objects.map((o) => (o.id === d.id
        ? { ...o, x: d.baseX + (world.x - d.ox), y: d.baseY + (world.y - d.oy) }
        : o))
      setBoard({ ...board, objects })
      return
    }
    if (d.kind === 'create') {
      const w = Math.max(40, world.x - d.ox)
      const h = Math.max(28, world.y - d.oy)
      d.draft = { ...d.draft, x: d.ox, y: d.oy, w, h }
      setBoard({
        ...board,
        objects: [...board.objects.filter((o) => o.id !== '__draft__'), { ...d.draft, id: '__draft__' }],
      })
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
      return
    }
    if (d.kind === 'create' && d.draft) {
      const { id: _drop, ...rest } = d.draft
      const cleaned = board.objects.filter((o) => o.id !== '__draft__')
      setBoard({ ...board, objects: cleaned })
      const res = await upsertObjects({ boardId: board.id, objects: [rest] })
      setBoard(res.board)
      const created = res.objects?.[0]
      if (created) setSelectedId(created.id)
      setTool('select')
    }
  }

  const onCreateBoard = async () => {
    const title = window.prompt('白板名称', '新白板')
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
    const x = 200 - obj.x * zoom
    const y = 160 - obj.y * zoom
    void persistCamera({ x, y, zoom })
  }

  useEffect(() => {
    if (selectedId && board?.objects?.some((o) => o.id === selectedId)) {
      /* keep */
    }
  }, [selectedId, board])

  if (!open) return null

  const categories = [...new Set(boards.map((b) => b.category || '未分类'))]

  return h('section', { className: 'wb-panel', 'aria-label': '白板' },
    h('header', { className: 'wb-head' },
      h('button', { type: 'button', className: 'wb-quiet', onClick: () => setPicker((v) => !v) },
        board ? board.title : '选择白板'),
      board?.category ? h('span', { className: 'wb-cat' }, board.category) : null,
      h('div', { className: 'wb-head-actions' },
        h('button', { type: 'button', className: 'wb-quiet', onClick: openWarehouse }, '仓库'),
        h('button', { type: 'button', className: 'wb-quiet', onClick: onClose }, '关闭'))),
    picker
      ? h('div', { className: 'wb-picker' },
        h('button', { type: 'button', className: 'wb-primary', onClick: onCreateBoard }, '新建白板'),
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
        onClick: () => { setTool(t.id); connectFrom.current = null },
      }, t.label)),
      h('button', {
        type: 'button',
        disabled: !selectedId,
        onClick: () => void onArchive(),
        title: '下墙进仓库（不删除）',
      }, '下墙')),
    error ? h('p', { className: 'wb-error', role: 'alert' }, error) : null,
    busy && !board ? h('p', { className: 'wb-muted' }, '加载白板…') : null,
    board
      ? h(World, {
        objects: board.objects || [],
        selectedId,
        camera,
        svgRef,
        onPointerDown,
        onPointerMove,
        onPointerUp,
        onWheel,
      })
      : null,
    selectedId && board
      ? h('div', { className: 'wb-inspector' },
        h('button', { type: 'button', className: 'wb-quiet', onClick: () => focusObject(selectedId) }, '定位'),
        h('textarea', {
          value: board.objects.find((o) => o.id === selectedId)?.text || '',
          rows: 3,
          onChange: (e) => {
            const text = e.target.value
            setBoard({
              ...board,
              objects: board.objects.map((o) => (o.id === selectedId ? { ...o, text } : o)),
            })
          },
          onBlur: () => {
            const obj = board.objects.find((o) => o.id === selectedId)
            if (obj) void persistObjects([obj])
          },
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
              h('p', null, (item.object.text || item.object.type).slice(0, 80))),
            h('button', {
              type: 'button',
              onClick: () => void onRestore(item.board_id, item.object.id),
            }, '放回白板'))))
      : null)
}

export function WhiteboardFab({ open, onClick }) {
  return h('button', {
    type: 'button',
    className: `wb-fab${open ? ' open' : ''}`,
    onClick,
    title: '打开白板',
    'aria-pressed': open,
  }, '白板')
}
