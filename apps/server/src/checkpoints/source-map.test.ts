import {
  addSourceUnit,
  captureSourceSnapshot,
  confirmProductionContent,
  connect,
  createDoc,
  currentProductionConfirmation,
  markSourceRead,
  productionContentSnapshot,
  setSourceLink,
  sourceMapOf,
  sourceSnapshotState,
} from '@plein/doc'
import { Shot } from '@plein/nodes'
import type { Canvas, ProjectImportPreview, ProjectImportResult } from '@plein/protocol'
import * as Y from 'yjs'
import { describe, expect, it } from 'vite-plus/test'
import { addNode, bootServer, createCanvas, mockSettings, request, until } from '../testing'

describe('原文映射持久化边界', () => {
  it('生成hash不变；SQLite/检查点恢复/真实plein项目包保存全文、范围与绑定，副本重新核对', async () => {
    const { server } = await bootServer()
    mockSettings(server, {})
    const { id: canvasId, doc } = await createCanvas(server)
    const text = '甲：回来。\r\n乙：回来。\r\n😀结尾'.repeat(1000)
    const boardId = addNode(doc, 'plein/storyboard', {
      params: { shots: [Shot.parse({ id: 'one', no: 1, description: '回头' })] },
    })
    const source = addNode(doc, 'plein/text', { params: { text } })
    connect(doc, [source, 'text'], [boardId, 'script'])
    const before = await server.runs.preview(canvasId, boardId, 'local')
    const snapshotId = captureSourceSnapshot(doc, boardId, {
      canvasId,
      elementId: source,
      port: 'text',
      expectedText: text,
    })!
    const unitId = addSourceUnit(doc, boardId, { snapshotId, start: 0, end: 5, kind: 'dialogue' })!
    setSourceLink(doc, boardId, { unitId, shotId: 'one', treatment: 'retain' })
    markSourceRead(doc, boardId, snapshotId)
    confirmProductionContent(doc, {
      scope: { canvasId, boardId },
      expectedSnapshot: productionContentSnapshot(doc.get(boardId))!,
      version: 'v1',
      userId: 'local',
    })
    const original = sourceMapOf(doc, boardId)
    expect((await server.runs.preview(canvasId, boardId, 'local')).inputHash).toBe(before.inputHash)
    await until(() => server.mediaIndex.ready)
    const checkpoint = server.checkpoints.create('local', canvasId, {
      name: '固定原文',
      expectedSnapshot: Buffer.from(Y.encodeSnapshot(Y.snapshot(doc.ydoc))).toString('base64'),
    })
    const restored = server.checkpoints.restore('local', checkpoint.id)
    const restoredDoc = createDoc(server.rooms.get(restored.canvasId).doc, { schedule: () => {} })
    const restoredMap = sourceMapOf(restoredDoc, boardId)
    expect(restoredMap.snapshots[0]!.text).toBe(text)
    expect(restoredMap.snapshots[0]!.id).not.toBe(snapshotId)
    expect(restoredMap.snapshots[0]!.originAtCapture).toEqual(
      original.snapshots[0]!.originAtCapture,
    )
    expect(restoredMap.units[0]!.snapshotId).toBe(restoredMap.snapshots[0]!.id)
    expect(restoredMap.links[0]!.unitId).toBe(restoredMap.units[0]!.id)
    expect(restoredMap.sources[0]!.binding!.elementId).toBe(source)
    expect(sourceSnapshotState(restoredDoc, boardId, restoredMap.snapshots[0]!)).toBe('current')
    expect(
      currentProductionConfirmation(restoredDoc.get(boardId), restored.canvasId),
    ).toBeUndefined()
    expect(restoredMap.readSnapshotIds).toEqual([])
    restoredDoc.destroy()
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
    const importedCanvases = (await (
      await request(destination, `/api/canvases?projectId=${result.projectId}`)
    ).json()) as Canvas[]
    expect(importedCanvases.some((canvas) => canvas.id === canvasId)).toBe(true)
    expect(importedCanvases.length).toBeGreaterThanOrEqual(2)
    for (const canvas of importedCanvases) {
      const importedDoc = createDoc(destination.rooms.get(canvas.id).doc, { schedule: () => {} })
      const importedMap = sourceMapOf(importedDoc, boardId)
      expect(importedMap.snapshots[0]!.text).toBe(text)
      expect(importedMap.snapshots[0]!.id).not.toBe(snapshotId)
      expect(importedMap.units[0]!.start).toBe(0)
      expect(importedMap.units[0]!.end).toBe(5)
      expect(importedMap.sources[0]!.binding!.elementId).toBe(source)
      expect(importedMap.snapshots[0]!.originAtCapture.canvasId).toBe(canvasId)
      expect(currentProductionConfirmation(importedDoc.get(boardId), canvas.id)).toBeUndefined()
      importedDoc.destroy()
    }
    doc.destroy()
    server.rooms.unload(canvasId)
    const reloaded = createDoc(server.rooms.get(canvasId).doc, { schedule: () => {} })
    expect(sourceMapOf(reloaded, boardId)).toEqual(original)
    expect(currentProductionConfirmation(reloaded.get(boardId), canvasId)).toBeTruthy()
    reloaded.destroy()
  })
})
