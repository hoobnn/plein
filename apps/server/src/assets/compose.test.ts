import { execFileSync, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import type { AssetRef, ComposeSpec } from '@plein/plugin-sdk'
import { describe, expect, it } from 'vite-plus/test'
import { tempDir } from '../testing'
import { composeVideo, envelopeExpr } from './compose'
import { ffmpegBin, h264Args, hasFfmpeg, probeMedia } from './media'

const ffmpeg = await hasFfmpeg()
const ff = (...args: string[]) =>
  execFileSync(ffmpegBin(), ['-hide_banner', '-v', 'error', '-y', ...args], { encoding: 'utf8' })
const ref = (assetId: string, kind: 'video' | 'audio'): AssetRef => ({ assetId, kind })

describe('envelopeExpr', () => {
  it('分段线性，两端保持端点值，时间按这条声音的起点平移', () => {
    const expr = envelopeExpr(
      [
        [1, 1],
        [2, 0.5],
      ],
      0.5,
    )
    expect(expr).toBe('if(lt(t,0.5),1,if(lt(t,1.5),1+(-0.5)*(t-0.5)/1,0.5))')
  })
})

describe.skipIf(!ffmpeg)('composeVideo', () => {
  it('逐段转场、变速、配乐包络和响度标准化', async () => {
    const dir = tempDir()
    const encoder = await h264Args()
    const clips = [0, 1, 2, 3].map((i) => {
      const file = join(dir, `c${i}.mp4`)
      ff(
        ...['-f', 'lavfi', '-i', `testsrc2=s=320x240:d=2:r=25`],
        ...['-f', 'lavfi', '-i', `sine=f=${300 + i * 200}:d=2`],
        ...encoder,
        '-shortest',
        file,
      )
      return file
    })
    const music = join(dir, 'm.wav')
    ff('-f', 'lavfi', '-i', 'sine=f=220:d=1.5', music)
    const spec: ComposeSpec = {
      width: 320,
      height: 240,
      fps: 25,
      clips: [
        { asset: ref('a', 'video'), in: 0, volume: 1, speed: 2 },
        { asset: ref('b', 'video'), in: 0, volume: 1, transition: { type: 'wipe', duration: 0.4 } },
        { asset: ref('c', 'video'), in: 0, volume: 1, transition: { type: 'fade', duration: 0.6 } },
        {
          asset: ref('d', 'video'),
          in: 0,
          volume: 1,
          transition: { type: 'dissolve', duration: 0.4 },
        },
      ],
      audio: [
        {
          asset: ref('m', 'audio'),
          start: 0,
          volume: 0.5,
          loop: true,
          fadeOut: 1,
          envelope: [
            [1, 1],
            [1.2, 0.3],
            [2, 0.3],
            [2.4, 1],
          ],
        },
      ],
      loudnorm: true,
    }
    const info = { duration: 2, hasVideo: true, hasAudio: true }
    const out = await composeVideo(
      spec,
      { clips, audio: [music] },
      { clips: [info, info, info, info] },
      dir,
      { signal: new AbortController().signal },
    )
    // 1（两倍速）+ 2 - 0.4（划像重叠）+ 2（经黑场 concat）+ 2 - 0.4（再叠化）
    expect(out.duration).toBeCloseTo(6.2, 2)
    const probe = await probeMedia(out.file)
    expect(probe.duration).toBeCloseTo(6.2, 1)
    // 成片响度在 -14 LUFS 附近（短片段上单遍 loudnorm 有一两 LU 的误差）
    const { stderr } = spawnSync(
      ffmpegBin(),
      ['-hide_banner', '-nostats', '-i', out.file, '-af', 'ebur128', '-f', 'null', '-'],
      { encoding: 'utf8' },
    )
    const integrated = Number(/Summary:[\s\S]*?I:\s+(-?[\d.]+) LUFS/.exec(stderr)?.[1])
    expect(integrated).toBeGreaterThan(-17)
    expect(integrated).toBeLessThan(-11)
  }, 60_000)

  it('画面都没有声音、也没有配音配乐时开着响度标准化也能合成', async () => {
    const dir = tempDir()
    const clip = join(dir, 'silent.mp4')
    ff('-f', 'lavfi', '-i', 'testsrc2=s=160x120:d=1:r=25', ...(await h264Args()), clip)
    const spec: ComposeSpec = {
      width: 160,
      height: 120,
      fps: 25,
      clips: [0, 1].map(() => ({ asset: ref('a', 'video'), in: 0, volume: 1 })),
      audio: [],
      loudnorm: true,
    }
    const info = { duration: 1, hasVideo: true, hasAudio: false }
    const out = await composeVideo(
      spec,
      { clips: [clip, clip], audio: [] },
      { clips: [info, info] },
      dir,
      {
        signal: new AbortController().signal,
      },
    )
    expect((await probeMedia(out.file)).hasAudio).toBe(true)
  }, 60_000)
})
