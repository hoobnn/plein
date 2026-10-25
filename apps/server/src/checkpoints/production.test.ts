import {
  SCHEMA_VERSION,
  appendProductionDecision,
  confirmProductionContent,
  connect,
  createDoc,
  currentProductionConfirmation,
  currentProductionDecisions,
  productionContentSnapshot,
  productionMapOf,
  selectProductionTarget,
} from '@plein/doc'
import { Shot } from '@plein/nodes'
import type { Canvas, ProjectImportPreview, ProjectImportResult } from '@plein/protocol'
import * as Y from 'yjs'
import { describe, expect, it } from 'vite-plus/test'
import { addNode, bootServer, createCanvas, mockSettings, request, until } from '../testing'

const shots = [Shot.parse({ id: 'trial', no: 1, description: '递出红信封' })]

describe('制作记录持久化', () => {
  it('内容确认不影响生成hash；刷新、SQLite重载保留，恢复和项目包导入只保留历史作用域', async () => {
    const { server } = await bootServer()
    mockSettings(server, {})
    const { id: canvasId, doc } = await createCanvas(server)
    const boardId = addNode(doc, 'plein/storyboard', { params: { shots } })
    const script = addNode(doc, 'plein/text', { params: { text: '红信封交接' } })
    connect(doc, [script, 'text'], [boardId, 'script'])
    const before = await server.runs.preview(canvasId, boardId, 'local')
    expect(
      confirmProductionContent(doc, {
        scope: { canvasId, boardId },
        expectedSnapshot: productionContentSnapshot(doc.get(boardId))!,
        version: 'test-v1',
        userId: 'local',
      }),
    ).toBe(true)
    appendProductionDecision(doc, {
      scope: { canvasId, boardId },
      userId: 'local',
      category: 'style',
      subject: '整体',
      value: '暖色',
      note: '保持红信封醒目',
    })
    selectProductionTarget(doc, boardId, { trialShotId: 'trial' })
    const saved = doc.get(boardId)!.production!
    expect((await server.runs.preview(canvasId, boardId, 'local')).inputHash).toBe(before.inputHash)
    const fresh = createDoc(server.rooms.get(canvasId).doc, { schedule: () => {} })
    expect(currentProductionConfirmation(fresh.get(boardId), canvasId)).toEqual(
      saved.confirmations[0],
    )
    fresh.destroy()
    await until(() => server.mediaIndex.ready)
    const checkpoint = server.checkpoints.create('local', canvasId, {
      name: '人工核对分镜',
      expectedSnapshot: Buffer.from(Y.encodeSnapshot(Y.snapshot(doc.ydoc))).toString('base64'),
    })
    const restored = server.checkpoints.restore('local', checkpoint.id)
    const restoreDoc = createDoc(server.rooms.get(restored.canvasId).doc, { schedule: () => {} })
    expect(restoreDoc.get(boardId)!.production).toEqual(saved)
    expect(
      currentProductionConfirmation(restoreDoc.get(boardId), restored.canvasId),
    ).toBeUndefined()
    expect(currentProductionDecisions(restoreDoc.get(boardId), restored.canvasId)).toEqual([])
    restoreDoc.destroy()
    const canvas = (await (await request(server, `/api/canvases/${canvasId}`)).json()) as Canvas
    const packaged = await request(server, `/api/projects/${canvas.projectId}/package`)
    expect(packaged.status).toBe(200)
    const destination = (await bootServer()).server
    const inspected = await request(destination, '/api/project-imports', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: await packaged.arrayBuffer(),
    })
    expect(inspected.status).toBe(201)
    const preview = (await inspected.json()) as ProjectImportPreview
    const imported = await request(destination, `/api/project-imports/${preview.token}`, {
      method: 'POST',
    })
    expect(imported.status).toBe(201)
    const result = (await imported.json()) as ProjectImportResult
    const importedDoc = createDoc(destination.rooms.get(result.canvasId!).doc, {
      schedule: () => {},
    })
    expect(importedDoc.get(boardId)!.production).toEqual({
      ...saved,
      confirmations: saved.confirmations.map((record) => ({ ...record, historical: true })),
      decisions: saved.decisions.map((record) => ({ ...record, historical: true })),
    })
    expect(
      currentProductionConfirmation(importedDoc.get(boardId), result.canvasId!),
    ).toBeUndefined()
    expect(JSON.stringify(importedDoc.get(boardId)!.production)).not.toMatch(
      /token|humanApproved|execution/,
    )
    importedDoc.destroy()
    doc.destroy()
    server.rooms.unload(canvasId)
    expect(server.rooms.has(canvasId)).toBe(false)
    const reloaded = createDoc(server.rooms.get(canvasId).doc, { schedule: () => {} })
    expect(reloaded.get(boardId)!.production).toEqual(saved)
    expect(currentProductionConfirmation(reloaded.get(boardId), canvasId)).toEqual(
      saved.confirmations[0],
    )
    reloaded.destroy()
  })

  it('服务端载入v6在WS join之前完成迁移，两客户端从共同初始化版本首次并发追加不丢', async () => {
    const { server } = await bootServer()
    const { id: canvasId, doc } = await createCanvas(server)
    const boardId = addNode(doc, 'plein/storyboard', { params: { shots } })
    doc.elementMaps.get(boardId)!.delete('production')
    doc.meta.set('schemaVersion', 6)
    doc.destroy()
    server.rooms.unload(canvasId)
    const room = server.rooms.get(canvasId)
    // NodeRuns 的同步 onLoad -> withDoc(createDoc) 已在 Rooms.get 返回前初始化。
    expect(room.doc.getMap('meta').get('schemaVersion')).toBe(SCHEMA_VERSION)
    const aRaw = new Y.Doc(),
      bRaw = new Y.Doc()
    const initialized = Y.encodeStateAsUpdate(room.doc)
    Y.applyUpdate(aRaw, initialized)
    Y.applyUpdate(bRaw, initialized)
    const a = createDoc(aRaw, { schedule: () => {} }),
      b = createDoc(bRaw, { schedule: () => {} })
    expect(productionMapOf(a, boardId)?.get('confirmations')).toBeInstanceOf(Y.Map)
    for (const [client, userId] of [
      [a, 'alice'],
      [b, 'bob'],
    ] as const) {
      confirmProductionContent(client, {
        scope: { canvasId, boardId },
        expectedSnapshot: productionContentSnapshot(client.get(boardId))!,
        version: 'v1',
        userId,
      })
      appendProductionDecision(client, {
        scope: { canvasId, boardId },
        userId,
        category: 'style',
        subject: '整体',
        value: userId,
      })
    }
    Y.applyUpdate(room.doc, Y.encodeStateAsUpdate(a.ydoc))
    Y.applyUpdate(room.doc, Y.encodeStateAsUpdate(b.ydoc))
    const merged = createDoc(room.doc, { schedule: () => {} })
    expect(merged.get(boardId)!.production!.confirmations).toHaveLength(2)
    expect(merged.get(boardId)!.production!.decisions).toHaveLength(2)
    merged.destroy()
    a.destroy()
    b.destroy()
  })
})
