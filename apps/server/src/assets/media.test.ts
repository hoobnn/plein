import { execFileSync, spawnSync } from 'node:child_process'
import sharp from 'sharp'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { h264Args, probeMedia, setMediaTools, videoFilmstrip } from './media'

const dirs: string[] = []
afterEach(() => {
  setMediaTools({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' })
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** 假的 ffmpeg：-encoders 只列出给定的编码器 */
function fakeFfmpeg(encoders: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'plein-ffmpeg-'))
  dirs.push(dir)
  const file = join(dir, 'ffmpeg')
  const lines = encoders.map((e) => ` V....D ${e.padEnd(20)} 测试`).join('\n')
  writeFileSync(file, `#!/bin/sh\ncat <<'EOF'\nEncoders:\n ------\n${lines}\nEOF\n`)
  chmodSync(file, 0o755)
  setMediaTools({ ffmpeg: file, ffprobe: file })
}

describe('H.264 编码器', () => {
  it('有 libx264 时优先用它', async () => {
    fakeFfmpeg(['h264_videotoolbox', 'libx264'])
    expect((await h264Args()).slice(0, 2)).toEqual(['-c:v', 'libx264'])
  })

  it('LGPL 构建没有 libx264 时用 VideoToolbox', async () => {
    fakeFfmpeg(['h264_videotoolbox', 'png'])
    const args = await h264Args()
    expect(args.slice(0, 2)).toEqual(['-c:v', 'h264_videotoolbox'])
    expect(args.slice(-2)).toEqual(['-pix_fmt', 'yuv420p'])
  })

  it('都没有时给出能看懂的错误', async () => {
    fakeFfmpeg(['png'])
    await expect(h264Args()).rejects.toThrow('没有 H.264 编码器')
  })
})

const ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0

describe.skipIf(!ffmpegAvailable)('胶片条的稀疏帧与短视频', () => {
  for (const [rate, duration] of [
    [8, 2],
    [1, 2],
    [25, 0.04],
  ]) {
    it(`${rate}fps / ${duration}s 的胶片条填满十六格且没有空白尾格`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'plein-filmstrip-'))
      dirs.push(dir)
      const src = join(dir, 'clip.webm')
      const out = join(dir, 'strip.webp')
      execFileSync('ffmpeg', [
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        `color=c=red:s=96x64:d=${duration}:r=${rate}`,
        '-c:v',
        'libvpx-vp9',
        '-deadline',
        'realtime',
        src,
      ])
      await videoFilmstrip(src, out, duration!, 16)
      const meta = await sharp(out).metadata()
      expect([meta.width, meta.height]).toEqual([136 * 16, 90])
      const { data, info } = await sharp(out)
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
      for (let k = 0; k < 16; k++) {
        const at = (45 * info.width + k * 136 + 68) * info.channels
        expect(data[at]).toBeGreaterThan(200)
        expect(data[at + 1]).toBeLessThan(40)
        expect(data[at + 2]).toBeLessThan(40)
      }
    }, 30_000)
  }

  it('单帧每秒的视频仍按先红后蓝的时间顺序取样', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plein-filmstrip-colors-'))
    dirs.push(dir)
    const src = join(dir, 'clip.webm')
    const out = join(dir, 'strip.webp')
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=96x64:d=1:r=1',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=96x64:d=1:r=1',
      '-filter_complex',
      '[0:v][1:v]concat=n=2:v=1:a=0',
      '-c:v',
      'libvpx-vp9',
      '-deadline',
      'realtime',
      src,
    ])
    await videoFilmstrip(src, out, 2, 16)
    const { data, info } = await sharp(out)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    for (let k = 0; k < 16; k++) {
      const at = (45 * info.width + k * 136 + 68) * info.channels
      expect(data[at + (k < 8 ? 0 : 2)]).toBeGreaterThan(200)
      expect(data[at + (k < 8 ? 2 : 0)]).toBeLessThan(40)
    }
  }, 30_000)
})

describe('参考视频编码与帧率探测', () => {
  it.each([
    ['24000/1001', '30/1', 24000 / 1001],
    ['0/0', '60/1', 60],
    ['N/A', '24', 24],
    ['0/0', '0/0', undefined],
    ['Infinity', '-1/1', undefined],
  ])('avg=%s / r=%s => %s', async (avg, raw, expected) => {
    const dir = mkdtempSync(join(tmpdir(), 'plein-probe-'))
    dirs.push(dir)
    const file = join(dir, 'ffprobe')
    const payload = {
      streams: [
        {
          codec_type: 'video',
          disposition: { attached_pic: 1 },
          codec_name: 'mjpeg',
          avg_frame_rate: '1/1',
        },
        {
          codec_type: 'video',
          codec_name: 'hevc',
          avg_frame_rate: avg,
          r_frame_rate: raw,
          width: 640,
          height: 256,
        },
        { codec_type: 'audio', codec_name: 'aac' },
        { codec_type: 'audio', codec_name: 'mp3' },
        { codec_type: 'audio' },
      ],
      format: { duration: '5' },
    }
    writeFileSync(file, `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(payload)}\nJSON\n`)
    chmodSync(file, 0o755)
    setMediaTools({ ffmpeg: file, ffprobe: file })
    const info = await probeMedia('unused')
    expect(info).toMatchObject({
      videoCodec: 'hevc',
      audioCodecs: ['aac', 'mp3', 'unknown'],
      width: 640,
      height: 256,
    })
    expect(info.frameRate).toBe(expected)
  })
  it.skipIf(!ffmpegAvailable)('真实 H.264 无音轨视频保留编码、分数帧率与无音轨事实', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plein-reference-video-'))
    dirs.push(dir)
    const file = join(dir, 'clip.mp4')
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=s=256x256:r=24000/1001:d=2',
      ...(await h264Args()),
      '-an',
      file,
    ])
    const info = await probeMedia(file)
    expect(info).toMatchObject({
      videoCodec: 'h264',
      audioCodecs: [],
      width: 256,
      height: 256,
      hasAudio: false,
    })
    expect(info.frameRate).toBeCloseTo(24000 / 1001, 5)
  })
})
