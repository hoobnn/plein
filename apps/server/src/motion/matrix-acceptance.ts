/** Additional positive matrix case only; run from the copied stage with Electron run-as-node. */
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MotionParams } from '@plein/nodes'
import { renderMotion } from './render'
import { runTool } from './process'

const server = dirname(fileURLToPath(import.meta.url)),
  root = resolve(server, '..')
const ffmpeg = process.env.PLEIN_FFMPEG_PATH!,
  ffprobe = process.env.PLEIN_FFPROBE_PATH!,
  chromePath = process.env.PRODUCER_HEADLESS_SHELL_PATH!
const metadata = JSON.parse(await readFile(join(root, 'matrix-metadata.json'), 'utf8'))
await mkdir(join(root, 'matrix-fixtures'), { recursive: true })
// Deterministic synthetic portrait fixture, with no real person or remote media dependency.
const width = 360,
  height = 480,
  pixels = Buffer.alloc(width * height * 3)
for (let y = 0; y < height; y++)
  for (let x = 0; x < width; x++) {
    let color = [22 + Math.round(y / 20), 42 + Math.round(x / 30), 65 + Math.round(y / 12)]
    if (((x - 180) / 155) ** 2 + ((y - 455) / 180) ** 2 < 1) color = [68, 142, 154]
    if ((x - 180) ** 2 + (y - 168) ** 2 < 78 ** 2) color = [240, 195, 157]
    if ((x - 180) ** 2 + (y - 128) ** 2 < 82 ** 2 && y < 145) color = [39, 40, 54]
    if ((x - 150) ** 2 + (y - 170) ** 2 < 5 ** 2 || (x - 210) ** 2 + (y - 170) ** 2 < 5 ** 2)
      color = [30, 31, 42]
    pixels.set(color, (y * width + x) * 3)
  }
const ppm = join(root, 'matrix-fixtures/portrait.ppm'),
  image = join(root, 'matrix-fixtures/portrait.png')
await writeFile(ppm, Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), pixels]))
await runTool(ffmpeg, ['-y', '-i', ppm, image])
const params = MotionParams.parse({
  template: 'character',
  title: '林若舟：在漫长风雪中守护最后的灯火',
  subtitle:
    '她穿越群山与无人问津的村落，把失散的故事一一带回。每一次停步，都让这段旅程有了继续向前的理由。',
  duration: 6,
  resolution: '720p',
  aspectRatio: '9:16',
  overrides: { 'hf-title.style.fontSize': '48px', 'hf-subtitle.style.fontSize': '26px' },
})
const started = performance.now()
const out = await renderMotion(
  params,
  { image: { assetId: 'matrix-synthetic-portrait', path: image, mime: 'image/png' } },
  join(root, 'matrix-character'),
  { ffmpeg, ffprobe, chromePath },
)
const elapsedMs = Math.round(performance.now() - started)
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
)
const video = info.streams.find((stream: { codec_type: string }) => stream.codec_type === 'video')
if (
  video?.width !== 720 ||
  video.height !== 1280 ||
  video.nb_frames !== '180' ||
  Math.abs(Number(info.format.duration) - 6) > 1 / 30 ||
  info.streams.some((stream: { codec_type: string }) => stream.codec_type === 'audio')
)
  throw new Error('Portrait character output does not match its specification')
await runTool(ffmpeg, [
  '-y',
  '-i',
  out.outputPath,
  '-vf',
  'select=eq(n\\,60)',
  '-frames:v',
  '1',
  join(root, 'matrix-portrait-frame.png'),
])
const originalSource = metadata.reusedVideoOutput
const reused = JSON.parse(
  (
    await runTool(ffprobe, [
      '-v',
      'error',
      '-show_streams',
      '-show_format',
      '-of',
      'json',
      originalSource,
    ])
  ).stdout,
)
const reusedVideo = reused.streams.find(
  (stream: { codec_type: string }) => stream.codec_type === 'video',
)
if (
  reusedVideo?.nb_frames !== '30' ||
  !reused.streams.some((stream: { codec_type: string }) => stream.codec_type === 'audio')
)
  throw new Error('Reused source-audio case is no longer valid')
const summary = {
  schema: 'plein.motion-positive-matrix.v1',
  scope:
    'Copied stage worker with Electron run-as-node and bundled FFmpeg; cached explicit Chrome. Not signed installed-app acceptance.',
  node: process.versions.node,
  electron: process.versions.electron,
  stageServer: metadata.stageServer,
  memory: {
    measured: false,
    reason:
      'No reliable whole-render peak measurement across worker, Chrome and FFmpeg; single Node maxRSS would undercount.',
  },
  cases: [
    {
      template: 'character',
      aspectRatio: '9:16',
      params,
      elapsedMs,
      output: {
        file: out.outputPath,
        bytes: (await stat(out.outputPath)).size,
        width: video.width,
        height: video.height,
        frames: video.nb_frames,
        duration: info.format.duration,
        codec: video.codec_name,
        audio: false,
      },
      imageFixture: 'Deterministic synthetic portrait; no real person or external API',
      warnings: out.warnings,
      frame: 'matrix-portrait-frame.png',
      typography:
        'Explicit fontSize overrides keep the long title and subtitle within their own slots; automatic text fitting is not asserted.',
    },
    {
      template: 'video-title',
      reused: true,
      evidence: 'source-media-acceptance.json',
      params: metadata.reusedVideoParams,
      renderElapsedMs: null,
      elapsedReason: 'Not recorded in the earlier successful render; not inferred or rerendered.',
      output: {
        file: originalSource,
        bytes: (await stat(originalSource)).size,
        width: reusedVideo.width,
        height: reusedVideo.height,
        frames: reusedVideo.nb_frames,
        duration: reused.format.duration,
        codec: reusedVideo.codec_name,
        audio: reused.streams
          .filter((stream: { codec_type: string }) => stream.codec_type === 'audio')
          .map((stream: { codec_name: string; sample_rate?: string; channels?: number }) => ({
            codec: stream.codec_name,
            sampleRate: stream.sample_rate,
            channels: stream.channels,
          })),
      },
      visualEvidence: {
        before: 'trim-speed-before.png',
        after: 'trim-speed-after.png',
        observation: 'Frame 5 is green, frame 25 is blue, consistent with sourceIn=1 and speed=2.',
      },
    },
  ],
}
await writeFile(join(root, 'matrix-acceptance.json'), JSON.stringify(summary, null, 2) + '\n')
console.log(JSON.stringify({ root, ...summary }, null, 2))
