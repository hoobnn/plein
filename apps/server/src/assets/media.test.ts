import { execFileSync, spawnSync } from 'node:child_process'
import sharp from 'sharp'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { h264Args, setMediaTools, videoFilmstrip } from './media'

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
