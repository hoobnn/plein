import { execFileSync } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import { expandShots, expandedNodes, type ShotSource } from '@plein/capabilities'
import {
  addResults,
  connect,
  createElement,
  deleteElements,
  setParam,
  type SequenceInstance,
} from '@plein/doc'
import { Shot } from '@plein/nodes'
import sharp from 'sharp'
import { Readable } from 'node:stream'
import { addNode, bootServer, createCanvas, makeNode, mockSettings, tempDir } from '../testing'
import { ffmpegBin } from '../assets/media'
import { storyboardBatchesOf } from './storyboard-batch'

export async function sequenceSegmentFixture() {
  const running = await bootServer()
  const { server } = running
  mockSettings(server, { latencyMs: 0 })
  const file = join(tempDir('p11-segments-'), 'shared.mp4')
  execFileSync(ffmpegBin(), [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=96x64:rate=30:duration=8',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000:duration=8',
    '-c:v',
    'libx264',
    '-threads',
    '1',
    '-c:a',
    'aac',
    '-pix_fmt',
    'yuv420p',
    file,
  ])
  const asset = await server.assets.ingest('local', createReadStream(file), {
    mime: 'video/mp4',
    name: 'shared.mp4',
  })
  const { id, doc } = await createCanvas(server)
  const shots = [1, 2, 3].map((no) =>
    Shot.parse({
      id: `segment-shot-${no}`,
      no,
      duration: 2,
      description: `画面${no}`,
      imagePrompt: `画面${no}`,
      motionPrompt: '缓慢推进',
      dialogue: [{ id: `segment-line-${no}`, character: '甲', line: `台词${no}` }],
    }),
  )
  const board = addNode(doc, 'plein/storyboard', { params: { shots } })
  expandShots(
    doc,
    board,
    shots.map((shot) => shot.id),
    makeNode,
  )
  const node = (index: number, role: ShotSource['role']) =>
    expandedNodes(doc, board)
      .get(shots[index]!.id)!
      .find((value) => (value.params?.source as ShotSource | undefined)?.role === role)?.id
  const originalVideo = node(0, 'video')!
  addResults(doc, originalVideo, [
    {
      id: 'fixed-original-result',
      runId: 'controlled-source-fixture',
      port: 'video',
      at: 1,
      value: { type: 'video', assetId: asset.id, mime: asset.mime },
    },
  ])
  const segment = {
    version: 1 as const,
    segmentId: 'shared-segment',
    asset: { assetId: asset.id, kind: 'video' as const, mime: asset.mime },
    duration: asset.duration!,
    origin: {
      canvasId: id,
      nodeId: originalVideo,
      port: 'video',
      resultId: 'fixed-original-result',
      runId: 'controlled-source-fixture',
    },
  }
  const view = createElement(doc, {
    kind: 'video',
    assetId: asset.id,
    videoSegment: segment,
    x: 900,
    y: 0,
    w: 180,
    h: 120,
  })
  const fixed = (index: number): SequenceInstance => ({
    clipInstanceId: `fixed-${index}`,
    source: view,
    port: 'video',
    segment,
    narrative: { canvasId: id, boardId: board, shotId: shots[index]!.id },
    sound: 'native',
    in: index ? 4 : 0,
    out: index ? 6 : 2,
  })
  const sequence = addNode(doc, 'plein/sequence', {
    nodeVersion: 2,
    params: {
      instanceVersion: 2,
      clips: [fixed(0), fixed(1)],
      subtitles: false,
      resolution: '720p',
      aspectRatio: '16:9',
      loudnorm: false,
    },
  })
  deleteElements(doc, [node(1, 'video')!])
  const png = await sharp({ create: { width: 96, height: 64, channels: 3, background: '#123456' } })
    .png()
    .toBuffer()
  const image = await server.assets.ingest('local', Readable.from([png]), {
    mime: 'image/png',
    name: 'source.png',
  })
  addResults(doc, node(2, 'image')!, [
    {
      id: 'prepared-image',
      runId: 'controlled-image-fixture',
      port: 'images',
      at: 1,
      value: { type: 'image', assetId: image.id, mime: image.mime },
    },
  ])
  const thirdVideo = node(2, 'video')!
  connect(doc, [thirdVideo, 'video'], [sequence, 'clips'])
  const rows = doc.get(sequence)!.params!.clips as SequenceInstance[]
  setParam(
    doc,
    sequence,
    'clips',
    rows.map((row) =>
      row.source === thirdVideo
        ? {
            ...row,
            narrative: { canvasId: id, boardId: board, shotId: shots[2]!.id },
          }
        : row,
    ),
  )
  const batches = storyboardBatchesOf(server.runs)
  const preview = (request: {
    shotIds: string[]
    role: 'video' | 'speech'
    reuseExisting: boolean
    sequenceId?: string
  }) => batches.preview(id, board, 'local', request)
  return {
    ...running,
    id,
    doc,
    board,
    shots,
    node,
    originalVideo,
    thirdVideo,
    asset,
    file,
    sequence,
    view,
    segment,
    fixed,
    batches,
    preview,
  }
}
