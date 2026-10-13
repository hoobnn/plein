import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { h264Args, setMediaTools } from './media'

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
