import { execFileSync } from 'node:child_process'
import { createReadStream, existsSync } from 'node:fs'
import { readdir, stat, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import {
  addResults,
  appendProductionGoal,
  connect,
  createDoc,
  createElement,
  currentResult,
  deleteElements,
  emptyProductionGoal,
  setParam,
  updateElement,
  type DeliveryRecord,
} from '@plein/doc'
import {
  DELIVERY_CHECK_TYPE,
  DeliveryCheckReport,
  type DeliveryCheckRequest,
  Shot,
} from '@plein/nodes'
import type {
  ProjectImportPreview,
  ProjectImportResult,
  ProjectPackageManifest,
} from '@plein/protocol'
import { strFromU8, unzipSync } from 'fflate'
import * as Y from 'yjs'
import { describe, expect, it, vi } from 'vite-plus/test'
import { addNode, bootServer, createCanvas, request, tempDir, until } from '../testing'
import { ffmpegBin, hasFfmpeg } from './media'
import { documentReferences } from '../media-index/references'
import { parseCalls } from '../runs/recovery'

const available = await hasFfmpeg()
type Server = Awaited<ReturnType<typeof bootServer>>['server']
async function source(server: Server, color = 'yellow') {
  const file = join(tempDir(), `${color}.mp4`)
  execFileSync(ffmpegBin(), [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=${color}:s=1280x720:r=10:d=2`,
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=2',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    file,
  ])
  return server.assets.ingest('local', createReadStream(file), {
    mime: 'video/mp4',
    name: `${color}.mp4`,
  })
}
async function run(server: Server, canvas: string, node: string) {
  const job = server.runs.start(canvas, node, 'local')
  expect(
    await server.runs.wait(job),
    JSON.stringify(server.db.$client.prepare('SELECT error FROM jobs WHERE id=?').get(job)),
  ).toBe('succeeded')
  await until(() => !server.runs.isRunning(canvas, node))
  return job
}
function binding(
  canvasId: string,
  boardId: string,
  sequenceId: string,
  record: DeliveryRecord,
  goal: { id: string; snapshot: string },
): DeliveryCheckRequest {
  return {
    scope: { canvasId, boardId, sequenceId },
    deliveryId: record.id,
    resultId: record.resultId,
    runId: record.runId,
    source: { assetId: record.assetId, kind: 'video', mime: 'video/mp4' },
    goal: { id: goal.id, snapshot: goal.snapshot },
    ...(record.subtitleEvidence ? { subtitles: record.subtitleEvidence } : {}),
  }
}

describe.skipIf(!available)('本地技术报告持久化', () => {
  it('真正sequenceSpec元数据、真实输出与目标绑定；当前/历史包、检查点/GC保留JSON强引用和未知交付字段', async () => {
    const { server, dataDir } = await bootServer()
    const asset = await source(server)
    const { id: canvas, doc } = await createCanvas(server)
    const board = addNode(doc, 'plein/storyboard', {
      params: { shots: [Shot.parse({ id: 'shot', no: 1, description: '交接' })] },
    })
    const clip = createElement(doc, {
      kind: 'video',
      assetId: asset.id,
      params: { source: { storyboard: board, shot: 'shot', role: 'video' } },
      x: 0,
      y: 0,
      w: 200,
      h: 100,
    })
    const sequence = addNode(doc, 'plein/sequence', {
      params: { subtitles: false, aspectRatio: '16:9', resolution: '720p' },
    })
    expect(connect(doc, [clip, 'video'], [sequence, 'clips'])).toBeTruthy()
    await run(server, canvas, sequence)
    const record = doc.get(sequence)!.deliveries![0]!
    expect(record.subtitleEvidence).toEqual({
      version: 1,
      basis: 'executed-sequence-spec',
      enabled: false,
      cues: [],
      assetId: record.assetId,
      resultId: record.resultId,
    })
    const goal = appendProductionGoal(doc, {
      scope: { canvasId: canvas, boardId: board, sequenceId: sequence },
      expectedHeads: [],
      userId: 'local',
      content: {
        ...emptyProductionGoal(),
        aspectRatio: '16:9',
        resolution: '720p',
        duration: { min: 1.8, max: 2.2 },
        dialogue: 'required',
      },
    })!
    const firstRequest = binding(canvas, board, sequence, record, goal)
    const check = addNode(doc, DELIVERY_CHECK_TYPE, { params: { request: firstRequest } })
    const before = JSON.stringify(doc.get(sequence)!.deliveries)
    await run(server, canvas, check)
    const oldResult = currentResult(doc.get(check)!)!
    const oldReport = DeliveryCheckReport.parse(
      oldResult.value.type === 'json' ? oldResult.value.value : undefined,
    )
    expect(oldReport.status).toBe('passed')
    expect(oldReport.request).toEqual(firstRequest)
    expect(JSON.stringify(doc.get(sequence)!.deliveries)).toBe(before)
    const nextAsset = await source(server, 'red')
    const next = {
      ...record,
      id: 'another-delivery',
      resultId: 'another-output',
      runId: 'another-export',
      assetId: nextAsset.id,
      subtitleEvidence: {
        ...record.subtitleEvidence!,
        assetId: nextAsset.id,
        resultId: 'another-output',
      },
      futureOptional: { preserved: true },
    }
    updateElement(doc, sequence, { deliveries: [next, record] })
    addResults(
      doc,
      sequence,
      [
        {
          id: next.resultId,
          runId: next.runId,
          port: 'video',
          at: 2,
          value: { type: 'video', assetId: next.assetId },
        },
      ],
      { adopt: true },
    )
    setParam(doc, check, 'request', binding(canvas, board, sequence, next, goal))
    await run(server, canvas, check)
    const latest = currentResult(doc.get(check)!)!
    expect(doc.get(check)!.results!.find((r) => r.id === oldResult.id)!.value).toEqual(
      oldResult.value,
    )
    expect(
      (server.db.$client.prepare('SELECT calls FROM jobs').all() as Array<{ calls: string }>).every(
        (row) => parseCalls(row.calls).length === 0,
      ),
    ).toBe(true)
    const explicit = documentReferences(doc).filter((ref) => ref.nodeId === check && ref.explicit)
    expect(new Set(explicit.map((ref) => ref.assetId))).toEqual(
      new Set([record.assetId, nextAsset.id]),
    )
    setParam(doc, check, 'request', undefined)
    // The JSON report alone, not a params hash or the original sequence, must preserve the file.
    const project = server.db.$client
      .prepare('SELECT project_id FROM canvases WHERE id=?')
      .get(canvas) as { project_id: string }
    const destination = (await bootServer()).server
    for (const history of [false, true]) {
      const response = await request(
        server,
        `/api/projects/${project.project_id}/package${history ? '?history=1' : ''}`,
      )
      expect(response.status).toBe(200)
      const archive = new Uint8Array(await response.arrayBuffer())
      const manifest = JSON.parse(
        strFromU8(unzipSync(archive)['manifest.json']!),
      ) as ProjectPackageManifest
      expect(manifest.assets.some((item) => item.id === nextAsset.id)).toBe(true)
      expect(manifest.missing).toEqual([])
      const inspected = await request(destination, '/api/project-imports', {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: archive,
      })
      const preview = (await inspected.json()) as ProjectImportPreview
      const imported = (await (
        await request(destination, `/api/project-imports/${preview.token}`, { method: 'POST' })
      ).json()) as ProjectImportResult
      const importedDoc = createDoc(destination.rooms.get(imported.canvasId!).doc, {
        schedule: () => {},
      })
      const importedCheck = importedDoc.get(check)!
      expect(importedCheck.results).toHaveLength(history ? 2 : 1)
      expect(currentResult(importedCheck)!.value).toEqual(latest.value)
      const importedSequence = importedDoc.get(sequence)!
      expect(importedSequence.deliveries![0]!.subtitleEvidence).toEqual(next.subtitleEvidence)
      expect(
        (importedSequence.deliveries![0] as unknown as { futureOptional: unknown }).futureOptional,
      ).toEqual(next.futureOptional)
      expect(importedSequence.deliveries![0]!.confirmedAt).toBeUndefined()
      expect(importedCheck.params?.historical).toBe(true)
      importedDoc.destroy()
    }
    doc.undo.stopCapturing()
    deleteElements(doc, [clip, sequence, board])
    doc.undo.stopCapturing()
    const minimal = await request(server, `/api/projects/${project.project_id}/package`)
    const minimalManifest = JSON.parse(
      strFromU8(unzipSync(new Uint8Array(await minimal.arrayBuffer()))['manifest.json']!),
    ) as ProjectPackageManifest
    expect(minimalManifest.assets.map((item) => item.id)).toEqual([nextAsset.id])
    expect(minimalManifest.missing).toEqual([])
    doc.undo.undo()
    expect(doc.get(sequence)!.deliveries![0]!.subtitleEvidence).toEqual(next.subtitleEvidence)
    await until(() => server.mediaIndex.ready)
    const checkpoint = server.checkpoints.create('local', canvas, {
      name: '技术报告两版',
      expectedSnapshot: Buffer.from(Y.encodeSnapshot(Y.snapshot(doc.ydoc))).toString('base64'),
    })
    expect(checkpoint.missingAssets).toEqual([])
    deleteElements(doc, [check, clip, sequence, board])
    const orphan = await server.assets.ingest('local', Readable.from(['orphan-p12']), {
      mime: 'application/octet-stream',
      name: 'unused',
    })
    const old = new Date(Date.now() - 365 * 86_400_000)
    server.db.$client.prepare('UPDATE assets SET created_at=?').run(old.getTime())
    for (const path of await readdir(join(dataDir, 'assets'), { recursive: true })) {
      const file = join(dataDir, 'assets', path)
      if ((await stat(file)).isFile()) await utimes(file, old, old)
    }
    const preview = await server.maintenance!.preview()
    await server.maintenance!.cleanup(preview.token)
    expect(server.assets.get('local', orphan.id)).toBeNull()
    for (const hash of [record.assetId, nextAsset.id])
      expect(existsSync(server.assets.originalPath(hash))).toBe(true)
    const restoredCanvas = server.checkpoints.restore('local', checkpoint.id)
    const restored = createDoc(server.rooms.get(restoredCanvas.canvasId).doc, {
      schedule: () => {},
    })
    expect(restored.get(check)!.results).toHaveLength(2)
    expect(restored.get(check)!.params?.historical).toBe(true)
    expect(restored.get(sequence)!.deliveries![0]!.subtitleEvidence).toEqual(next.subtitleEvidence)
    restored.destroy()
  }, 30_000)

  it('本地阶段shutdown后用冻结请求恢复；新输出/目标不能替换原检查，迟到结果不自动采用', async () => {
    const first = await bootServer(),
      asset = await source(first.server)
    const { id: canvas, doc } = await createCanvas(first.server)
    const requestValue: DeliveryCheckRequest = {
      scope: { canvasId: canvas, boardId: 'board', sequenceId: 'sequence' },
      deliveryId: 'delivery',
      runId: 'export',
      resultId: 'output',
      source: { assetId: asset.id, kind: 'video' },
      goal: { id: 'goal', snapshot: JSON.stringify(emptyProductionGoal()) },
    }
    const { productionGoalSnapshot } = await import('@plein/doc')
    requestValue.goal.snapshot = productionGoalSnapshot(emptyProductionGoal())
    const check = addNode(doc, DELIVERY_CHECK_TYPE, { params: { request: requestValue } })
    let entered!: () => void
    const atStage = new Promise<void>((resolve) => {
      entered = resolve
    })
    const services = first.server.plugins.services.bind(first.server.plugins)
    const held = vi
      .spyOn(first.server.plugins, 'services')
      .mockImplementation((manifest, options) => {
        const actual = services(manifest, options)
        return {
          ...actual,
          media: {
            ...actual.media,
            checkVideo: async () => {
              entered()
              await new Promise<never>((_, reject) => {
                if (options.signal.aborted) reject(options.signal.reason)
                else
                  options.signal.addEventListener('abort', () => reject(options.signal.reason), {
                    once: true,
                  })
              })
            },
          },
        }
      })
    const job = first.server.runs.start(canvas, check, 'local')
    await Promise.race([
      atStage,
      first.server.runs.wait(job).then((status) => {
        throw new Error(`没有进入本地阶段，任务已结束：${status}`)
      }),
    ])
    setParam(doc, check, 'request', {
      ...requestValue,
      source: { assetId: 'f'.repeat(64), kind: 'video' },
      goal: { ...requestValue.goal, id: 'changed-goal' },
    })
    first.server.runs.close()
    expect(await first.server.runs.wait(job)).toBe('running')
    held.mockRestore()
    await first.close()
    const second = await bootServer({ dataDir: first.dataDir })
    expect(await second.server.runs.wait(job)).toBe('succeeded')
    await until(() => !second.server.runs.isRunning(canvas, check))
    const restored = createDoc(second.server.rooms.get(canvas).doc, { schedule: () => {} })
    const value = restored.get(check)!.results![0]!.value
    const report = DeliveryCheckReport.parse(value.type === 'json' ? value.value : undefined)
    expect(report.request).toEqual(requestValue)
    expect(report.observed.sha256).toBe(asset.id)
    expect(currentResult(restored.get(check)!)).toBeUndefined()
    expect((restored.get(check)!.params!.request as DeliveryCheckRequest).goal.id).toBe(
      'changed-goal',
    )
    restored.destroy()
  }, 30_000)
})
