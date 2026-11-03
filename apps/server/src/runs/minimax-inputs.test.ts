import { execFileSync, spawnSync } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { connect, createElement } from '@plein/doc'
import type { ProviderContext } from '@plein/plugin-sdk'
import { minimaxProvider } from '@plein/providers'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { sineWav, solidPng } from '../../../../packages/providers/src/mock/media'
import { MOCK_WEBM_BASE64 } from '../../../../packages/providers/src/mock/video-fixture'
import { h264Args } from '../assets/media'
import { addNode, bootServer, createCanvas, tempDir } from '../testing'

const available = ['ffmpeg', 'ffprobe'].every(
  (tool) => spawnSync(tool, ['-version'], { stdio: 'ignore' }).status === 0,
)
afterEach(() => vi.restoreAllMocks())

describe.skipIf(!available)('MiniMax 真实素材经过宿主到 HTTP 请求的本地验收', () => {
  it('仅尾帧、三类参考使用真实文件；非法尺寸、编码和帧率在联网前阻断', async () => {
    const { server } = await bootServer()
    server.plugins.configs.update('minimax/api', {
      enabled: true,
      secrets: { MINIMAX_API_KEY: 'local-contract-test' },
    })
    const { id, doc } = await createCanvas(server)
    const http = vi.fn<ProviderContext['fetch']>(async () =>
      Response.json({ task_id: 'local-task' }),
    )
    const original = minimaxProvider.submit
    vi.spyOn(minimaxProvider, 'submit').mockImplementation(async (req, ctx) => {
      // Only replace the external HTTP boundary; retain real host file reads and provider validation.
      const submitted = await original(req, { ...ctx, fetch: http })
      expect(submitted).toMatchObject({ state: 'pending', remoteId: 'local-task' })
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
    const ingest = async (data: Uint8Array, mime: string, name: string) =>
      server.assets.ingest('local', Readable.from([data]), { mime, name })
    const frame = await ingest(solidPng(256, 256, [80, 90, 100]), 'image/png', 'frame.png')
    const small = await ingest(solidPng(128, 128, [80, 90, 100]), 'image/png', 'small.png')
    const audio = await ingest(sineWav(2), 'audio/wav', 'reference.wav')
    const clip = async (tag: string, fps: number, codec: string[]) => {
      const file = join(tempDir(), `${tag}.mp4`)
      execFileSync('ffmpeg', [
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        `color=s=256x256:r=${fps}:d=2`,
        ...codec,
        '-an',
        file,
      ])
      return server.assets.ingest('local', createReadStream(file), {
        mime: 'video/mp4',
        name: `${tag}.mp4`,
      })
    }
    const h264 = await h264Args()
    const good = await clip('good', 30, h264)
    const slow = await clip('slow', 10, h264)
    const unsupported = await clip('unsupported', 30, ['-c:v', 'mpeg4'])
    const prepare = async (mode: string, assets: Array<typeof frame>) => {
      const target = addNode(doc, 'plein/video', {
        params: { mode, model: 'minimax/api:MiniMax-H3', prompt: '缓慢移动并以参考画面结束' },
      })
      for (const asset of assets) {
        if (asset.kind === 'file') throw new Error('测试只接受图片、视频或音频')
        const source = createElement(doc, {
          kind: asset.kind,
          assetId: asset.id,
          x: 0,
          y: 0,
          w: 100,
          h: 100,
        })
        const port =
          asset.kind === 'video' ? 'videos' : asset.kind === 'audio' ? 'audios' : 'images'
        connect(doc, [source, asset.kind], [target, port])
      }
      return { target, preview: await server.runs.preview(id, target, 'local') }
    }
    const run = async (mode: string, assets: Array<typeof frame>) => {
      const { target, preview } = await prepare(mode, assets)
      expect(preview.status).toBe('ready')
      return server.runs.wait(server.runs.start(id, target, 'local'))
    }
    expect(await run('lastFrame', [frame])).toBe('succeeded')
    const body = (index: number) => JSON.parse(String(http.mock.calls[index]![1]!.body))
    expect(body(0).content).toEqual([
      { type: 'text', text: '缓慢移动并以参考画面结束' },
      {
        type: 'image_url',
        role: 'last_frame',
        image_url: { url: expect.stringMatching(/^data:image\/png;base64,/) },
      },
    ])
    expect(body(0).ratio).toBe('adaptive')
    expect(await run('reference', [frame, good, audio])).toBe('succeeded')
    expect(body(1).content.map((item: { role?: string }) => item.role)).toEqual([
      undefined,
      'reference_image',
      'reference_video',
      'reference_audio',
    ])
    // 尺寸、帧率与编码不合要求的素材在运行前就被挡住，用户不用等上游报错
    const smallFrame = await prepare('lastFrame', [small])
    expect(smallFrame.preview.status).toBe('blocked')
    expect(smallFrame.preview.blocked?.map((issue) => issue.message).join('；')).toContain(
      '128×128',
    )
    const slowVideo = await prepare('reference', [slow])
    expect(slowVideo.preview.status).toBe('blocked')
    expect(slowVideo.preview.blocked?.map((issue) => issue.message).join('；')).toContain(
      '帧率 10 fps',
    )
    const unsupportedVideo = await prepare('reference', [unsupported])
    expect(unsupportedVideo.preview.status).toBe('blocked')
    expect(unsupportedVideo.preview.blocked?.map((issue) => issue.message).join('；')).toContain(
      '编码',
    )
    expect(http).toHaveBeenCalledTimes(2)
  }, 30_000)
})
