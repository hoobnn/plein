import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { animaticNode } from '@plein/nodes'
import type { ComposeSpec } from '@plein/plugin-sdk'
import sharp from 'sharp'
import { describe, expect, it, vi } from 'vite-plus/test'
import { tempDir } from '../testing'
import { composeVideo } from '../assets/compose'
import { hasFfmpeg, probeMedia } from '../assets/media'
import { animaticExecutor } from './animatic'

const hasMedia = await hasFfmpeg()
const hash = 'a'.repeat(64)
describe('分镜样片本地执行', () => {
  it('只有本地图片快照与显式占位，没有平台调用；时长按草稿编辑值', async () => {
    const data = await sharp({ create: { width: 160, height: 90, channels: 3, background: 'red' } })
      .png()
      .toBuffer()
    const providers = { call: vi.fn() }
    const compose = vi.fn(async (_spec: ComposeSpec) => ({
      assetId: 'film',
      kind: 'video' as const,
    }))
    const put = vi.fn(async (_file: { data: Uint8Array }) => ({
      assetId: hash,
      kind: 'image' as const,
    }))
    await animaticExecutor.run({
      params: animaticNode.params.parse({
        resolution: '720p',
        aspectRatio: '16:9',
        subtitles: false,
        shots: [
          { shotId: 'one', imageAssetId: hash, duration: 1.2 },
          { shotId: 'missing', duration: 2.3 },
        ],
      }),
      inputs: {},
      providers,
      progress: vi.fn(),
      assets: { read: async () => ({ data, mime: 'image/png' }), put },
      media: { probe: vi.fn(), compose },
    } as unknown as Parameters<typeof animaticExecutor.run>[0])
    expect(providers.call).not.toHaveBeenCalled()
    expect(put).toHaveBeenCalledTimes(2)
    const spec = compose.mock.calls[0]![0]
    expect(spec.clips.map((c) => c.out)).toEqual([1.2, 2.3])
    expect(spec.clips.every((c) => c.asset.kind === 'image' && c.volume === 0)).toBe(true)
    expect(await sharp(put.mock.calls[1]![0].data).metadata()).toMatchObject({
      width: 1280,
      height: 720,
    })
  })
  it.skipIf(!hasMedia)('静态分镜图实际合成为有计划时长的 MP4', async () => {
    const dir = tempDir()
    const png = join(dir, 'still.png')
    writeFileSync(
      png,
      await sharp({ create: { width: 160, height: 90, channels: 3, background: 'navy' } })
        .png()
        .toBuffer(),
    )
    const result = await composeVideo(
      {
        width: 320,
        height: 180,
        fps: 25,
        audio: [],
        clips: [{ asset: { assetId: hash, kind: 'image' }, in: 0, out: 1.4, volume: 0 }],
      },
      { clips: [png], audio: [] },
      { clips: [await probeMedia(png)] },
      dir,
      { signal: new AbortController().signal },
    )
    expect((await probeMedia(result.file)).duration).toBeCloseTo(1.4, 1)
  })
})
