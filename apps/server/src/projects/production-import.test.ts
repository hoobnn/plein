import {
  appendProductionDecision,
  appendProductionGoal,
  captureSourceSnapshot,
  confirmProductionContent,
  connect,
  createDoc,
  currentProductionConfirmation,
  currentProductionDecisions,
  emptyProductionGoal,
  productionContentSnapshot,
  productionGoalHeads,
} from '@plein/doc'
import { Shot } from '@plein/nodes'
import type {
  Canvas,
  CheckpointPage,
  ProjectImportPreview,
  ProjectImportResult,
} from '@plein/protocol'
import * as Y from 'yjs'
import { expect, it } from 'vite-plus/test'
import { addNode, bootServer, createCanvas, request, until } from '../testing'

it('全新和冲突导入逐一归档全部画布的确认/决策，含无来源映射与checkpoint，目标要求仍可迁移', async () => {
  const { server } = await bootServer()
  const first = await createCanvas(server)
  const originalCanvas = (await (
    await request(server, `/api/canvases/${first.id}`)
  ).json()) as Canvas
  const response = await request(server, '/api/canvases', {
    method: 'POST',
    body: JSON.stringify({ projectId: originalCanvas.projectId, title: '带来源的第二画布' }),
  })
  const second = (await response.json()) as Canvas
  const sources = [
    { canvasId: first.id, doc: first.doc },
    {
      canvasId: second.id,
      doc: createDoc(server.rooms.get(second.id).doc, { schedule: () => {} }),
    },
  ]
  const originals = sources.map(({ canvasId, doc }, index) => {
    const boardId = addNode(doc, 'plein/storyboard', {
      params: { shots: [Shot.parse({ id: 'one', no: 1, description: '原文不变' })] },
    })
    if (index === 1) {
      const source = addNode(doc, 'plein/text', { params: { text: '固定剧情全文' } })
      connect(doc, [source, 'text'], [boardId, 'script'])
      expect(
        captureSourceSnapshot(doc, boardId, {
          canvasId,
          elementId: source,
          port: 'text',
          expectedText: '固定剧情全文',
        }),
      ).toBeTruthy()
    }
    expect(
      confirmProductionContent(doc, {
        scope: { canvasId, boardId },
        expectedSnapshot: productionContentSnapshot(doc.get(boardId))!,
        version: 'v-original',
        userId: 'local',
      }),
    ).toBe(true)
    expect(
      appendProductionDecision(doc, {
        scope: { canvasId, boardId },
        category: 'style',
        subject: '风格',
        value: '纪实',
        note: '原始理由',
        userId: 'local',
      }),
    ).toBe(true)
    expect(
      appendProductionGoal(doc, {
        scope: { canvasId, boardId },
        content: { ...emptyProductionGoal(), requirements: '可迁移的制作要求' },
        expectedHeads: [],
        userId: 'local',
      }),
    ).toBeTruthy()
    return { canvasId, boardId, production: structuredClone(doc.get(boardId)!.production!) }
  })
  const packaged = await request(server, `/api/projects/${originalCanvas.projectId}/package`)
  const bytes = await packaged.arrayBuffer()
  const { server: destination } = await bootServer()
  const importPackage = async (bytes: ArrayBuffer) => {
    const previewResponse = await request(destination, '/api/project-imports', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: bytes,
    })
    expect(previewResponse.status).toBe(201)
    const preview = (await previewResponse.json()) as ProjectImportPreview
    const imported = await request(destination, `/api/project-imports/${preview.token}`, {
      method: 'POST',
    })
    expect(imported.status).toBe(201)
    return (await imported.json()) as ProjectImportResult
  }
  const assertCanvas = (canvasId: string) => {
    const doc = createDoc(destination.rooms.get(canvasId).doc, { schedule: () => {} })
    try {
      let boards = 0
      for (const original of originals) {
        const board = doc.get(original.boardId)
        if (!board) continue
        boards++
        expect(board.production!.confirmations).toEqual(
          original.production.confirmations.map((record) => ({ ...record, historical: true })),
        )
        expect(board.production!.decisions).toEqual(
          original.production.decisions.map((record) => ({ ...record, historical: true })),
        )
        expect(currentProductionConfirmation(board, canvasId)).toBeUndefined()
        expect(currentProductionDecisions(board, canvasId)).toEqual([])
        // Fresh imports can preserve both canvas/board IDs. A public read must not
        // clear the historical marker in Yjs without a transaction and reactivate it.
        const bytesBefore = Y.encodeStateAsUpdate(doc.ydoc)
        const read = doc.get(board.id)!.production!
        for (const record of [...read.confirmations, ...read.decisions]) {
          try {
            record.historical = false
            record.scope.canvasId = canvasId
            record.scope.boardId = board.id
          } catch {
            // Immutable public snapshots reject writes; their stored history remains.
          }
        }
        expect(currentProductionConfirmation(doc.get(board.id), canvasId)).toBeUndefined()
        expect(currentProductionDecisions(doc.get(board.id), canvasId)).toEqual([])
        expect(Y.encodeStateAsUpdate(doc.ydoc)).toEqual(bytesBefore)
        expect(productionGoalHeads(board, { canvasId, boardId: board.id })).toHaveLength(1)
        expect(
          productionGoalHeads(board, { canvasId, boardId: board.id })[0]!.content.requirements,
        ).toBe('可迁移的制作要求')
      }
      expect(boards).toBe(1)
    } finally {
      doc.destroy()
    }
  }
  const assertProject = async (projectId: string) => {
    const canvases = (await (
      await request(destination, `/api/projects/${projectId}/canvases`)
    ).json()) as Canvas[]
    expect(canvases).toHaveLength(2)
    for (const canvas of canvases) assertCanvas(canvas.id)
    return canvases
  }
  const fresh = await importPackage(bytes)
  const freshCanvases = await assertProject(fresh.projectId)
  // 没有ID冲突时确实会保留canvasId；仍须显式归档确认，不能依赖scope碰巧变化。
  expect(freshCanvases.map((c) => c.id).sort()).toEqual(originals.map((c) => c.canvasId).sort())
  const conflicted = await importPackage(bytes)
  const copiedCanvases = await assertProject(conflicted.projectId)
  expect(copiedCanvases.every((c) => !originals.some((o) => o.canvasId === c.id))).toBe(true)
  await until(() => server.mediaIndex.ready)
  for (const { canvasId, doc } of sources)
    server.checkpoints.create('local', canvasId, {
      name: '原确认检查点',
      expectedSnapshot: Buffer.from(Y.encodeSnapshot(Y.snapshot(doc.ydoc))).toString('base64'),
    })
  const withArchives = await request(server, `/api/projects/${originalCanvas.projectId}/package`)
  const archived = await importPackage(await withArchives.arrayBuffer())
  await assertProject(archived.projectId)
  const checkpoints = (await (
    await request(destination, `/api/projects/${archived.projectId}/checkpoints`)
  ).json()) as CheckpointPage
  expect(checkpoints.items).toHaveLength(2)
  for (const checkpoint of checkpoints.items) {
    const restored = destination.checkpoints.restore('local', checkpoint.id)
    assertCanvas(restored.canvasId)
  }
  for (const original of originals) {
    const source = sources.find((s) => s.canvasId === original.canvasId)!
    expect(
      currentProductionConfirmation(source.doc.get(original.boardId), original.canvasId),
    ).toEqual(original.production.confirmations[0])
    expect(currentProductionDecisions(source.doc.get(original.boardId), original.canvasId)).toEqual(
      original.production.decisions,
    )
    source.doc.destroy()
  }
})
