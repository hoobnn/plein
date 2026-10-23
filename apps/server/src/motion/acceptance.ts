/** Real local acceptance for source trim/speed/audio, archive freeze and active cancellation. */
import { mkdtemp, writeFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { MotionParams } from '@plein/nodes'
import { renderMotion } from './render'
import { runTool } from './process'
import { unzipSync, strFromU8 } from 'fflate'

const ffmpeg = process.env.PLEIN_FFMPEG_PATH,
  ffprobe = process.env.PLEIN_FFPROBE_PATH,
  chromePath = process.env.PRODUCER_HEADLESS_SHELL_PATH
if (!ffmpeg || !ffprobe || !chromePath)
  throw new Error('Set explicit ffmpeg, ffprobe, chrome paths')
const dir = process.env.PLEIN_MOTION_SMOKE_DIR
  ? resolve(process.env.PLEIN_MOTION_SMOKE_DIR)
  : await mkdtemp(join(tmpdir(), 'plein-motion-acceptance-'))
const input = join(dir, 'source.mp4')
await runTool(ffmpeg, [
  '-y',
  '-f',
  'lavfi',
  '-i',
  'color=c=red:s=320x180:r=30:d=1',
  '-f',
  'lavfi',
  '-i',
  'color=c=green:s=320x180:r=30:d=1',
  '-f',
  'lavfi',
  '-i',
  'color=c=blue:s=320x180:r=30:d=1',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:sample_rate=48000:duration=3',
  '-filter_complex',
  '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]',
  '-map',
  '[v]',
  '-map',
  '3:a',
  '-c:v',
  'h264_videotoolbox',
  '-allow_sw',
  '1',
  '-b:v',
  '1M',
  '-c:a',
  'aac',
  input,
])
const params = MotionParams.parse({
  template: 'video-title',
  title: '真实素材 · 裁切与变速',
  subtitle: '1秒入点 / 2倍速 / 保留原声',
  duration: 1,
  resolution: '720p',
  aspectRatio: '16:9',
  sourceIn: 1,
  speed: 2,
  audio: 'source',
  overrides: { 'hf-title.style.color': '#ffee99' },
})
const out = await renderMotion(
  params,
  { video: { assetId: 'local-acceptance-video', mime: 'video/mp4', path: input } },
  join(dir, 'render'),
  { ffmpeg, ffprobe, chromePath },
)
const info = JSON.parse(
  (
    await runTool(ffprobe, [
      '-v',
      'error',
      '-show_streams',
      '-show_format',
      '-of',
      'json',
      out.outputPath,
    ])
  ).stdout,
) as {
  streams: { codec_type: string; codec_name: string; nb_frames?: string }[]
  format: { duration: string }
}
if (
  !info.streams.some((stream) => stream.codec_type === 'audio') ||
  info.streams.find((stream) => stream.codec_type === 'video')?.nb_frames !== '30'
)
  throw new Error('Audio or 30-frame video missing')
const entries = unzipSync(out.sourceZip),
  manifest = JSON.parse(strFromU8(entries['manifest.json']!))
if (
  manifest.params.sourceIn !== 1 ||
  manifest.params.speed !== 2 ||
  manifest.params.audio !== 'source' ||
  manifest.params.overrides['hf-title.style.color'] !== '#ffee99' ||
  manifest.dependencyAssetIds[0] !== 'local-acceptance-video'
)
  throw new Error('Manifest did not freeze exact params/bindings')
await runTool(ffmpeg, [
  '-y',
  '-i',
  out.outputPath,
  '-vf',
  'select=eq(n\\,5)',
  '-frames:v',
  '1',
  join(dir, 'trim-speed-before.png'),
])
await runTool(ffmpeg, [
  '-y',
  '-i',
  out.outputPath,
  '-vf',
  'select=eq(n\\,25)',
  '-frames:v',
  '1',
  join(dir, 'trim-speed-after.png'),
])
const controller = new AbortController(),
  started = Date.now()
let cancelStage = '',
  cancelled = false,
  cancelledAt = 0
try {
  await renderMotion(
    MotionParams.parse({ duration: 30, resolution: '720p' }),
    {},
    join(dir, 'cancel'),
    {
      ffmpeg,
      ffprobe,
      chromePath,
      signal: controller.signal,
      progress: (event) => {
        if (event.stage.startsWith('Streaming frame')) {
          cancelStage = event.stage
          cancelledAt = Date.now()
          controller.abort()
        }
      },
    },
  )
} catch (error) {
  if (error instanceof Error && error.name === 'AbortError') cancelled = true
  else throw error
}
if (!cancelled || !cancelStage) throw new Error('Active render cancellation failed')
const summary = {
  schema: 'plein.motion-acceptance.v1',
  engine: out.manifest.engine,
  runtime: out.manifest.runtime,
  identity: out.identity,
  params: manifest.params,
  dependencyAssetIds: manifest.dependencyAssetIds,
  output: {
    bytes: (await stat(out.outputPath)).size,
    duration: info.format.duration,
    streams: info.streams.map(({ codec_type, codec_name, nb_frames }) => ({
      codec_type,
      codec_name,
      nb_frames,
    })),
  },
  sourceBytes: out.sourceZip.byteLength,
  warnings: out.warnings,
  cancelled: {
    passed: cancelled,
    stage: cancelStage,
    elapsedMs: Date.now() - started,
    afterAbortMs: cancelledAt ? Date.now() - cancelledAt : null,
  },
  files: {
    output: out.outputPath,
    before: join(dir, 'trim-speed-before.png'),
    after: join(dir, 'trim-speed-after.png'),
  },
}
await writeFile(join(dir, 'acceptance.json'), JSON.stringify(summary, null, 2) + '\n')
console.log(JSON.stringify({ dir, ...summary }, null, 2))
