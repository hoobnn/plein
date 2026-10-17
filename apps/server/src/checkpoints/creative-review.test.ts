import {
  createDoc,
  creativeReviewTarget,
  getCreativeReview,
  recordCreativeReview,
} from '@plein/doc'
import type { Canvas, ProjectImportPreview, ProjectImportResult } from '@plein/protocol'
import * as Y from 'yjs'
import { describe, expect, it } from 'vite-plus/test'
import { addNode, bootServer, createCanvas, mockSettings, request, until } from '../testing'

describe('创作验收持久化合同', () => {
  it('人工验收不改变生成输入hash，刷新、检查点恢复与真实项目包导入都保留候选绑定', async () => {
    const { server } = await bootServer()
    mockSettings(server, {})
    const { id: canvasId, doc } = await createCanvas(server)
    const nodeId = addNode(doc, 'plein/image', { params: { prompt: '固定测试画面' } })
    const before = await server.runs.preview(canvasId, nodeId, 'local')
    const runId = server.runs.start(canvasId, nodeId, 'local')
    expect(await server.runs.wait(runId)).toBe('succeeded')
    const target = creativeReviewTarget(doc.get(nodeId))!
    expect(
      recordCreativeReview(doc, nodeId, {
        target,
        status: 'usable',
        tags: ['character'],
        note: '人物设定可用',
      }),
    ).toBe(true)
    const saved = getCreativeReview(doc.get(nodeId))!
    expect((await server.runs.preview(canvasId, nodeId, 'local')).inputHash).toBe(before.inputHash)
    const fresh = createDoc(server.rooms.get(canvasId).doc, { schedule: () => {} })
    expect(getCreativeReview(fresh.get(nodeId))).toEqual(saved)
    fresh.destroy()
    await until(() => server.mediaIndex.ready)
    const checkpoint = server.checkpoints.create('local', canvasId, {
      name: '人工验收版本',
      expectedSnapshot: Buffer.from(Y.encodeSnapshot(Y.snapshot(doc.ydoc))).toString('base64'),
    })
    const restored = server.checkpoints.restore('local', checkpoint.id)
    const restoreDoc = createDoc(server.rooms.get(restored.canvasId).doc, { schedule: () => {} })
    expect(getCreativeReview(restoreDoc.get(nodeId))).toEqual(saved)
    restoreDoc.destroy()
    const canvas = (await (await request(server, `/api/canvases/${canvasId}`)).json()) as Canvas
    const packaged = await request(server, `/api/projects/${canvas.projectId}/package`)
    expect(packaged.status).toBe(200)
    const data = await packaged.arrayBuffer()
    const destination = (await bootServer()).server
    const inspected = await request(destination, '/api/project-imports', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: data,
    })
    expect(inspected.status).toBe(201)
    const preview = (await inspected.json()) as ProjectImportPreview
    const imported = await request(destination, `/api/project-imports/${preview.token}`, {
      method: 'POST',
    })
    expect(imported.status).toBe(201)
    const result = (await imported.json()) as ProjectImportResult
    expect(result.canvasId).not.toBeNull()
    const importedDoc = createDoc(destination.rooms.get(result.canvasId!).doc, {
      schedule: () => {},
    })
    expect(getCreativeReview(importedDoc.get(nodeId))).toEqual(saved)
    importedDoc.destroy()
    doc.destroy()
  })
})
