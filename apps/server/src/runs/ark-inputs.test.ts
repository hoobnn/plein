import { execFileSync, spawnSync } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { connect, createElement } from '@plein/doc'
import type { ProviderContext } from '@plein/plugin-sdk'
import { arkProvider } from '@plein/providers'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { sineWav, solidPng } from '../../../../packages/providers/src/mock/media'
import { MOCK_WEBM_BASE64 } from '../../../../packages/providers/src/mock/video-fixture'
import { h264Args } from '../assets/media'
import { addNode, bootServer, createCanvas, tempDir } from '../testing'

const available = ['ffmpeg', 'ffprobe'].every(
  (tool) => spawnSync(tool, ['-version'], { stdio: 'ignore' }).status === 0,
)
afterEach(() => vi.restoreAllMocks())

describe.skipIf(!available)('火山本地素材经过宿主到 TOS / Ark HTTP 的验收', () => {
  it('真实视频元数据、素材上传、引用编号和可选提示词贯通', async () => {
    const { server } = await bootServer()
    server.plugins.configs.update('volc/ark', {
      enabled: true,
      settings: { referenceBucket: 'test-bucket', referenceRegion: 'cn-beijing' },
      secrets: {
        ARK_API_KEY: 'local-ark-key',
        ARK_TOS_ACCESS_KEY: 'local-ak',
        ARK_TOS_SECRET_KEY: 'local-sk',
      },
    })
    const { id, doc } = await createCanvas(server)
    const http = vi.fn<ProviderContext['fetch']>(async (url, init) => {
      if (init?.method === 'PUT') return new Response(null, { status: 200 })
      expect(String(url)).toContain('/contents/generations/tasks')
      return Response.json({ id: 'accepted-task' })
    })
    const original = arkProvider.submit
    vi.spyOn(arkProvider, 'submit').mockImplementation(async (req, ctx) => {
      await original(req, { ...ctx, fetch: http })
      return {
        state: 'succeeded',
        outputs: [
          {
            type: 'file',
            kind: 'video',
            mime: 'video/webm',
            data: new Uint8Array(Buffer.from(MOCK_WEBM_BASE64, 'base64')),
          },
        ],
      }
    })
    const ingest = (data: Uint8Array, mime: string, name: string) =>
      server.assets.ingest('local', Readable.from([data]), { mime, name })
    const image = await ingest(solidPng(720, 720, [80, 90, 100]), 'image/png', 'frame.png')
    const audio = await ingest(sineWav(2), 'audio/wav', 'audio.wav')
    const file = join(tempDir(), 'reference.mp4')
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=s=720x720:r=24:d=2',
      ...(await h264Args()),
      '-an',
      file,
    ])
    const video = await server.assets.ingest('local', createReadStream(file), {
      mime: 'video/mp4',
      name: 'reference.mp4',
    })
    const target = addNode(doc, 'plein/video', {
      params: {
        model: 'volc/ark:doubao-seedance-2-5-260628',
        mode: 'reference',
        prompt: '@image1 参考 @video1 运镜与 @audio1 节拍',
      },
    })
    for (const asset of [image, video, audio]) {
      if (asset.kind === 'file') throw new Error('Expected media')
      const source = createElement(doc, {
        kind: asset.kind,
        assetId: asset.id,
        x: 0,
        y: 0,
        w: 100,
        h: 100,
      })
      connect(
        doc,
        [source, asset.kind],
        [target, asset.kind === 'video' ? 'videos' : asset.kind === 'audio' ? 'audios' : 'images'],
      )
    }
    const preview = await server.runs.preview(id, target, 'local')
    expect(preview.status).toBe('ready')
    expect(preview.inputs.videos).toHaveLength(1)
    expect(await server.runs.wait(server.runs.start(id, target, 'local'))).toBe('succeeded')
    expect(http).toHaveBeenCalledTimes(2)
    const body = JSON.parse(String(http.mock.calls[1]![1]!.body))
    expect(body.content.map((item: { role?: string }) => item.role)).toEqual([
      undefined,
      'reference_image',
      'reference_video',
      'reference_audio',
    ])
    expect(body.content[2].video_url.url).toMatch(
      /^https:\/\/test-bucket\.tos-cn-beijing\.volces\.com\//,
    )
    expect(body.content[2].video_url.url).not.toContain('local-sk')
    expect(http.mock.calls[0]![1]!.body).toBeInstanceOf(Uint8Array)
    // 同一路径空提示词也应被宿主接受，而不是被公共执行器强行拒绝。
    const empty = addNode(doc, 'plein/video', {
      params: {
        model: 'volc/ark:doubao-seedance-2-5-260628',
        mode: 'reference',
        prompt: '',
        options: { 'volc/ark:doubao-seedance-2-5-260628': { adaptive_duration: true } },
      },
    })
    const source = createElement(doc, {
      kind: 'image',
      assetId: image.id,
      x: 0,
      y: 0,
      w: 100,
      h: 100,
    })
    connect(doc, [source, 'image'], [empty, 'images'])
    const automatic = await server.runs.preview(id, empty, 'local')
    expect(automatic.status).toBe('ready')
    expect(automatic.params.duration).toBe(-1)
    expect(await server.runs.wait(server.runs.start(id, empty, 'local'))).toBe('succeeded')
    const automaticBody = JSON.parse(String(http.mock.calls[2]![1]!.body))
    expect(automaticBody.content).toHaveLength(1)
    expect(automaticBody.duration).toBe(-1)
  }, 30_000)
})
