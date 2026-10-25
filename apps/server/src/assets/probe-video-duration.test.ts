import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vite-plus/test'
import { ffmpegBin, hasFfmpeg, probeMedia } from './media'
import { tempDir } from '../testing'

const available = await hasFfmpeg()
describe.skipIf(!available)('P11实际视频流时长不借用长音轨', () => {
  for (const [extension, video, audio] of [
    ['mp4', 2, 4],
    ['webm', 2, 4],
    ['webm', 8, 8],
  ] as const) {
    it(`${extension}: video=${video}s/audio=${audio}s，WebM只取该视频流DURATION标签`, async () => {
      const file = join(tempDir(), `duration.${extension}`)
      execFileSync(ffmpegBin(), [
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        `testsrc2=size=96x64:rate=30:duration=${video}`,
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=440:sample_rate=48000:duration=${audio}`,
        '-c:v',
        extension === 'webm' ? 'libvpx-vp9' : 'libx264',
        '-threads',
        '1',
        '-c:a',
        extension === 'webm' ? 'libopus' : 'aac',
        '-pix_fmt',
        'yuv420p',
        file,
      ])
      const actual = await probeMedia(file)
      expect(actual.videoDuration).toBeCloseTo(video, 2)
      expect(actual.duration).toBeCloseTo(audio, 1)
      if (extension === 'webm') {
        const raw = JSON.parse(
          execFileSync(
            process.env.FFPROBE_PATH || 'ffprobe',
            ['-v', 'error', '-show_streams', '-of', 'json', file],
            { encoding: 'utf8' },
          ),
        )
        const stream = raw.streams.find(
          (value: { codec_type: string }) => value.codec_type === 'video',
        )
        expect(Number.isFinite(Number(stream.duration)) && Number(stream.duration) > 0).toBe(false)
        expect(stream.tags.DURATION).toMatch(/^00:00:/)
      }
    }, 30_000)
  }
})
