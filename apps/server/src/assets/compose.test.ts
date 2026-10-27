import { execFileSync, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import type { AssetRef, ComposeSpec } from '@plein/plugin-sdk'
import { describe, expect, it } from 'vite-plus/test'
import { tempDir } from '../testing'
import { composeVideo, envelopeExpr, validateComposeOverlays } from './compose'
import { ffmpegBin, h264Args, hasFfmpeg, mediaToolPaths, probeMedia } from './media'

const ffmpeg = await hasFfmpeg()
const ff = (...args: string[]) =>
  execFileSync(ffmpegBin(), ['-hide_banner', '-v', 'error', '-y', ...args], { encoding: 'utf8' })
const ref = <K extends 'video' | 'audio'>(assetId: string, kind: K): AssetRef & { kind: K } => ({
  assetId,
  kind,
})

const pixelAt = (file: string, time: number, x: number, y: number) => [
  ...execFileSync(ffmpegBin(), [
    '-v',
    'error',
    '-ss',
    String(time),
    '-i',
    file,
    '-vf',
    `crop=2:2:${x}:${y},scale=1:1`,
    '-frames:v',
    '1',
    '-pix_fmt',
    'rgb24',
    '-f',
    'rawvideo',
    'pipe:1',
  ]),
]

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
  it('五分钟低帧率素材只取片尾，两倍速实际输出保持时长、帧数与正确画面', async () => {
    const dir = tempDir('plein-compose-long-tail-')
    const clip = join(dir, 'long.webm')
    ff(
      '-f',
      'lavfi',
      '-i',
      "color=c=blue:s=32x32:d=300:r=1,drawbox=c=red:t=fill:enable='gte(t,298)'",
      '-c:v',
      'libvpx-vp9',
      '-deadline',
      'realtime',
      '-threads',
      '1',
      clip,
    )
    const info = await probeMedia(clip)
    expect(info.duration).toBeCloseTo(300, 2)
    const spec: ComposeSpec = {
      width: 320,
      height: 180,
      fps: 30,
      clips: [{ asset: ref('long', 'video'), in: 298, out: 300, speed: 2, volume: 0 }],
      audio: [],
    }
    const out = await composeVideo(spec, { clips: [clip], audio: [] }, { clips: [info] }, dir, {
      signal: new AbortController().signal,
    })
    const actual = JSON.parse(
      execFileSync(
        mediaToolPaths().ffprobe,
        [
          '-v',
          'error',
          '-select_streams',
          'v:0',
          '-count_frames',
          '-show_entries',
          'stream=duration,nb_read_frames',
          '-of',
          'json',
          out.file,
        ],
        { encoding: 'utf8' },
      ),
    ) as { streams: Array<{ duration: string; nb_read_frames: string }> }
    expect(Number(actual.streams[0]!.duration)).toBeCloseTo(1, 2)
    expect(out.duration).toBe(1)
    expect(Number(actual.streams[0]!.nb_read_frames)).toBe(30)
    for (const time of [0, 0.9]) {
      const pixel = pixelAt(out.file, time, 160, 90)
      expect(pixel).toHaveLength(3)
      expect(pixel[0]).toBeGreaterThan(230)
      expect(pixel[1]).toBeLessThan(20)
      expect(pixel[2]).toBeLessThan(20)
    }
  }, 30_000)

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

describe.skipIf(!ffmpeg)('transparent overlay composition', () => {
  it('真实 alpha、定位缩放、层序、透明度、独立入点速度和半开时间窗口；忽略叠加音轨', async () => {
    const dir = tempDir()
    const base = join(dir, 'blue.mp4')
    const overlay = join(dir, 'alpha.mov')
    ff('-f', 'lavfi', '-i', 'color=c=blue:s=160x120:r=30:d=2', ...(await h264Args()), base)
    // 左半红色实心、右半透明；音轨是明显正弦波，成片必须仍为静音。
    ff(
      '-f',
      'lavfi',
      '-i',
      'color=c=black@0:s=80x60:r=30:d=3,format=rgba,drawbox=x=0:y=0:w=40:h=60:c=red:t=fill:replace=1',
      '-f',
      'lavfi',
      '-i',
      'sine=f=880:d=3',
      '-c:v',
      'qtrle',
      '-pix_fmt',
      'argb',
      '-c:a',
      'pcm_s16le',
      '-shortest',
      overlay,
    )
    const layer = {
      id: 'red',
      asset: ref('alpha', 'video'),
      start: 0.5,
      duration: 1,
      in: 0.5,
      speed: 2,
      x: 0.25,
      y: 0.25,
      width: 0.5,
      height: 0.5,
      opacity: 0.5,
    }
    const spec: ComposeSpec = {
      width: 160,
      height: 120,
      fps: 30,
      clips: [{ asset: ref('blue', 'video'), in: 0, volume: 1 }],
      audio: [],
      overlays: [layer, { ...layer, id: 'front', x: 0.5, opacity: 1 }],
    }
    const out = await composeVideo(
      spec,
      { clips: [base], audio: [], overlays: [overlay, overlay] },
      {
        clips: [{ duration: 2, hasVideo: true, hasAudio: false }],
        overlays: Array.from({ length: 2 }, () => ({
          duration: 3,
          hasVideo: true,
          hasAudio: true,
          hasAlpha: true,
          videoCodec: 'qtrle',
        })),
      },
      dir,
      { signal: new AbortController().signal },
    )
    const pixel = (time: number, x: number, y: number) => pixelAt(out.file, time, x, y)
    const blue = (p: number[]) => {
      expect(p[0]).toBeLessThan(20)
      expect(p[2]).toBeGreaterThan(230)
    }
    blue(pixel(0.4, 50, 40))
    const half = pixel(0.7, 50, 40)
    expect(half[0]).toBeGreaterThan(105)
    expect(half[0]).toBeLessThan(150)
    expect(half[2]).toBeGreaterThan(105)
    expect(half[2]).toBeLessThan(150)
    // later layer wins and the transparent right half exposes the blue base.
    const top = pixel(0.7, 90, 40)
    expect(top[0]).toBeGreaterThan(230)
    expect(top[2]).toBeLessThan(20)
    blue(pixel(0.7, 130, 40))
    blue(pixel(0.7, 50, 100))
    blue(pixel(1.5, 50, 40))
    const audio = execFileSync(ffmpegBin(), [
      '-v',
      'error',
      '-i',
      out.file,
      '-vn',
      '-f',
      'f32le',
      'pipe:1',
    ])
    const values = new Float32Array(audio.buffer, audio.byteOffset, audio.length / 4)
    expect(values.reduce((max, v) => Math.max(max, Math.abs(v)), 0)).toBeLessThan(0.0001)
    expect((await probeMedia(out.file)).duration).toBeCloseTo(2, 1)
  }, 60_000)

  it('叠加源的入点与速度决定真实色彩切换，背景时间不二次变速', async () => {
    const dir = tempDir(),
      base = join(dir, 'base.mp4'),
      source = join(dir, 'changing.mov')
    ff('-f', 'lavfi', '-i', 'color=c=black:s=160x120:r=30:d=2', ...(await h264Args()), base)
    ff(
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=160x120:r=30:d=1',
      '-f',
      'lavfi',
      '-i',
      'color=c=green:s=160x120:r=30:d=1',
      '-filter_complex',
      '[0:v][1:v]concat=n=2:v=1:a=0,format=argb[v]',
      '-map',
      '[v]',
      '-c:v',
      'qtrle',
      source,
    )
    const spec: ComposeSpec = {
      width: 160,
      height: 120,
      fps: 30,
      clips: [{ asset: ref('base', 'video'), in: 0, volume: 0 }],
      audio: [],
      overlays: [
        {
          id: 'time',
          asset: ref('source', 'video'),
          start: 0.4,
          duration: 1,
          in: 0.5,
          speed: 1.5,
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          opacity: 1,
        },
      ],
    }
    const info = { duration: 2, hasVideo: true, hasAudio: false }
    const out = await composeVideo(
      spec,
      { clips: [base], audio: [], overlays: [source] },
      { clips: [info], overlays: [info] },
      dir,
      { signal: new AbortController().signal },
    )
    const pixel = (time: number) => pixelAt(out.file, time, 40, 40)
    expect(Math.max(...pixel(0.3))).toBeLessThan(12)
    expect(pixel(0.55)[0]).toBeGreaterThan(230)
    expect(pixel(1)[1]).toBeGreaterThan(100)
    expect(pixel(1)[0]).toBeLessThan(20)
    expect(Math.max(...pixel(1.4))).toBeLessThan(12)
  }, 60_000)

  it('源窗口不足、非视频和非有限几何在启动 FFmpeg 之前阻断', () => {
    const overlay = {
      id: 'bad',
      asset: ref('x', 'video'),
      start: 0,
      duration: 1,
      in: 0.5,
      speed: 2,
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      opacity: 1,
    }
    const spec: ComposeSpec = {
      width: 160,
      height: 120,
      fps: 30,
      clips: [],
      audio: [],
      overlays: [overlay],
    }
    expect(() =>
      validateComposeOverlays(spec, [{ duration: 1, hasVideo: true, hasAudio: false }], 2),
    ).toThrow('源素材不足')
    expect(() =>
      validateComposeOverlays(spec, [{ duration: 3, hasVideo: false, hasAudio: true }], 2),
    ).toThrow('不是视频')
    const many = {
      ...spec,
      overlays: Array.from({ length: 201 }, () => ({ ...overlay, in: 0, speed: 1 })),
    }
    const infos = many.overlays.map(() => ({ duration: 3, hasVideo: true, hasAudio: false }))
    expect(() => validateComposeOverlays(many, infos, 2)).toThrow('200')
    expect(() => validateComposeOverlays(many, infos, 2, true)).not.toThrow()
    overlay.x = NaN
    expect(() =>
      validateComposeOverlays(spec, [{ duration: 3, hasVideo: true, hasAudio: false }], 2),
    ).toThrow('时间或位置不合法')
  })
})
