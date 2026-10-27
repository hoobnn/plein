import { execFileSync } from 'node:child_process'
import { adoptResult, connect, currentResult } from '@plein/doc'
import { MotionParams } from '@plein/nodes'
import { unzipSync, strFromU8 } from 'fflate'
import { expect, it } from 'vite-plus/test'
import { hasFfmpeg, mediaToolPaths } from '../assets/media'
import { addNode, bootServer, createCanvas, request } from '../testing'
import { motionChromePath } from './identity'

const available = (await hasFfmpeg()) && !!motionChromePath()
it.skipIf(!available)(
  '真实动态合成经 HTTP 渲染为未采用候选，源工程可读，明确采用后下游导出正确 MP4',
  async () => {
    const { server } = await bootServer()
    const { id: canvas, doc } = await createCanvas(server)
    const motion = addNode(doc, 'plein/motion', {
      params: MotionParams.parse({
        title: '冻结源版本',
        duration: 1,
        resolution: '720p',
      }),
    })
    const run = async (id: string) => {
      const response = await request(server, `/api/canvases/${canvas}/nodes/${id}/run`, {
        method: 'POST',
      })
      expect(response.status).toBe(202)
      const { runId } = (await response.json()) as { runId: string }
      const status = await server.runs.wait(runId)
      expect(doc.get(id)?.run?.error).toBeUndefined()
      expect(status).toBe('succeeded')
    }
    await run(motion)
    const candidate = doc.get(motion)!.results![0]!
    expect(doc.get(motion)!.results).toHaveLength(1)
    expect(currentResult(doc.get(motion)!)).toBeUndefined()
    if (candidate.value.type !== 'video') throw new Error('Expected video candidate')
    const source = candidate.value.compositionSource!
    expect(source).toBeDefined()
    const bundle = await request(server, `/api/assets/${source.bundleAssetId}`)
    expect(bundle.status).toBe(200)
    const files = unzipSync(new Uint8Array(await bundle.arrayBuffer()))
    expect(strFromU8(files['index.html']!)).toContain('冻结源版本')
    const manifest = await request(server, `/api/assets/${source.manifestAssetId}`)
    expect(manifest.status).toBe(200)
    expect(await manifest.json()).toMatchObject({
      params: { title: '冻结源版本' },
      durationFrames: 30,
    })
    adoptResult(doc, motion, candidate.id)
    const sequence = addNode(doc, 'plein/sequence', {
      params: { aspectRatio: '9:16', resolution: '720p', subtitles: false },
    })
    expect(connect(doc, [motion, 'video'], [sequence, 'clips'])).not.toBeNull()
    await run(sequence)
    const output = currentResult(doc.get(sequence)!)!
    if (output.value.type !== 'video') throw new Error('Expected exported video')
    const probe = JSON.parse(
      execFileSync(
        mediaToolPaths().ffprobe,
        [
          '-v',
          'error',
          '-count_frames',
          '-show_streams',
          '-show_format',
          '-of',
          'json',
          server.assets.originalPath(output.value.assetId),
        ],
        { encoding: 'utf8' },
      ),
    ) as {
      streams: Array<{
        codec_type: string
        codec_name: string
        width: number
        height: number
        nb_read_frames: string
      }>
      format: { duration: string }
    }
    expect(probe.streams.find((stream) => stream.codec_type === 'video')).toMatchObject({
      codec_name: 'h264',
      width: 720,
      height: 1280,
      nb_read_frames: '30',
    })
    expect(Number(probe.format.duration)).toBeCloseTo(1, 1)
    expect(doc.get(motion)!.results).toHaveLength(1)
  },
  60_000,
)
