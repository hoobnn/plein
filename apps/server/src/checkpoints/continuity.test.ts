import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { readdir, stat, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import {
  addResults,
  appendShotPlan,
  continuityAssets,
  continuityDependents,
  continuityOf,
  createDoc,
  creativeReviewTarget,
  currentContinuityObservations,
  currentShotPlan,
  deleteElements,
  emptyShotPlan,
  recordContinuityObservation,
  registerContinuitySubject,
  resolvedShotState,
} from '@plein/doc'
import { Shot } from '@plein/nodes'
import { mockProvider } from '@plein/providers'
import type {
  Asset,
  ProjectImportPreview,
  ProjectImportResult,
  ProjectPackageManifest,
} from '@plein/protocol'
import { strFromU8, unzipSync } from 'fflate'
import * as Y from 'yjs'
import { describe, expect, it, vi } from 'vite-plus/test'
import {
  addNode,
  bootServer,
  createCanvas,
  mockSettings,
  request,
  tempDir,
  until,
} from '../testing'
import { ffmpegBin, hasFfmpeg } from '../assets/media'
import { documentReferences } from '../media-index/references'

const available = await hasFfmpeg()
const fixtureBytes = readFileSync(
  new URL('../../../../docs/benchmarks/creative-baselines/action-continuity.json', import.meta.url),
)
const input = JSON.parse(fixtureBytes.toString()) as { shots: unknown[] }
const inputHash = createHash('sha256').update(fixtureBytes).digest('hex')
const output =
  process.env.PLEIN_P06_EVIDENCE_DIR ??
  fileURLToPath(
    new URL(`../../../../.creative-workbench-evidence/P06/local-${Date.now()}/`, import.meta.url),
  )
type Server = Awaited<ReturnType<typeof bootServer>>['server']
async function video(server: Server, color: string) {
  const path = join(tempDir('plein-continuity-'), `${color}.mp4`)
  execFileSync(ffmpegBin(), [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=${color}:s=96x64:r=10:d=5`,
    '-f',
    'lavfi',
    '-i',
    'anullsrc=r=16000:cl=mono',
    '-t',
    '5',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    path,
  ])
  return server.assets.ingest('local', createReadStream(path), {
    mime: 'video/mp4',
    name: `${color}-controlled.mp4`,
  })
}
async function frame(server: Server, asset: Asset, last: boolean) {
  const response = await request(server, '/api/media/derive', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op: 'frame', assetId: asset.id, at: 0, last }),
  })
  expect(response.status).toBe(201)
  return ((await response.json()) as { assets: Asset[] }).assets[0]!
}

describe.skipIf(!available)('P06协议的实际相邻两镜三个独立变体', () => {
  it.each(['inherit', 'replace-candidate', 'reset'] as const)(
    '%s：真实媒体身份、冻结版本与观察范围，零模型提交',
    async (variant) => {
      expect(inputHash).toBe('82a7e69d5dddfb68e7d55519569047f233186fb642a556fc41d57c75db4b760e')
      const { server, dataDir } = await bootServer()
      mockSettings(server, {})
      const submit = vi.spyOn(mockProvider, 'submit')
      const starts = vi.spyOn(server.runs, 'start')
      const { id: canvasId, doc } = await createCanvas(server)
      const shots = input.shots.slice(0, 2).map((s) => Shot.parse(s))
      const boardId = addNode(doc, 'plein/storyboard', { params: { shots } })
      const scope = { canvasId, boardId }
      const courier = registerContinuitySubject(doc, { scope, kind: 'character', label: '快递员' })!
      const envelope = registerContinuitySubject(doc, { scope, kind: 'prop', label: '红信封' })!
      const [a, b] = await Promise.all([video(server, 'red'), video(server, 'blue')])
      const beforeNode = addNode(doc, 'plein/video', {
        params: {
          prompt: shots[0]!.motionPrompt,
          source: { storyboard: boardId, shot: shots[0]!.id, role: 'video' },
        },
      })
      const afterNode = addNode(doc, 'plein/video', {
        params: {
          prompt: shots[1]!.motionPrompt,
          source: { storyboard: boardId, shot: shots[1]!.id, role: 'video' },
        },
      })
      for (const [nodeId, asset, shotId] of [
        [beforeNode, a, shots[0]!.id],
        [afterNode, b, shots[1]!.id],
      ] as const)
        addResults(doc, nodeId, [
          {
            id: `${variant}-${shotId}-candidate-1`,
            runId: `${variant}-${shotId}-local`,
            port: 'video',
            value: { type: 'video', assetId: asset.id },
            at: 1,
          },
        ])
      const beforeHash = (await server.runs.preview(canvasId, beforeNode, 'local')).inputHash
      expect(beforeHash).toBeTruthy()
      const first = appendShotPlan(doc, {
        scope,
        shotId: shots[0]!.id,
        expectedHeads: [],
        userId: 'local',
        content: {
          ...emptyShotPlan(),
          intent: '建立红信封的持有关系',
          end: {
            [courier]: { worldPosition: '桌边', screenPosition: '画面右侧', pose: '从桌边起身' },
            [envelope]: {
              holder: { subjectId: courier, hand: 'right' },
              condition: '一只、红色、完整',
            },
          },
        },
      })!
      const second = appendShotPlan(doc, {
        scope,
        shotId: shots[1]!.id,
        expectedHeads: [],
        userId: 'local',
        content: {
          ...emptyShotPlan(),
          intent: '从桌边朝门口移动',
          start: { [courier]: { screenPosition: '画面左侧' } },
          inherits: [
            {
              fromShotId: first.shotId,
              planRevisionId: first.id,
              subjectId: courier,
              fields: ['worldPosition'],
            },
            {
              fromShotId: first.shotId,
              planRevisionId: first.id,
              subjectId: envelope,
              fields: ['holder', 'condition'],
            },
          ],
        },
      })!
      const [tail, head] = await Promise.all([frame(server, a, true), frame(server, b, false)])
      for (const [nodeId, shotId, phase, evidence] of [
        [beforeNode, first.shotId, 'end', tail],
        [afterNode, second.shotId, 'start', head],
      ] as const) {
        expect(
          recordContinuityObservation(doc, {
            scope,
            shotId,
            phase,
            nodeId,
            target: creativeReviewTarget(doc.get(nodeId))!,
            evidence: {
              kind: 'frame',
              position: phase,
              frameAssetId: evidence.id,
              aspects: ['visual'],
            },
            states: {
              [envelope]: {
                holder: {
                  certainty: 'unknown',
                  note: '受控色块只验证工程身份，不判断真实持物手或动作质量',
                },
              },
            },
            origin: { kind: 'manual', userId: 'local-test-fixture' },
          }),
        ).toBeTruthy()
      }
      let replacement: Asset | undefined
      if (variant === 'inherit') {
        appendShotPlan(doc, {
          scope,
          shotId: first.shotId,
          expectedHeads: [first.id],
          content: {
            ...first.content,
            end: {
              ...first.content.end,
              [envelope]: {
                ...first.content.end[envelope],
                holder: { subjectId: courier, hand: 'left' },
              },
            },
          },
          userId: 'local',
        })
        expect(
          continuityDependents(continuityOf(doc, boardId), first.shotId)
            .filter((r) => r.status === 'changed')
            .map((r) => r.toShotId),
        ).toEqual([second.shotId])
        expect(
          resolvedShotState(continuityOf(doc, boardId), second).start[envelope]!.holder!.hand,
        ).toBe('right')
      } else if (variant === 'replace-candidate') {
        replacement = await video(server, 'green')
        const result = {
          id: `${variant}-${first.shotId}-candidate-2`,
          runId: `${variant}-replacement-local`,
          port: 'video',
          value: { type: 'video' as const, assetId: replacement.id },
          at: 2,
        }
        addResults(doc, beforeNode, [result])
        // 模拟旧候选已被候选限额或用户清理淘汰；资产只能由观察保留。
        doc.mutable(beforeNode)!.set('results', [result])
        expect(currentContinuityObservations(doc, scope, first.shotId)).toEqual([])
        expect(continuityOf(doc, boardId).observations.some((o) => o.target.assetId === a.id)).toBe(
          true,
        )
      } else {
        appendShotPlan(doc, {
          scope,
          shotId: second.shotId,
          expectedHeads: [second.id],
          content: {
            ...emptyShotPlan(),
            reset: { kind: 'new_scene', reason: '时间跳跃后的独立场景' },
          },
          userId: 'local',
        })
        appendShotPlan(doc, {
          scope,
          shotId: first.shotId,
          expectedHeads: [first.id],
          content: { ...first.content, end: { [envelope]: { condition: '破损' } } },
          userId: 'local',
        })
        expect(continuityDependents(continuityOf(doc, boardId), first.shotId)).toEqual([])
      }
      expect((await server.runs.preview(canvasId, beforeNode, 'local')).inputHash).toBe(beforeHash)
      expect(submit).not.toHaveBeenCalled()
      expect(starts).not.toHaveBeenCalled()
      const record = continuityOf(doc, boardId)
      const directory = join(output, variant)
      mkdirSync(join(directory, 'assets'), { recursive: true })
      for (const hash of new Set([
        a.id,
        b.id,
        tail.id,
        head.id,
        ...(replacement ? [replacement.id] : []),
      ]))
        copyFileSync(server.assets.originalPath(hash), join(directory, 'assets', hash))
      writeFileSync(join(directory, 'canvas.yjs'), Y.encodeStateAsUpdate(doc.ydoc))
      writeFileSync(
        join(directory, 'state.json'),
        JSON.stringify(
          {
            canvasId,
            boardId,
            shotIds: shots.map((s) => s.id),
            beforeNode,
            afterNode,
            continuity: record,
          },
          null,
          2,
        ),
      )
      writeFileSync(
        join(directory, 'evidence.json'),
        JSON.stringify(
          {
            protocol: 'P06-action-continuity-1/2',
            variant,
            observedAt: new Date().toISOString(),
            execution: 'fresh-controlled-local-observation',
            inputSha256: inputHash,
            implementationSha256: createHash('sha256')
              .update(
                readFileSync(
                  new URL('../../../../packages/doc/src/continuity.ts', import.meta.url),
                ),
              )
              .digest('hex'),
            beforeInputHash: beforeHash,
            videoSubmits: submit.mock.calls.length,
            modelRunStarts: starts.mock.calls.length,
            media: {
              before: a.id,
              after: b.id,
              tail: tail.id,
              head: head.id,
              replacement: replacement?.id,
            },
            derivations: [
              { op: 'frame', assetId: a.id, at: 0, last: true },
              { op: 'frame', assetId: b.id, at: 0 },
            ],
            quality: null,
            humanAcceptance: null,
            dependencies: continuityDependents(record, first.shotId),
          },
          null,
          2,
        ),
      )

      if (variant === 'replace-candidate') {
        await until(() => server.mediaIndex.ready)
        const refs = documentReferences(doc)
        expect(
          refs.some((r) => r.assetId === a.id && r.explicit && r.locator.includes('continuity')),
        ).toBe(true)
        const project = server.db.$client
          .prepare('SELECT project_id FROM canvases WHERE id=?')
          .get(canvasId) as { project_id: string }
        // 尚未创建检查点；current包必须独立保留历史观察证据。
        const archive = await request(server, `/api/projects/${project.project_id}/package`)
        expect(archive.status).toBe(200)
        const bytes = new Uint8Array(await archive.arrayBuffer())
        const manifest = JSON.parse(
          strFromU8(unzipSync(bytes)['manifest.json']!),
        ) as ProjectPackageManifest
        for (const hash of continuityAssets(record))
          expect(manifest.assets.some((asset) => asset.id === hash)).toBe(true)
        const destination = (await bootServer()).server
        const inspected = await request(destination, '/api/project-imports', {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: bytes,
        })
        expect(inspected.status).toBe(201)
        const preview = (await inspected.json()) as ProjectImportPreview
        const importedResponse = await request(
          destination,
          `/api/project-imports/${preview.token}`,
          { method: 'POST' },
        )
        expect(importedResponse.status).toBe(201)
        const imported = (await importedResponse.json()) as ProjectImportResult
        expect(imported.canvasId).toBe(canvasId)
        const importedDoc = createDoc(destination.rooms.get(canvasId).doc)
        const importedRecord = continuityOf(importedDoc, boardId)
        expect(importedRecord.observations.every((o) => o.historical)).toBe(true)
        expect(currentContinuityObservations(importedDoc, scope, second.shotId)).toEqual([])
        const copiedSecond = currentShotPlan(importedRecord, second.shotId).plan!
        expect(
          copiedSecond.content.inherits.every((ref) =>
            importedRecord.plans.some((p) => p.id === ref.planRevisionId),
          ),
        ).toBe(true)
        for (const hash of continuityAssets(record))
          expect(existsSync(destination.assets.originalPath(hash))).toBe(true)
        importedDoc.destroy()

        const saved = continuityOf(doc, boardId)
        doc.destroy()
        server.rooms.unload(canvasId)
        const live = createDoc(server.rooms.get(canvasId).doc)
        expect(continuityOf(live, boardId)).toEqual(saved)
        server.mediaIndex.refreshCanvas(canvasId)
        const orphan = await server.assets.ingest('local', Readable.from(['unused-continuity']), {
          mime: 'application/octet-stream',
          name: 'unused',
        })
        const old = new Date(Date.now() - 365 * 86400000)
        server.db.$client.prepare('UPDATE assets SET created_at=?').run(old.getTime())
        const assetsRoot = join(dataDir, 'assets')
        for (const path of await readdir(assetsRoot, { recursive: true })) {
          const file = join(assetsRoot, path)
          if ((await stat(file)).isFile()) await utimes(file, old, old)
        }
        const cleanup = await server.maintenance!.preview()
        expect(cleanup.assets).toBe(1)
        await server.maintenance!.cleanup(cleanup.token)
        expect(server.assets.get('local', orphan.id)).toBeNull()
        for (const hash of continuityAssets(saved))
          expect(existsSync(server.assets.originalPath(hash))).toBe(true)
        const checkpoint = server.checkpoints.create('local', canvasId, {
          name: '两镜历史观察',
          expectedSnapshot: Buffer.from(Y.encodeSnapshot(Y.snapshot(live.ydoc))).toString('base64'),
        })
        expect(checkpoint.missingAssets).toEqual([])
        deleteElements(live, [boardId, beforeNode, afterNode])
        const restored = server.checkpoints.restore('local', checkpoint.id)
        const restoredDoc = createDoc(server.rooms.get(restored.canvasId).doc)
        expect(continuityOf(restoredDoc, boardId).observations.every((o) => o.historical)).toBe(
          true,
        )
        expect(currentContinuityObservations(restoredDoc, scope, second.shotId)).toEqual([])
        for (const hash of continuityAssets(saved))
          expect(existsSync(server.assets.originalPath(hash))).toBe(true)
        restoredDoc.destroy()
        live.destroy()
      } else doc.destroy()
      submit.mockRestore()
      starts.mockRestore()
    },
    30000,
  )
})
