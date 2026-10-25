import {
  appendProductionGoal,
  createDoc,
  emptyProductionGoal,
  productionGoalHeads,
  selectProductionTarget,
} from '@plein/doc'
import { Shot } from '@plein/nodes'
import type { Canvas, ProjectImportPreview, ProjectImportResult } from '@plein/protocol'
import * as Y from 'yjs'
import { describe, expect, it, vi } from 'vite-plus/test'
import { addNode, bootServer, createCanvas, mockSettings, request, until } from '../testing'

describe('制作目标持久化范围', () => {
  it('SQLite重载、检查点与项目包保留内容，副本精确映射scope并保留来源；保存零执行且hash不变', async () => {
    const { server } = await bootServer()
    mockSettings(server, {})
    const { id: canvasId, doc } = await createCanvas(server)
    const boardId = addNode(doc, 'plein/storyboard', {
      params: { shots: [Shot.parse({ id: 'representative', no: 1, description: '交接红信封' })] },
    })
    const sequenceId = addNode(doc, 'plein/sequence')
    const script = addNode(doc, 'plein/text', { params: { text: '剧本' } })
    const { connect } = await import('@plein/doc')
    expect(connect(doc, [script, 'text'], [boardId, 'script'])).toBeTruthy()
    const before = await server.runs.preview(canvasId, boardId, 'local')
    const run = vi.spyOn(server.runs, 'start')
    const batch = vi.spyOn(server.runs, 'runReviewedBatch')
    selectProductionTarget(doc, boardId, { trialShotId: 'representative', sequenceId })
    const scope = { canvasId, boardId, sequenceId }
    const original = appendProductionGoal(doc, {
      scope,
      content: {
        ...emptyProductionGoal(),
        aspectRatio: '16:9',
        subtitles: 'required',
        requirements: '风声与人物对白可区分',
      },
      expectedHeads: [],
      userId: 'local',
    })!
    expect((await server.runs.preview(canvasId, boardId, 'local')).inputHash).toBe(before.inputHash)
    expect(run).not.toHaveBeenCalled()
    expect(batch).not.toHaveBeenCalled()
    await until(() => server.mediaIndex.ready)
    const checkpoint = server.checkpoints.create('local', canvasId, {
      name: '目标版本',
      expectedSnapshot: Buffer.from(Y.encodeSnapshot(Y.snapshot(doc.ydoc))).toString('base64'),
    })
    const restored = server.checkpoints.restore('local', checkpoint.id)
    const reopened = createDoc(server.rooms.get(restored.canvasId).doc, { schedule: () => {} })
    const restoredGoal = productionGoalHeads(reopened.get(boardId), {
      ...scope,
      canvasId: restored.canvasId,
    })[0]!
    expect(restoredGoal).toMatchObject({
      snapshot: original.snapshot,
      origin: { id: original.id, scope },
      scope: { ...scope, canvasId: restored.canvasId },
    })
    expect(restoredGoal.id).not.toBe(original.id)
    expect(productionGoalHeads(reopened.get(boardId), scope)).toEqual([])
    reopened.destroy()
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
    // 同一项目含恢复画布，项目包会保留多个各自独立的scope。
    const canvases = (await (
      await request(destination, `/api/projects/${result.projectId}/canvases`)
    ).json()) as Canvas[]
    let found = 0
    for (const item of canvases) {
      const importedDoc = createDoc(destination.rooms.get(item.id).doc, { schedule: () => {} })
      const current = productionGoalHeads(importedDoc.get(boardId), { ...scope, canvasId: item.id })
      expect(current).toHaveLength(1)
      expect(current[0]!.snapshot).toBe(original.snapshot)
      expect(current[0]!.scope.sequenceId).toBe(sequenceId)
      found++
      importedDoc.destroy()
    }
    expect(found).toBe(2)
    doc.destroy()
    server.rooms.unload(canvasId)
    const loaded = createDoc(server.rooms.get(canvasId).doc, { schedule: () => {} })
    expect(productionGoalHeads(loaded.get(boardId), scope)).toEqual([original])
    loaded.destroy()
  })
})
