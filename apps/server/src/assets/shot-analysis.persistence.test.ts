import { execFileSync } from 'node:child_process'
import { createReadStream, existsSync } from 'node:fs'
import { readdir, stat, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import {
  connect,
  createDoc,
  createElement,
  currentResult,
  deleteElements,
  setParam,
  updateElement,
} from '@plein/doc'
import { SHOT_ANALYSIS_TYPE, ShotAnalysisManifest, shotAnalysisAssets } from '@plein/nodes'
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

const available = await hasFfmpeg()

async function source(
  server: Awaited<ReturnType<typeof bootServer>>['server'],
  name = 'source.mp4',
) {
  const file = join(tempDir('plein-shot-archive-'), name)
  execFileSync(ffmpegBin(), [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=red:s=64x48:r=10:d=1',
    '-f',
    'lavfi',
    '-i',
    'color=blue:s=64x48:r=10:d=1',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=2',
    '-filter_complex',
    '[0:v][1:v]concat=n=2:v=1:a=0[v]',
    '-map',
    '[v]',
    '-map',
    '2:a',
    '-c:v',
    'libx264',
    '-c:a',
    'aac',
    file,
  ])
  return server.assets.ingest('local', createReadStream(file), { mime: 'video/mp4', name })
}

async function run(
  server: Awaited<ReturnType<typeof bootServer>>['server'],
  canvasId: string,
  nodeId: string,
) {
  const id = server.runs.start(canvasId, nodeId, 'local')
  expect(await server.runs.wait(id)).toBe('succeeded')
  await until(() => !server.runs.isRunning(canvasId, nodeId))
}

describe.skipIf(!available)('本地拉片持久化与归档真实往返', () => {
  it('本地阶段被shutdown中断后，重启用冻结源和旧参数真实执行FFmpeg，结果保留待采用', async () => {
    const first = await bootServer()
    const original = await source(first.server)
    const { id: canvasId, doc } = await createCanvas(first.server)
    const video = createElement(doc, {
      kind: 'video',
      assetId: original.id,
      x: 0,
      y: 0,
      w: 100,
      h: 100,
    })
    const node = addNode(doc, SHOT_ANALYSIS_TYPE, {
      params: { threshold: 0.25, minSceneSeconds: 0.4 },
    })
    connect(doc, [video, 'video'], [node, 'video'])
    let entered!: () => void
    const atLocalStage = new Promise<void>((resolve) => {
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
            analyzeVideo: async () => {
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
    const jobId = first.server.runs.start(canvasId, node, 'local')
    await atLocalStage
    const frozen = first.server.db.$client
      .prepare('SELECT frozen FROM jobs WHERE id=?')
      .get(jobId) as { frozen: string }
    expect(frozen.frozen).toContain(original.id)
    setParam(doc, node, 'threshold', 0.9)
    // Changing the connected asset after freezing must not change what recovery decodes.
    updateElement(doc, video, { assetId: 'f'.repeat(64) })
    first.server.runs.close()
    expect(await first.server.runs.wait(jobId)).toBe('running')
    held.mockRestore()
    expect(doc.get(node)?.results ?? []).toHaveLength(0)
    await first.close()

    const second = await bootServer({ dataDir: first.dataDir })
    const recoveredStatus = await second.server.runs.wait(jobId)
    expect(
      recoveredStatus,
      JSON.stringify(
        second.server.db.$client.prepare('SELECT error,recovery FROM jobs WHERE id=?').get(jobId),
      ),
    ).toBe('succeeded')
    await until(() => !second.server.runs.isRunning(canvasId, node))
    const restored = createDoc(second.server.rooms.get(canvasId).doc)
    const result = restored.get(node)!.results![0]!
    const manifest = ShotAnalysisManifest.parse(
      result.value.type === 'json' ? result.value.value : null,
    )
    expect(manifest.source.assetId).toBe(original.id)
    expect(manifest.algorithm.threshold).toBe(0.25)
    expect(manifest.scenes).toHaveLength(2)
    expect(restored.get(node)!.params?.threshold).toBe(0.9)
    expect(currentResult(restored.get(node)!)).toBeUndefined()
    expect(existsSync(second.server.assets.originalPath(manifest.scenes[0]!.frame.assetId))).toBe(
      true,
    )
    expect(await readdir(join(first.dataDir, 'tmp'))).toEqual([])
    restored.destroy()
  }, 30_000)

  it('当前候选/全部历史项目包、检查点恢复和真实GC保护源/帧/片段/音轨且不覆盖旧清单', async () => {
    const initial = await bootServer()
    const { server, dataDir } = initial
    const asset = await source(server)
    const { id: canvasId, doc } = await createCanvas(server)
    const project = server.db.$client
      .prepare('SELECT project_id FROM canvases WHERE id=?')
      .get(canvasId) as { project_id: string }
    const video = createElement(doc, {
      kind: 'video',
      assetId: asset.id,
      x: 0,
      y: 0,
      w: 100,
      h: 100,
    })
    const node = addNode(doc, SHOT_ANALYSIS_TYPE, {
      params: { threshold: 0.25, minSceneSeconds: 0.4, clips: true, audio: true },
    })
    connect(doc, [video, 'video'], [node, 'video'])
    await run(server, canvasId, node)
    const oldResult = currentResult(doc.get(node)!)!
    const old = ShotAnalysisManifest.parse(
      oldResult.value.type === 'json' ? oldResult.value.value : null,
    )
    setParam(doc, node, 'cutPlan', { sourceAssetId: asset.id, points: [0.6] })
    await run(server, canvasId, node)
    const newResult = currentResult(doc.get(node)!)!
    const latest = ShotAnalysisManifest.parse(
      newResult.value.type === 'json' ? newResult.value.value : null,
    )
    expect(doc.get(node)!.results).toHaveLength(2)
    expect(doc.get(node)!.results!.find((result) => result.id === oldResult.id)?.value).toEqual(
      oldResult.value,
    )

    const target = await bootServer()
    for (const history of [false, true]) {
      const response = await request(
        server,
        `/api/projects/${project.project_id}/package${history ? '?history=1' : ''}`,
      )
      expect(response.status).toBe(200)
      const archive = new Uint8Array(await response.arrayBuffer())
      const packaged = JSON.parse(
        strFromU8(unzipSync(archive)['manifest.json']!),
      ) as ProjectPackageManifest
      const expected = [
        ...new Set([...shotAnalysisAssets(latest), ...(history ? shotAnalysisAssets(old) : [])]),
      ]
      expect(packaged.assets.map((asset) => asset.id).sort()).toEqual(expected.sort())
      expect(packaged.missing).toEqual([])
      const previewResponse = await request(target.server, '/api/project-imports', {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: archive,
      })
      expect(previewResponse.status).toBe(201)
      const preview = (await previewResponse.json()) as ProjectImportPreview
      const importedResponse = await request(
        target.server,
        `/api/project-imports/${preview.token}`,
        { method: 'POST' },
      )
      expect(importedResponse.status).toBe(201)
      const imported = (await importedResponse.json()) as ProjectImportResult
      const restored = createDoc(target.server.rooms.get(imported.canvasId!).doc)
      const report = [...restored.elements()].find((el) => el.nodeType === SHOT_ANALYSIS_TYPE)!
      expect(report.results).toHaveLength(history ? 2 : 1)
      expect(
        ShotAnalysisManifest.parse(
          currentResult(report)!.value.type === 'json'
            ? (currentResult(report)!.value as { value: unknown }).value
            : null,
        ),
      ).toEqual(latest)
      for (const hash of expected) {
        expect(target.server.assets.get('local', hash)).not.toBeNull()
        expect(existsSync(target.server.assets.originalPath(hash))).toBe(true)
      }
      restored.destroy()
    }

    const checkpoint = server.checkpoints.create('local', canvasId, {
      name: '拉片清单两版',
      expectedSnapshot: Buffer.from(Y.encodeSnapshot(Y.snapshot(doc.ydoc))).toString('base64'),
    })
    const protectedHashes = [
      ...new Set([...shotAnalysisAssets(old), ...shotAnalysisAssets(latest)]),
    ]
    expect(checkpoint.missingAssets).toEqual([])
    expect(checkpoint.assets).toBe(protectedHashes.length)
    deleteElements(doc, [node, video])
    const orphan = await server.assets.ingest('local', Readable.from(['unused-shot-analysis']), {
      mime: 'application/octet-stream',
      name: 'unused',
    })
    const oldTime = new Date(Date.now() - 365 * 86_400_000)
    server.db.$client.prepare('UPDATE assets SET created_at=?').run(oldTime.getTime())
    const root = join(dataDir, 'assets')
    for (const path of await readdir(root, { recursive: true })) {
      const file = join(root, path)
      if ((await stat(file)).isFile()) await utimes(file, oldTime, oldTime)
    }
    const preview = await server.maintenance!.preview()
    expect(preview.assets).toBe(1)
    const cleaned = await server.maintenance!.cleanup(preview.token)
    expect(cleaned.assets).toBe(1)
    expect(server.assets.get('local', orphan.id)).toBeNull()
    for (const hash of protectedHashes)
      expect(existsSync(server.assets.originalPath(hash))).toBe(true)
    const restoredCanvas = server.checkpoints.restore('local', checkpoint.id)
    const restored = createDoc(server.rooms.get(restoredCanvas.canvasId).doc)
    const report = restored.get(node)!
    expect(report.results).toHaveLength(2)
    for (const result of report.results!)
      expect(
        ShotAnalysisManifest.safeParse(result.value.type === 'json' ? result.value.value : null)
          .success,
      ).toBe(true)
    restored.destroy()
  }, 45_000)
})
