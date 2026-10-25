import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { configureDataRoot, getDataRoot } from '../../server/kv.mjs'
import { handleWhiteboardControl } from './whiteboard.mjs'

const user = { id: 'u_wb_test', email: 'admin@example.com', role: 'admin' }

test('whiteboard create, place shapes, archive to warehouse', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botcamp-wb-'))
  const prev = getDataRoot()
  try {
    configureDataRoot(path.join(dir, 'media-store'))
    const created = handleWhiteboardControl({}, 'whiteboard/create', { title: '作战室', category: '小稿' }, user)
    assert.equal(created.status, 200)
    const boardId = created.body.board.id
    const upsert = handleWhiteboardControl({}, 'whiteboard/objects/upsert', {
      boardId,
      objects: [
        { type: 'rect', x: 40, y: 40, w: 120, h: 80, text: '矩形' },
        { type: 'ellipse', x: 200, y: 40, w: 100, h: 80, text: '圆' },
        { type: 'note', x: 40, y: 160, w: 220, h: 120, text: '进度卡' },
      ],
    }, user)
    assert.equal(upsert.body.board.objects.length, 3)
    const id = upsert.body.objects[0].id
    const archived = handleWhiteboardControl({}, 'whiteboard/objects/archive', { boardId, objectId: id }, user)
    assert.equal(archived.body.board.objects.length, 2)
    const warehouse = handleWhiteboardControl({}, 'whiteboard/warehouse', {}, user)
    assert.equal(warehouse.body.items.length, 1)
    assert.equal(warehouse.body.items[0].object.id, id)
    const placed = handleWhiteboardControl({}, 'whiteboard/place', {
      boardId,
      title: 'Bot 落板',
      body: '真实画布对象',
      type: 'note',
    }, user)
    assert.match(placed.body.link.href, /^board:\/\//)
    assert.ok(placed.body.board.objects.some((o) => o.text.includes('Bot 落板')))
  } finally {
    configureDataRoot(prev)
    await rm(dir, { recursive: true, force: true })
  }
})
