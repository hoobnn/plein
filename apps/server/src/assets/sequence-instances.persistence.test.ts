import { execFileSync } from 'node:child_process'
import { createReadStream, existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import {
  addResults,
  adoptResult,
  connect,
  createDoc,
  createElement,
  currentResult,
  deleteElements,
  duplicateSequenceInstance,
  editSequenceInstance,
  fixSequenceInstance,
  sequenceInstancesOf,
  setParams,
  appendProductionGoal,
  emptyProductionGoal,
  editDelivery,
} from '@plein/doc'
import {
  arrangeSequence,
  createSubtitleTrack,
  sequenceNode,
  sequenceSourceMap,
  sequenceSourcesAt,
  sequenceSpec,
  subtitleSrt,
  Shot,
  DELIVERY_CHECK_TYPE,
  DeliveryCheckReport,
} from '@plein/nodes'
import { mockProvider } from '@plein/providers'
import type {
  ProjectImportPreview,
  ProjectImportResult,
  ProjectPackageManifest,
  UserTemplate,
} from '@plein/protocol'
import { referenceClipboard } from '@plein/capabilities'
import type { ClipboardData } from '@plein/doc'
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
import { ffmpegBin, probeMedia, h264Args, mediaCaps, setMediaTools } from './media'
import { sequencePackage } from './interchange'
import { parseCalls } from '../runs/recovery'

const mediaTools = {
  ffmpeg: process.env.PLEIN_FFMPEG_PATH || 'ffmpeg',
  ffprobe: process.env.PLEIN_FFPROBE_PATH || 'ffprobe',
}
setMediaTools(mediaTools)
const caps = await mediaCaps()
const available = caps.ffmpeg
const ff = (args: string[]) =>
  execFileSync(ffmpegBin(), ['-hide_banner', '-v', 'error', '-nostdin', ...args], {
    maxBuffer: 32 * 1024 * 1024,
  })
const rectangle = { x: 0, y: 0, w: 240, h: 140 }
const evidenceDir = process.env.PLEIN_P11_EVIDENCE_DIR
const boot = () =>
  bootServer({
    config: {
      ffmpegPath: mediaTools.ffmpeg,
      ffprobePath: mediaTools.ffprobe,
    },
  })

async function fixture(server: Awaited<ReturnType<typeof bootServer>>['server']) {
  let file =
    process.env.PLEIN_P11_FIXTURE_PATH ||
    fileURLToPath(
      new URL(
        '../../../../test-results/creative-workbench/P11/fixtures/shared-source-v1.mp4',
        import.meta.url,
      ),
    )
  if (process.env.PLEIN_P11_FIXTURE_PATH && !existsSync(file))
    throw new Error(`P11 fixed fixture is missing: ${file}`)
  if (!existsSync(file)) {
    file = join(tempDir('plein-segment-fixture-'), 'shared-source-v1.mp4')
    ff([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x180:rate=30:duration=8',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=8',
      ...(await h264Args()),
      '-threads',
      '1',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '96k',
      file,
    ])
  }
  const asset = await server.assets.ingest('local', createReadStream(file), {
    mime: 'video/mp4',
    name: 'shared-source-v1.mp4',
  })
  expect((await probeMedia(server.assets.originalPath(asset.id))).duration).toBeCloseTo(8, 2)
  return asset
}

const frame = (file: string, n: number) =>
  ff([
    '-i',
    file,
    '-vf',
    `select=eq(n\\,${n}),crop=iw:ih/3:0:0,scale=64:12,format=gray`,
    '-frames:v',
    '1',
    '-f',
    'rawvideo',
    '-',
  ])
const mae = (a: Uint8Array, b: Uint8Array) => {
  expect(a.length).toBe(b.length)
  return a.reduce((sum, value, i) => sum + Math.abs(value - b[i]!), 0) / a.length
}
const tone = (file: string, frequency: number) => {
  const raw = ff([
    '-ss',
    '0.3',
    '-t',
    '1',
    '-i',
    file,
    '-vn',
    '-ac',
    '1',
    '-ar',
    '48000',
    '-f',
    'f32le',
    '-',
  ])
  let real = 0,
    imaginary = 0
  const count = raw.length / 4
  for (let i = 0; i < count; i++) {
    const sample = raw.readFloatLE(i * 4),
      angle = (2 * Math.PI * frequency * i) / 48000
    real += sample * Math.cos(angle)
    imaginary += sample * Math.sin(angle)
  }
  return (2 * Math.hypot(real, imaginary)) / count
}

async function run(
  server: Awaited<ReturnType<typeof bootServer>>['server'],
  canvasId: string,
  id: string,
) {
  const job = server.runs.start(canvasId, id, 'local')
  const status = await server.runs.wait(job)
  expect(status, JSON.stringify(server.runs.store.get(job))).toBe('succeeded')
  await until(() => !server.runs.isRunning(canvasId, id))
  return job
}

describe.skipIf(!available)('P11 fixed segments: actual compose and archive', () => {
  it('actual generated origin survives template, checkpoint and current/all package job aliases before fixing', async () => {
    const { server } = await boot()
    mockSettings(server, { latencyMs: 0 })
    const submit = vi.spyOn(mockProvider, 'submit')
    const { id: canvasId, doc } = await createCanvas(server)
    const source = addNode(doc, 'plein/video', {
      nodeVersion: 2,
      params: {
        mode: 'text',
        prompt: 'controlled original generation identity archive proof',
        duration: 2,
      },
    })
    const sequence = addNode(doc, 'plein/sequence', {
      nodeVersion: 2,
      params: { instanceVersion: 2, clips: [], subtitles: false },
    })
    connect(doc, [source, 'video'], [sequence, 'clips'])
    const jobId = await run(server, canvasId, source)
    const result = currentResult(doc.get(source)!, 'video')!
    if (result.value.type !== 'video') throw new Error('expected generated video')
    const asset = server.assets.get('local', result.value.assetId)!
    const expected = { canvasId, nodeId: source, port: 'video', resultId: result.id, runId: jobId }
    expect(result.generationOrigin).toEqual(expected)
    expect(submit).toHaveBeenCalledTimes(1)
    const frozen = JSON.parse(server.runs.store.get(jobId)!.frozen!)
    expect(frozen.executionOrigin).toEqual({ canvasId, nodeId: source, runId: jobId })
    const pin = (
      target: ReturnType<typeof createDoc>,
      targetCanvas: string,
      targetSource: string,
      targetSequence: string,
    ) => {
      const selected = currentResult(target.get(targetSource)!, 'video')!
      expect(selected.generationOrigin).toEqual(expected)
      const instance = sequenceInstancesOf(target.get(targetSequence)!)[0]!
      expect(
        fixSequenceInstance(target, targetSequence, instance.clipInstanceId, {
          canvasId: targetCanvas,
          assetId: asset.id,
          duration: asset.duration!,
          sound: 'native',
          resultId: selected.id,
        }),
      ).toBe(true)
      const fixed = sequenceInstancesOf(target.get(targetSequence)!)[0]!.segment!
      expect(fixed.origin).toEqual(expected)
      expect(fixed.selection).toEqual({
        canvasId: targetCanvas,
        nodeId: targetSource,
        port: 'video',
        resultId: selected.id,
        runId: selected.runId,
      })
      return { origin: fixed.origin, selection: fixed.selection, candidateRunAlias: selected.runId }
    }
    const checkpoint = server.checkpoints.create('local', canvasId, {
      name: '原始生成候选未固定',
      expectedSnapshot: Buffer.from(Y.encodeSnapshot(Y.snapshot(doc.ydoc))).toString('base64'),
    })
    const templateResponse = await request(server, '/api/templates', {
      method: 'POST',
      body: JSON.stringify({
        title: '原始候选出处',
        data: referenceClipboard.copy(doc, [source, sequence]),
      }),
    })
    expect(templateResponse.status).toBe(201)
    const template = (await templateResponse.json()) as UserTemplate
    const target = await createCanvas(server)
    const pasted = referenceClipboard.paste(target.doc, template.data as unknown as ClipboardData, {
      canvasId: target.id,
    })
    const pastedSource = pasted.find((id) => target.doc.get(id)!.nodeType === 'plein/video')!
    const pastedSequence = pasted.find((id) => target.doc.get(id)!.nodeType === 'plein/sequence')!
    const templateProof = pin(target.doc, target.id, pastedSource, pastedSequence)
    target.doc.destroy()
    const project = server.db.$client
      .prepare('SELECT project_id FROM canvases WHERE id=?')
      .get(canvasId) as { project_id: string }
    const packages = []
    for (const history of [false, true]) {
      const archive = await request(
        server,
        `/api/projects/${project.project_id}/package${history ? '?history=1' : ''}`,
      )
      expect(archive.status).toBe(200)
      const bytes = new Uint8Array(await archive.arrayBuffer())
      const inspected = await request(server, '/api/project-imports', {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: bytes,
      })
      expect(inspected.status).toBe(201)
      const preview = (await inspected.json()) as ProjectImportPreview
      const committed = await request(server, `/api/project-imports/${preview.token}`, {
        method: 'POST',
      })
      expect(committed.status).toBe(201)
      const imported = (await committed.json()) as ProjectImportResult
      expect(imported.canvasId).not.toBe(canvasId)
      const importedDoc = createDoc(server.rooms.get(imported.canvasId!).doc)
      const proof = pin(importedDoc, imported.canvasId!, source, sequence)
      expect(proof.candidateRunAlias).not.toBe(jobId)
      expect(server.runs.store.get(proof.candidateRunAlias)?.canvas_id).toBe(imported.canvasId)
      packages.push({ history, canvasId: imported.canvasId, ...proof })
      importedDoc.destroy()
    }
    const restored = server.checkpoints.restore('local', checkpoint.id)
    const restoredDoc = createDoc(server.rooms.get(restored.canvasId).doc)
    const checkpointProof = pin(restoredDoc, restored.canvasId, source, sequence)
    restoredDoc.destroy()
    expect(submit).toHaveBeenCalledTimes(1)
    if (evidenceDir) {
      await mkdir(evidenceDir, { recursive: true })
      await writeFile(
        join(evidenceDir, 'known-origin-archive.json'),
        JSON.stringify(
          {
            boundary:
              'One actual NodeRuns/mock-provider setup video; zero further submits. Actual template/checkpoint/current+all import, no paid provider or playback.',
            original: expected,
            originalAssetId: asset.id,
            executionOrigin: frozen.executionOrigin,
            template: templateProof,
            checkpoint: checkpointProof,
            packages,
            setupMockSubmits: 1,
            furtherSubmits: 0,
          },
          null,
          2,
        ),
      )
    }
    doc.destroy()
  }, 60_000)
  it('legacy live v2 keeps pre-run shot/board after source rebind and deletion during actual compose', async () => {
    const { server } = await boot()
    const submit = vi.spyOn(mockProvider, 'submit')
    const asset = await fixture(server)
    const { id: canvasId, doc } = await createCanvas(server)
    const board = addNode(doc, 'plein/storyboard', {
      params: { shots: [Shot.parse({ id: 'legacy-shot', no: 1, description: '旧单镜来源' })] },
    })
    const source = addNode(doc, 'plein/video', {
      params: { source: { storyboard: board, shot: 'legacy-shot', role: 'video' } },
    })
    addResults(doc, source, [
      {
        id: 'legacy-result',
        runId: 'controlled-local-fixture',
        port: 'video',
        at: 1,
        value: { type: 'video', assetId: asset.id },
      },
    ])
    const sequence = addNode(doc, 'plein/sequence', {
      nodeVersion: 2,
      params: { subtitles: false, loudnorm: false, resolution: '720p', aspectRatio: '16:9' },
    })
    connect(doc, [source, 'video'], [sequence, 'clips'])
    const instance = sequenceInstancesOf(doc.get(sequence)!)[0]!
    expect(instance.segment).toBeUndefined()
    expect(instance.narrative).toBeUndefined()
    expect(editSequenceInstance(doc, sequence, instance.clipInstanceId, { in: 1, out: 2.5 })).toBe(
      true,
    )
    let entered!: () => void, release!: () => void
    const waiting = new Promise<void>((resolve) => {
      entered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const services = server.plugins.services.bind(server.plugins)
    const hold = vi.spyOn(server.plugins, 'services').mockImplementation((manifest, options) => {
      const actual = services(manifest, options)
      return {
        ...actual,
        media: {
          ...actual.media,
          compose: async (spec) => {
            entered()
            await gate
            return actual.media.compose(spec)
          },
        },
      }
    })
    try {
      const jobId = server.runs.start(canvasId, sequence, 'local')
      await waiting
      const frozen = JSON.parse(server.runs.store.get(jobId)!.frozen!)
      expect(frozen.deliveryOrigins[source]).toEqual({ shot: 'legacy-shot', storyboard: board })
      setParams(doc, source, {
        source: { storyboard: 'late-board', shot: 'late-shot', role: 'video' },
      })
      deleteElements(doc, [source])
      release()
      expect(await server.runs.wait(jobId)).toBe('succeeded')
      await until(() => !server.runs.isRunning(canvasId, sequence))
      const record = doc.get(sequence)!.deliveries![0]!
      expect(record.boardId).toBe(board)
      expect(record.sources).toHaveLength(1)
      expect(record.sources[0]).toMatchObject({
        source,
        clipInstanceId: instance.clipInstanceId,
        assetId: asset.id,
        port: 'video',
        edgeId: instance.edgeId,
        shotId: 'legacy-shot',
        sourceIn: 1,
        sourceOut: 2.5,
        speed: 1,
        start: 0,
        end: 1.5,
      })
      expect(record.sources[0]!.narrative).toBeUndefined()
      expect(record.sources[0]!.segmentId).toBeUndefined()
      const actual = await probeMedia(server.assets.originalPath(record.assetId))
      expect(actual.duration).toBeCloseTo(1.5, 2)
      const decodedFrames = ff([
        '-i',
        server.assets.originalPath(record.assetId),
        '-an',
        '-vf',
        'scale=1:1,format=gray',
        '-fps_mode',
        'passthrough',
        '-f',
        'rawvideo',
        '-',
      ]).length
      expect(decodedFrames).toBe(45)
      expect(parseCalls(server.runs.store.get(jobId)!.calls)).toEqual([])
      expect(submit).not.toHaveBeenCalled()
      if (evidenceDir) {
        await mkdir(evidenceDir, { recursive: true })
        await copyFile(
          server.assets.originalPath(record.assetId),
          join(evidenceDir, 'live-frozen-origins.mp4'),
        )
        await writeFile(
          join(evidenceDir, 'live-frozen-origins.json'),
          JSON.stringify(
            {
              boundary:
                'Actual NodeRuns + local FFmpeg; controlled seeded candidate; zero model calls. No claim of generated candidate origin.',
              canvasId,
              sequenceId: sequence,
              boardId: board,
              deletedSourceId: source,
              jobId,
              frozenOrigins: frozen.deliveryOrigins,
              frozenParams: frozen.params,
              delivery: record,
              probe: actual,
              decodedFrames,
              calls: parseCalls(server.runs.store.get(jobId)!.calls),
              providerSubmits: submit.mock.calls.length,
            },
            null,
            2,
          ),
        )
      }
    } finally {
      release()
      hold.mockRestore()
    }
  }, 45_000)
  // Like existing jobs.test.ts, subtitle-burning cases require the real ass filter.
  // Required P11 acceptance runs explicitly select bundled tools and must pass with zero skips.
  it.skipIf(!caps.subtitles)(
    'two uses survive source/view deletion; speed/overlap, MP4, SRT, OTIO/FCPXML, delivery and P12 evidence agree',
    async () => {
      const initial = await boot()
      let server = initial.server
      const dataDir = initial.dataDir
      mockSettings(server, {})
      const submit = vi.spyOn(mockProvider, 'submit')
      const asset = await fixture(server)
      const { id: canvasId, doc } = await createCanvas(server)
      const board = addNode(doc, 'plein/storyboard', {
        params: {
          shots: [
            Shot.parse({ id: 'shot-a', no: 1, description: 'A' }),
            Shot.parse({ id: 'shot-b', no: 2, description: 'B' }),
          ],
        },
      })
      const source = addNode(doc, 'plein/video', {
        params: { model: '', source: { storyboard: board, shot: 'shot-a', role: 'video' } },
      })
      addResults(doc, source, [
        {
          id: 'original-result',
          runId: 'local-seeded-candidate',
          port: 'video',
          at: 1,
          value: { type: 'video', assetId: asset.id },
        },
      ])
      const sequence = addNode(doc, 'plein/sequence', {
        nodeVersion: 2,
        params: { resolution: '720p', aspectRatio: '16:9', loudnorm: false },
      })
      connect(doc, [source, 'video'], [sequence, 'clips'])
      const a = sequenceInstancesOf(doc.get(sequence)!)[0]!.clipInstanceId
      expect(
        fixSequenceInstance(doc, sequence, a, {
          canvasId,
          assetId: asset.id,
          duration: 8,
          sound: 'native',
          resultId: 'original-result',
          narrative: { canvasId, boardId: board, shotId: 'shot-a' },
        }),
      ).toBe(true)
      const b = duplicateSequenceInstance(doc, sequence, a, {
        sound: 'native',
        narrative: { canvasId, boardId: board, shotId: 'shot-b' },
      })!
      expect(editSequenceInstance(doc, sequence, a, { in: 0, out: 2, subtitle: '人工 A' })).toBe(
        true,
      )
      expect(
        editSequenceInstance(doc, sequence, b, {
          in: 4,
          out: 6,
          speed: 2,
          volume: 0.6,
          transition: '叠化',
          transitionDuration: 0.5,
          subtitle: '人工 B',
        }),
      ).toBe(true)
      const params = sequenceNode.params.parse(doc.get(sequence)!.params)
      const rows = arrangeSequence(params, {})
      const durations = { clips: [8, 8], dialogue: [undefined, undefined] }
      const track = createSubtitleTrack(params, rows, durations)
      track.cues[0] = { ...track.cues[0]!, text: 'A 手工修订 @林夏', start: 0.2, end: 0.9 }
      track.cues[1] = { ...track.cues[1]!, text: 'B 独立字幕', start: 0.1, end: 0.8 }
      setParams(doc, sequence, { subtitleTrack: track })
      const saved = sequenceNode.params.parse(doc.get(sequence)!.params)
      const spec = sequenceSpec(saved, rows, durations, undefined, 'shared-two-uses')
      const expectedSources = sequenceSourceMap(spec)
      expect(
        sequenceSourcesAt(expectedSources, 1.75).map((s) => [s.clipInstanceId, s.sourceTime]),
      ).toEqual([
        [a, 1.75],
        [b, 4.5],
      ])
      const view = sequenceInstancesOf(doc.get(sequence)!)[0]!.source
      // A subsequent adopted candidate never retargets either fixed row.
      addResults(doc, source, [
        {
          id: 'new-result',
          runId: 'later-candidate',
          port: 'video',
          at: 2,
          value: { type: 'video', assetId: 'f'.repeat(64) },
        },
      ])
      adoptResult(doc, source, 'new-result')
      expect(arrangeSequence(saved, {}).map((r) => r.clip.assetId)).toEqual([asset.id, asset.id])
      deleteElements(doc, [source, view])
      await run(server, canvasId, sequence)
      const result = currentResult(doc.get(sequence)!)!
      const film = result.value.type === 'video' ? result.value.assetId : ''
      const outputPath = server.assets.originalPath(film)
      const media = await probeMedia(outputPath)
      expect(Math.abs(media.duration! - 2.5)).toBeLessThan(1 / 30 + 0.01)
      const firstError = mae(frame(outputPath, 15), frame(server.assets.originalPath(asset.id), 15))
      const lastError = mae(frame(outputPath, 68), frame(server.assets.originalPath(asset.id), 166))
      const left = frame(server.assets.originalPath(asset.id), 52),
        right = frame(server.assets.originalPath(asset.id), 134)
      const blended = Uint8Array.from(left, (value, i) =>
        Math.round(value * (1 - 7 / 15) + (right[i]! * 7) / 15),
      )
      const overlapError = mae(frame(outputPath, 52), blended)
      const wrongSpeedFrame = frame(server.assets.originalPath(asset.id), 127)
      const wrongSpeedBlend = Uint8Array.from(left, (value, i) =>
        Math.round(value * (1 - 7 / 15) + (wrongSpeedFrame[i]! * 7) / 15),
      )
      const wrongSpeedError = mae(frame(outputPath, 52), wrongSpeedBlend)
      expect(firstError).toBeLessThan(3)
      expect(lastError).toBeLessThan(3)
      expect(overlapError).toBeLessThan(3)
      expect(overlapError).toBeLessThan(wrongSpeedError / 2)
      const delivery = doc.get(sequence)!.deliveries![0]!
      expect(delivery.sources).toEqual(
        expectedSources.map((s) => ({ ...s, shotId: s.narrative!.shotId })),
      )
      expect(delivery.subtitleEvidence).toEqual({
        version: 1,
        basis: 'executed-sequence-spec',
        enabled: true,
        cues: spec.subtitles!.cues.map(({ start, end, text }) => ({ start, end, text })),
        assetId: film,
        resultId: result.id,
      })
      const goal = appendProductionGoal(doc, {
        scope: { canvasId, boardId: board, sequenceId: sequence },
        expectedHeads: [],
        userId: 'local',
        content: {
          ...emptyProductionGoal(),
          aspectRatio: '16:9',
          resolution: '720p',
          duration: { min: 2.5, max: 2.5 },
          subtitles: 'required',
          originalAudio: 'required',
        },
      })!
      const checkRequest = {
        scope: { canvasId, boardId: board, sequenceId: sequence },
        deliveryId: delivery.id,
        resultId: delivery.resultId,
        runId: delivery.runId,
        source: { assetId: delivery.assetId, kind: 'video', mime: 'video/mp4' },
        goal: { id: goal.id, snapshot: goal.snapshot },
        subtitles: delivery.subtitleEvidence,
      }
      const check = addNode(doc, DELIVERY_CHECK_TYPE, { params: { request: checkRequest } })
      const beforeCheck = JSON.stringify(doc.get(sequence)!.deliveries)
      const checkJob = await run(server, canvasId, check)
      const checkResult = currentResult(doc.get(check)!)!
      const mappedReport = DeliveryCheckReport.parse(
        checkResult.value.type === 'json' ? checkResult.value.value : undefined,
      )
      expect(mappedReport.request).toEqual(checkRequest)
      expect(mappedReport.observed).toMatchObject({
        sha256: film,
        width: 1280,
        height: 720,
        decodedFrames: 75,
        audioTracks: 1,
        audioDecoded: true,
        complete: true,
      })
      expect(mappedReport.observed.duration).toBeCloseTo(2.5, 2)
      expect(mappedReport.status).toBe('passed')
      expect(mappedReport.checks.find((c) => c.id === 'subtitles')).toMatchObject({
        status: 'passed',
      })
      expect(mappedReport.checks.find((c) => c.id === 'subtitles')!.detail).toContain(
        '不证明烧录字幕呈现正确',
      )
      expect(parseCalls(server.runs.store.get(checkJob)!.calls)).toHaveLength(0)
      expect(JSON.parse(server.runs.store.get(checkJob)!.call_history)).toEqual([])
      expect(JSON.stringify(doc.get(sequence)!.deliveries)).toBe(beforeCheck)
      if (evidenceDir) {
        await mkdir(evidenceDir, { recursive: true })
        await writeFile(
          join(evidenceDir, 'P12-mapped-output.json'),
          JSON.stringify(mappedReport, null, 2),
        )
      }
      const archive = await sequencePackage(server.assets, 'local', spec)
      const chunks: Buffer[] = []
      for await (const chunk of archive.stream) chunks.push(Buffer.from(chunk))
      const zip = Buffer.concat(chunks),
        files = unzipSync(zip)
      const clipMap = JSON.parse(strFromU8(files['shared-two-uses/clip-map.json']!))
      expect(clipMap.sources).toEqual(expectedSources)
      expect(strFromU8(files['shared-two-uses/subtitles.srt']!)).toBe(
        subtitleSrt(spec.subtitles!.cues),
      )
      const otio = JSON.parse(strFromU8(files['shared-two-uses/timeline.otio']!))
      expect(otio.metadata.plein.clipMap.sources).toEqual(expectedSources)
      expect(
        otio.tracks.children[0].children
          .filter((c: { OTIO_SCHEMA: string }) => c.OTIO_SCHEMA === 'Clip.2')
          .map(
            (c: { metadata: { plein: { provenance: { clipInstanceId: string } } } }) =>
              c.metadata.plein.provenance.clipInstanceId,
          ),
      ).toEqual([a, b])
      const xml = strFromU8(files['shared-two-uses/timeline.fcpxml']!)
      expect(xml).toContain('<timeMap>')
      expect(xml).toContain('duration="5/2s"')
      expect(submit).not.toHaveBeenCalled()

      // A second actual output makes current/all a real candidate-retention comparison.
      setParams(doc, sequence, { clipVolume: 0.8 })
      await run(server, canvasId, sequence)
      expect(doc.get(sequence)!.results).toHaveLength(2)
      const currentDelivery = doc.get(sequence)!.deliveries![0]!
      expect(editDelivery(doc, sequence, currentDelivery.id, { confirm: true })).toBe(true)
      expect(doc.get(sequence)!.deliveries!.find((d) => d.id === delivery.id)!.sources).toEqual(
        delivery.sources,
      )

      const role = addNode(doc, 'plein/character', { name: '林夏' })
      const savedTemplate = await request(server, '/api/templates', {
        method: 'POST',
        body: JSON.stringify({
          title: '固定实例人工字幕',
          data: referenceClipboard.copy(doc, [role, board, sequence]),
        }),
      })
      expect(savedTemplate.status).toBe(201)
      const template = (await savedTemplate.json()) as UserTemplate
      const destination = await createCanvas(server)
      addNode(destination.doc, 'plein/character', { name: '林夏' })
      const pasted = referenceClipboard.paste(
        destination.doc,
        template.data as unknown as ClipboardData,
        { canvasId: destination.id },
      )
      const pastedSequence = pasted.find(
        (id) => destination.doc.get(id)?.nodeType === 'plein/sequence',
      )!
      const pastedRows = sequenceInstancesOf(destination.doc.get(pastedSequence)!)
      expect(pastedRows.map((c) => c.clipInstanceId)).not.toEqual([a, b])
      expect(pastedRows.map((c) => c.segment)).toEqual(rows.map((r) => r.segment))
      expect(pastedRows.every((c) => c.narrative?.canvasId === destination.id)).toBe(true)
      expect(
        sequenceNode.params.parse(destination.doc.get(pastedSequence)!.params).subtitleTrack!
          .cues[0]!.text,
      ).toBe('A 手工修订 @林夏')
      const templateHistory = destination.doc.get(pastedSequence)!.deliveries![0]!
      expect(templateHistory.historical).toBe(true)
      expect(templateHistory.confirmedAt).toEqual(expect.any(Number))
      expect(
        editDelivery(destination.doc, pastedSequence, templateHistory.id, { confirm: true }),
      ).toBe(false)
      await run(server, destination.id, pastedSequence)
      expect(destination.doc.get(pastedSequence)!.deliveries![0]!.historical).not.toBe(true)
      expect(
        editDelivery(
          destination.doc,
          pastedSequence,
          destination.doc.get(pastedSequence)!.deliveries![0]!.id,
          { notes: [{ id: 'fresh-note', time: 1, text: 'fresh scope', resolved: false }] },
        ),
      ).toBe(true)
      destination.doc.destroy()

      const checkpoint = server.checkpoints.create('local', canvasId, {
        name: '固定两实例与实际交付',
        expectedSnapshot: Buffer.from(Y.encodeSnapshot(Y.snapshot(doc.ydoc))).toString('base64'),
      })
      const persisted = sequenceInstancesOf(doc.get(sequence)!)
      doc.destroy()
      await initial.close()
      const reopened = await bootServer({
        dataDir,
        config: {
          ffmpegPath: process.env.PLEIN_FFMPEG_PATH || 'ffmpeg',
          ffprobePath: process.env.PLEIN_FFPROBE_PATH || 'ffprobe',
        },
      })
      server = reopened.server
      const fromSqlite = createDoc(server.rooms.get(canvasId).doc)
      expect(sequenceInstancesOf(fromSqlite.get(sequence)!)).toEqual(persisted)
      expect(fromSqlite.get(sequence)!.results).toHaveLength(2)
      expect(
        ((await (await request(server, '/api/templates')).json()) as UserTemplate[]).find(
          (t) => t.id === template.id,
        )?.data,
      ).toEqual(template.data)
      fromSqlite.destroy()
      const project = server.db.$client
        .prepare('SELECT project_id FROM canvases WHERE id=?')
        .get(canvasId) as { project_id: string }
      const target = await boot()
      for (const history of [false, true]) {
        const response = await request(
          server,
          `/api/projects/${project.project_id}/package${history ? '?history=1' : ''}`,
        )
        expect(response.status).toBe(200)
        const bytes = new Uint8Array(await response.arrayBuffer())
        const manifest = JSON.parse(
          strFromU8(unzipSync(bytes)['manifest.json']!),
        ) as ProjectPackageManifest
        expect(manifest.assets.map((a) => a.id)).toContain(asset.id)
        expect(manifest.missing).toEqual([])
        const inspected = await request(target.server, '/api/project-imports', {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: bytes,
        })
        const preview = (await inspected.json()) as ProjectImportPreview
        expect(inspected.status).toBe(201)
        const committed = await request(target.server, `/api/project-imports/${preview.token}`, {
          method: 'POST',
        })
        expect(committed.status).toBe(201)
        const imported = (await committed.json()) as ProjectImportResult
        if (!history) expect(imported.canvasId).toBe(canvasId)
        const importedDoc = createDoc(target.server.rooms.get(imported.canvasId!).doc)
        expect(importedDoc.get(sequence)!.results).toHaveLength(history ? 2 : 1)
        expect(sequenceInstancesOf(importedDoc.get(sequence)!).map((c) => c.segment)).toEqual(
          rows.map((r) => r.segment),
        )
        expect(
          sequenceInstancesOf(importedDoc.get(sequence)!).map((c) => c.narrative?.canvasId),
        ).toEqual([imported.canvasId, imported.canvasId])
        expect(
          importedDoc.get(sequence)!.deliveries!.find((d) => d.id === delivery.id)!.sources,
        ).toEqual(delivery.sources)
        const importedHistory = importedDoc
          .get(sequence)!
          .deliveries!.find((d) => d.id === currentDelivery.id)!
        expect(importedHistory.historical).toBe(true)
        expect(importedHistory.confirmedAt).toEqual(expect.any(Number))
        expect(editDelivery(importedDoc, sequence, importedHistory.id, { notes: [] })).toBe(false)
        await run(target.server, imported.canvasId!, sequence)
        const fresh = importedDoc.get(sequence)!.deliveries![0]!
        expect(fresh.historical).not.toBe(true)
        expect(fresh.confirmedAt).toBeUndefined()
        importedDoc.destroy()
      }
      await until(() => server.mediaIndex.ready)
      const orphan = await server.assets.ingest('local', Readable.from(['unreferenced']), {
        mime: 'application/octet-stream',
        name: 'orphan',
      })
      const oldTime = new Date(Date.now() - 365 * 86400000)
      server.db.$client.prepare('UPDATE assets SET created_at=?').run(oldTime.getTime())
      for (const path of await readdir(join(dataDir, 'assets'), { recursive: true })) {
        const file = join(dataDir, 'assets', path)
        if ((await stat(file)).isFile()) await utimes(file, oldTime, oldTime)
      }
      const cleanup = await server.maintenance!.preview()
      await server.maintenance!.cleanup(cleanup.token)
      expect(server.assets.get('local', orphan.id)).toBeNull()
      expect(existsSync(server.assets.originalPath(asset.id))).toBe(true)
      const restored = server.checkpoints.restore('local', checkpoint.id)
      const restoredDoc = createDoc(server.rooms.get(restored.canvasId).doc)
      expect(
        sequenceInstancesOf(restoredDoc.get(sequence)!).map((c) => c.narrative?.canvasId),
      ).toEqual([restored.canvasId, restored.canvasId])
      expect(sequenceInstancesOf(restoredDoc.get(sequence)!)[0]!.segment!.origin).toBeUndefined()
      expect(sequenceInstancesOf(restoredDoc.get(sequence)!)[0]!.segment!.selection!.runId).toBe(
        'local-seeded-candidate',
      )
      const restoredHistory = restoredDoc
        .get(sequence)!
        .deliveries!.find((d) => d.id === currentDelivery.id)!
      expect(restoredHistory.historical).toBe(true)
      expect(restoredHistory.confirmedAt).toEqual(expect.any(Number))
      expect(editDelivery(restoredDoc, sequence, restoredHistory.id, { confirm: true })).toBe(false)
      await run(server, restored.canvasId, sequence)
      expect(restoredDoc.get(sequence)!.deliveries![0]!.historical).not.toBe(true)
      restoredDoc.destroy()
      if (evidenceDir) {
        await mkdir(evidenceDir, { recursive: true })
        await writeFile(
          join(evidenceDir, 'environment.json'),
          JSON.stringify(
            {
              tools: mediaTools,
              caps,
              ffmpegVersion: execFileSync(mediaTools.ffmpeg, ['-version'], {
                encoding: 'utf8',
              }).split('\n')[0],
              ffprobeVersion: execFileSync(mediaTools.ffprobe, ['-version'], {
                encoding: 'utf8',
              }).split('\n')[0],
              playback: false,
              networkCalls: 0,
              paidModelCalls: 0,
            },
            null,
            2,
          ),
        )
        await copyFile(outputPath, join(evidenceDir, 'shared-two-uses.mp4'))
        await writeFile(join(evidenceDir, 'shared-two-uses.zip'), zip)
        await writeFile(
          join(evidenceDir, 'compose-and-archive.json'),
          JSON.stringify(
            {
              spec,
              clipMap,
              delivery,
              observedMedia: media,
              frameErrors: { firstError, lastError, overlapError, wrongSpeedError },
              providerSubmits: submit.mock.calls.length,
              checkpointAssets: checkpoint.assets,
              currentAndAllImported: true,
              actualP12Check: {
                jobId: checkJob,
                reportNodeId: check,
                resultId: checkResult.id,
                decodedFrames: mappedReport.observed.decodedFrames,
                status: mappedReport.status,
                providerCalls: 0,
              },
              actualCandidateCounts: { current: 1, all: 2 },
              sqliteRestart: true,
              templateRoundTrip: true,
              cleanup: true,
            },
            null,
            2,
          ),
        )
      }
      submit.mockRestore()
    },
    90_000,
  )

  it('native/voice/mix are distinct actual PCM routes; speed does not retime independent voice', async () => {
    const { server } = await boot()
    mockSettings(server, {})
    const submit = vi.spyOn(mockProvider, 'submit')
    const asset = await fixture(server),
      dir = tempDir('plein-segment-voice-')
    const voiceFile = join(dir, 'voice.wav')
    ff([
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=880:sample_rate=48000:duration=2',
      '-c:a',
      'pcm_s16le',
      voiceFile,
    ])
    const voice = await server.assets.ingest('local', createReadStream(voiceFile), {
      mime: 'audio/wav',
      name: 'independent-voice.wav',
    })
    const { id: canvasId, doc } = await createCanvas(server)
    const voiceSource = createElement(doc, { ...rectangle, kind: 'audio', assetId: voice.id })
    const results: Array<{ sound: string; native440: number; voice880: number }> = []
    for (const sound of ['native', 'voice', 'mix'] as const) {
      const sequence = addNode(doc, 'plein/sequence', {
        nodeVersion: 2,
        params: {
          instanceVersion: 2,
          resolution: '720p',
          aspectRatio: '16:9',
          subtitles: false,
          loudnorm: false,
          clips: [
            {
              clipInstanceId: `clip-${sound}`,
              source: 'deleted-view',
              port: 'video',
              segment: {
                version: 1,
                segmentId: 'fixed-source',
                asset: { assetId: asset.id, kind: 'video' },
                duration: 8,
              },
              in: 0,
              out: 4,
              speed: 2,
              volume: 0.6,
              sound,
              dialogue: voiceSource,
            },
          ],
        },
      })
      connect(doc, [voiceSource, 'audio'], [sequence, 'dialogue'])
      await run(server, canvasId, sequence)
      const output = currentResult(doc.get(sequence)!)!
      const file = server.assets.originalPath(
        output.value.type === 'video' ? output.value.assetId : '',
      )
      results.push({ sound, native440: tone(file, 440), voice880: tone(file, 880) })
      if (evidenceDir) {
        await mkdir(evidenceDir, { recursive: true })
        await copyFile(file, join(evidenceDir, `sound-${sound}.mp4`))
      }
    }
    expect(results[0]!.native440).toBeGreaterThan(0.04)
    expect(results[0]!.voice880).toBeLessThan(0.005)
    expect(results[1]!.native440).toBeLessThan(0.005)
    expect(results[1]!.voice880).toBeGreaterThan(0.08)
    expect(results[2]!.native440).toBeGreaterThan(0.04)
    expect(results[2]!.voice880).toBeGreaterThan(0.08)
    expect(submit).not.toHaveBeenCalled()
    if (evidenceDir)
      await writeFile(
        join(evidenceDir, 'audio-routing.json'),
        JSON.stringify(
          {
            results,
            rate: 48000,
            sampleStart: 0.3,
            sampleSeconds: 1,
            providerSubmits: 0,
            playback: false,
          },
          null,
          2,
        ),
      )
    submit.mockRestore()
  }, 90_000)
})
