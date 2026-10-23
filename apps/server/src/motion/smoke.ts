/** Opt-in actual runtime acceptance; no provider calls. Host passes explicit installed binaries. */
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { MotionParams } from '@plein/nodes'
import { renderMotion } from './render'
import { runTool } from './process'
import { unzipSync, strFromU8 } from 'fflate'

const ffmpeg = process.env.PLEIN_FFMPEG_PATH
const ffprobe = process.env.PLEIN_FFPROBE_PATH
const chromePath = process.env.PRODUCER_HEADLESS_SHELL_PATH
if (!ffmpeg || !ffprobe || !chromePath)
  throw new Error(
    'Set absolute PLEIN_FFMPEG_PATH, PLEIN_FFPROBE_PATH and PRODUCER_HEADLESS_SHELL_PATH',
  )
const workDir = process.env.PLEIN_MOTION_SMOKE_DIR
  ? resolve(process.env.PLEIN_MOTION_SMOKE_DIR)
  : await mkdtemp(join(tmpdir(), 'plein-motion-smoke-'))
const result = await renderMotion(
  MotionParams.parse({
    template: 'title',
    title: process.env.PLEIN_MOTION_SMOKE_TITLE ?? '动态合成 · 本地验收',
    subtitle: '离线字体 / 不调用付费服务',
    duration: 1,
    resolution: '720p',
    aspectRatio: '16:9',
  }),
  {},
  workDir,
  {
    ffmpeg,
    ffprobe,
    chromePath,
    progress: (event) => console.log(JSON.stringify(event)),
  },
)
await writeFile(join(workDir, 'source.zip'), result.sourceZip)
const probe = await runTool(ffprobe, [
  '-v',
  'error',
  '-show_streams',
  '-show_format',
  '-of',
  'json',
  result.outputPath,
])
const info = JSON.parse(probe.stdout) as {
  streams: {
    codec_type: string
    codec_name: string
    width: number
    height: number
    nb_frames?: string
  }[]
  format: { duration: string }
}
const video = info.streams.find((stream) => stream.codec_type === 'video')
if (
  video?.codec_name !== 'h264' ||
  video.width !== 1280 ||
  video.height !== 720 ||
  video.nb_frames !== '30'
)
  throw new Error(`Unexpected output: ${probe.stdout}`)
const source = unzipSync(result.sourceZip)
const manifest = JSON.parse(strFromU8(source['manifest.json']!)) as { renderIdentity: string }
if (
  manifest.renderIdentity !== result.identity ||
  !source['fonts/noto-sans-sc.css'] ||
  !source['vendor/gsap.min.js']
)
  throw new Error('Source archive is incomplete')
await runTool(ffmpeg, [
  '-y',
  '-i',
  result.outputPath,
  '-vf',
  'select=eq(n\\,15)',
  '-frames:v',
  '1',
  join(workDir, 'frame.png'),
])
console.log(
  JSON.stringify(
    {
      workDir,
      identity: result.identity,
      output: result.outputPath,
      sourceBytes: result.sourceZip.byteLength,
      fontSubsets: Object.keys(source).filter((file) => file.endsWith('.woff2')).length,
      video,
      duration: info.format.duration,
      warnings: result.warnings,
    },
    null,
    2,
  ),
)
