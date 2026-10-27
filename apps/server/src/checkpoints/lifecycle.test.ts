import { createDoc, setParam } from '@plein/doc'
import type {
  Canvas,
  CanvasCheckpoint,
  CheckpointDetail,
  CheckpointPage,
  CheckpointRestored,
} from '@plein/protocol'
import * as Y from 'yjs'
import { expect, it } from 'vite-plus/test'
import { addNode, bootServer, createCanvas, request } from '../testing'

async function setup() {
  const { server } = await bootServer()
  const { id, doc } = await createCanvas(server)
  const canvas = (await (await request(server, `/api/canvases/${id}`)).json()) as Canvas
  const nodeId = addNode(doc, 'plein/text', { params: { text: '保存时的正文' } })
  const save = async (name: string) => {
    const response = await request(server, `/api/canvases/${id}/checkpoints`, {
      method: 'POST',
      body: JSON.stringify({
        name,
        expectedSnapshot: Buffer.from(Y.encodeSnapshot(Y.snapshot(doc.ydoc))).toString('base64'),
      }),
    })
    expect(response.status).toBe(201)
    return (await response.json()) as CanvasCheckpoint
  }
  return { server, doc, canvas, nodeId, save }
}

it('真实默认分页分成 50 与 1 条，同毫秒排序不重复，新建后旧游标不混入新版本', async () => {
  const f = await setup()
  const saved: CanvasCheckpoint[] = []
  for (let index = 0; index < 51; index++) saved.push(await f.save(`版本 ${index}`))
  f.server.db.$client
    .prepare('UPDATE canvas_checkpoints SET created_at=1 WHERE project_id=?')
    .run(f.canvas.projectId)
  const path = `/api/projects/${f.canvas.projectId}/checkpoints`
  const first = (await (await request(f.server, path)).json()) as CheckpointPage
  expect(first.items).toHaveLength(50)
  expect(first.nextCursor).toBeTruthy()
  const newest = await f.save('新的版本')
  const second = (await (
    await request(f.server, `${path}?cursor=${first.nextCursor}`)
  ).json()) as CheckpointPage
  expect(second.items).toHaveLength(1)
  expect(second.nextCursor).toBeNull()
  expect(new Set([...first.items, ...second.items].map((item) => item.id))).toEqual(
    new Set(saved.map((item) => item.id)),
  )
  expect(second.items.some((item) => item.id === newest.id)).toBe(false)
  expect((await request(f.server, `${path}?cursor=corrupt`)).status).toBe(400)
})

it('恢复读取冻结快照生成独立画布，删除只移除目标检查点，原稿与其他版本不变', async () => {
  const f = await setup()
  const first = await f.save('第一版')
  setParam(f.doc, f.nodeId, 'text', '新正文')
  const second = await f.save('第二版')
  const response = await request(f.server, `/api/checkpoints/${first.id}/restore`, {
    method: 'POST',
    body: '{}',
  })
  expect(response.status).toBe(201)
  const restored = (await response.json()) as CheckpointRestored
  expect(restored.canvasId).not.toBe(f.canvas.id)
  const restoredDoc = createDoc(f.server.rooms.get(restored.canvasId).doc)
  expect(restoredDoc.get(f.nodeId)?.params?.text).toBe('保存时的正文')
  expect(f.doc.get(f.nodeId)?.params?.text).toBe('新正文')
  restoredDoc.destroy()
  expect(
    (await request(f.server, `/api/checkpoints/${first.id}`, { method: 'DELETE' })).status,
  ).toBe(204)
  expect((await request(f.server, `/api/checkpoints/${first.id}`)).status).toBe(404)
  const kept = (await (
    await request(f.server, `/api/checkpoints/${second.id}`)
  ).json()) as CheckpointDetail
  expect(kept.name).toBe('第二版')
  expect(kept.state).toBeTruthy()
  expect((await request(f.server, `/api/canvases/${f.canvas.id}`)).status).toBe(200)
  const canvases = (await (
    await request(f.server, `/api/projects/${f.canvas.projectId}/canvases`)
  ).json()) as Canvas[]
  expect(canvases.map((canvas) => canvas.id).sort()).toEqual(
    [f.canvas.id, restored.canvasId].sort(),
  )
})
