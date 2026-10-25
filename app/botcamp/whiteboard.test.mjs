import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { configureDataRoot, getDataRoot } from '../../server/kv.mjs'
import { handleWhiteboardControl } from './whiteboard.mjs'

const user = { id: 'u_wb_test', email: 'admin@example.com', role: 'admin' }

test('whiteboard components: table article icon, archive warehouse, kanban place', async () => {
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
        { type: 'table', x: 40, y: 40, w: 320, h: 160, title: '漏斗', columns: ['阶段', '数'], rows: [['选题', '3']] },
        { type: 'article', x: 40, y: 220, w: 240, h: 120, title: '待处理帖', body: '正文' },
        { type: 'icon', x: 300, y: 220, w: 120, h: 44, icon: 'alert', label: '待你处理' },
        { type: 'rect', x: 0, y: 0, w: 10, h: 10, text: 'legacy' },
      ],
    }, user)
    assert.equal(upsert.body.board.objects.length, 4)
    assert.ok(upsert.body.board.objects.every((o) => ['table', 'article', 'icon'].includes(o.type)))
    const id = upsert.body.objects[0].id
    const archived = handleWhiteboardControl({}, 'whiteboard/objects/archive', { boardId, objectId: id }, user)
    assert.equal(archived.body.board.objects.length, 3)
    const warehouse = handleWhiteboardControl({}, 'whiteboard/warehouse', {}, user)
    assert.equal(warehouse.body.items.length, 1)
    assert.equal(warehouse.body.items[0].object.id, id)
    const placed = handleWhiteboardControl({}, 'whiteboard/place', {
      boardId,
      heading: '小稿 · 看板',
      columns: [
        { name: '待你处理', icon: 'alert', items: [{ title: '帖 A', body: '待确认' }] },
        { name: '写稿中', icon: 'post', items: [] },
      ],
      table: { title: '汇总', columns: ['账号', '粉丝'], rows: [['小稿', '448']] },
      createdBy: '总负责人',
    }, user)
    assert.match(placed.body.link.href, /^board:\/\//)
    assert.ok(placed.body.board.objects.some((o) => o.type === 'table'))
    assert.ok(placed.body.board.objects.some((o) => o.type === 'article'))
    assert.ok(placed.body.board.objects.some((o) => o.type === 'icon'))
    assert.ok(placed.body.board.objects.every((o) => !['rect', 'ellipse', 'diamond', 'frame', 'connector'].includes(o.type)))
  } finally {
    configureDataRoot(prev)
    await rm(dir, { recursive: true, force: true })
  }
})
