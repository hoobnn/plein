import { createDoc, editDelivery, setParam } from '@plein/doc'
import type { Canvas, ProjectImportPreview, ProjectImportResult } from '@plein/protocol'
import * as Y from 'yjs'
import { describe, expect, it, vi } from 'vite-plus/test'
import { hasFfmpeg } from '../assets/media'
import { addNode, bootServer, createCanvas, request, until } from '../testing'

const media = await hasFfmpeg()
describe.skipIf(!media)('样片与交付本地完整链路', () => {
  it('零平台调用导出真实MP4；确认不改hash，检查点/项目包保留意见和旧交付资产', async () => {
    const { server } = await bootServer()
    const { id: canvasId, doc } = await createCanvas(server)
    const id = addNode(doc, 'plein/animatic', {
      params: {
        subtitles: false,
        resolution: '720p',
        aspectRatio: '16:9',
        boardId: 'board1',
        shots: [{ shotId: 'shot1', duration: 0.6 }],
      },
    })
    const submit = vi.spyOn(server.plugins, 'call')
    const job = server.runs.start(canvasId, id, 'local')
    expect(await server.runs.wait(job)).toBe('succeeded')
    expect(submit).not.toHaveBeenCalled()
    const record = doc.get(id)?.deliveries?.[0]
    expect(record).toMatchObject({
      kind: 'animatic',
      width: 1280,
      height: 720,
      boardId: 'board1',
      sources: [{ source: 'board1', shotId: 'shot1', start: 0, end: 0.6 }],
    })
    expect(record?.duration).toBeCloseTo(0.6, 1)
    const before = (await server.runs.preview(canvasId, id, 'local')).inputHash
    expect(
      editDelivery(doc, id, record!.id, {
        notes: [{ id: 'n1', time: 0.2, text: '节奏通过', resolved: true, shotId: 'shot1' }],
      }),
    ).toBe(true)
    expect(editDelivery(doc, id, record!.id, { confirm: true })).toBe(true)
    expect((await server.runs.preview(canvasId, id, 'local')).inputHash).toBe(before)
    setParam(doc, id, 'shots', [{ shotId: 'shot1', duration: 0.8 }])
    const second = server.runs.start(canvasId, id, 'local')
    expect(await server.runs.wait(second)).toBe('succeeded')
    expect(submit).not.toHaveBeenCalled()
    expect(doc.get(id)?.deliveries).toHaveLength(2)
    expect(doc.get(id)?.deliveries?.[0]?.confirmedAt).toBeUndefined()
    expect(doc.get(id)?.deliveries?.[1]?.confirmedAt).toBeTypeOf('number')
    const saved = doc.get(id)?.deliveries
    await until(() => server.mediaIndex.ready)
    const checkpoint = server.checkpoints.create('local', canvasId, {
      name: '交付记录',
      expectedSnapshot: Buffer.from(Y.encodeSnapshot(Y.snapshot(doc.ydoc))).toString('base64'),
    })
    const restored = server.checkpoints.restore('local', checkpoint.id)
    const restoredDoc = createDoc(server.rooms.get(restored.canvasId).doc, { schedule: () => {} })
    expect(restoredDoc.get(id)?.deliveries).toEqual(
      saved?.map((record) => ({ ...record, historical: true })),
    )
    expect(editDelivery(restoredDoc, id, record!.id, { confirm: true })).toBe(false)
    restoredDoc.destroy()
    const canvas = (await (await request(server, `/api/canvases/${canvasId}`)).json()) as Canvas
    const packaged = await request(
      server,
      `/api/projects/${canvas.projectId}/package?candidates=current`,
    )
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
    const importedDoc = createDoc(destination.rooms.get(result.canvasId!).doc, {
      schedule: () => {},
    })
    expect(importedDoc.get(id)?.deliveries).toEqual(
      saved?.map((record) => ({ ...record, historical: true })),
    )
    expect(editDelivery(importedDoc, id, record!.id, { notes: [] })).toBe(false)
    expect(destination.assets.get('local', record!.assetId)).not.toBeNull()
    importedDoc.destroy()
    doc.destroy()
  }, 30_000)
})
