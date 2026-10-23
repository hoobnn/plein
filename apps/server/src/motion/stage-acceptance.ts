/** Bundled by stage-acceptance.build.mjs and executed outside the checkout with Electron run-as-node. */
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MotionParams } from '@plein/nodes'
import { renderMotion } from './render'
import { motionRuntimeAssets } from './runtime'
import { resolveMotionWorkerPath } from './child'
import { runTool } from './process'
import { unzipSync, strFromU8 } from 'fflate'

const server = dirname(fileURLToPath(import.meta.url)),
  root = resolve(server, '..')
const ffmpeg = process.env.PLEIN_FFMPEG_PATH!,
  ffprobe = process.env.PLEIN_FFPROBE_PATH!,
  chromePath = process.env.PRODUCER_HEADLESS_SHELL_PATH!
if (!ffmpeg || !ffprobe || !chromePath)
  throw new Error('Explicit staged binaries and Chrome are required')
const stageRequire = createRequire(import.meta.url)
const assets = await motionRuntimeAssets(),
  worker = resolveMotionWorkerPath()
for (const file of [worker, assets.gsapPath, ...assets.files.map((asset) => asset.sourcePath)])
  if (!file.startsWith(server + sep)) throw new Error(`Runtime escaped copied stage: ${file}`)
const producer = import.meta.resolve('@hyperframes/producer'),
  sdk = import.meta.resolve('@hyperframes/sdk')
if (![producer, sdk].every((path) => fileURLToPath(path).startsWith(server + sep)))
  throw new Error('HyperFrames resolved outside copied stage')
let tsxAbsent = false
try {
  stageRequire.resolve('tsx')
} catch {
  tsxAbsent = true
}
if (!tsxAbsent) throw new Error('Copied stage unexpectedly resolves source-only tsx')
await mkdir(join(root, 'fixtures'), { recursive: true })
const input = join(root, 'fixtures/short.mp4')
await runTool(ffmpeg, [
  '-y',
  '-f',
  'lavfi',
  '-i',
  'color=c=green:s=320x180:r=30:d=0.75',
  '-c:v',
  'h264_videotoolbox',
  '-allow_sw',
  '1',
  '-b:v',
  '1M',
  input,
])
const params = MotionParams.parse({
  template: 'video-title',
  title: '随包独立运行 · 短素材窗口',
  subtitle: '2秒合成 / 素材仅显示0.5秒 / 无源码node_modules',
  duration: 2,
  resolution: '720p',
  aspectRatio: '16:9',
  sourceIn: 0.1,
  speed: 1,
  overrides: { 'hf-media.timing.start': 0.5, 'hf-media.timing.end': 1 },
})
const options = { ffmpeg, ffprobe, chromePath }
const binding = { video: { assetId: 'stage-short-video', path: input, mime: 'video/mp4' } }
const result = await renderMotion(params, binding, join(root, 'render'), options)
const probe = JSON.parse(
  (
    await runTool(ffprobe, [
      '-v',
      'error',
      '-show_streams',
      '-show_format',
      '-of',
      'json',
      result.outputPath,
    ])
  ).stdout,
)
const video = probe.streams.find((stream: { codec_type: string }) => stream.codec_type === 'video')
if (
  video?.codec_name !== 'h264' ||
  video.nb_frames !== '60' ||
  Math.abs(Number(probe.format.duration) - 2) > 1 / 30
)
  throw new Error('Unexpected staged MP4')
const files = unzipSync(result.sourceZip),
  manifest = JSON.parse(strFromU8(files['manifest.json']!))
if (
  manifest.params.overrides['hf-media.timing.end'] !== 1 ||
  manifest.dependencyAssetIds[0] !== 'stage-short-video' ||
  !files['hyperframes.lock.json']
)
  throw new Error('Staged source archive did not freeze its source')
await runTool(ffmpeg, [
  '-y',
  '-i',
  result.outputPath,
  '-vf',
  'select=eq(n\\,22)',
  '-frames:v',
  '1',
  join(root, 'stage-frame.png'),
])
async function fails(name: string, work: () => Promise<unknown>, expectedCode: string) {
  try {
    await work()
  } catch (error) {
    const value = error as Error & { code?: string; retryable?: boolean }
    if (value.code !== expectedCode || value.retryable !== false) throw error
    return { name, code: value.code, retryable: value.retryable, message: value.message }
  }
  throw new Error(`${name} unexpectedly passed`)
}
const tooLong = await fails(
  'source-window-too-long',
  () =>
    renderMotion(
      MotionParams.parse({
        ...params,
        overrides: { 'hf-media.timing.start': 0.5, 'hf-media.timing.end': 1.5 },
      }),
      binding,
      join(root, 'too-long'),
      options,
    ),
  'motion_invalid_input',
)
let missingWorker: Awaited<ReturnType<typeof fails>>
await rename(worker, worker + '.disabled')
try {
  missingWorker = await fails(
    'missing-worker',
    () => renderMotion(params, binding, join(root, 'missing-worker'), options),
    'motion_runtime_unavailable',
  )
} finally {
  await rename(worker + '.disabled', worker)
}
const font = assets.files.find((file) => file.path.endsWith('.woff2'))!
let missingFont: Awaited<ReturnType<typeof fails>>
await rename(font.sourcePath, font.sourcePath + '.disabled')
try {
  missingFont = await fails(
    'missing-font',
    () => renderMotion(params, binding, join(root, 'missing-font'), options),
    'motion_runtime_unavailable',
  )
} finally {
  await rename(font.sourcePath + '.disabled', font.sourcePath)
}
const summary = {
  schema: 'plein.motion-stage-acceptance.v1',
  node: process.versions.node,
  electron: process.versions.electron,
  runAsNode: process.env.ELECTRON_RUN_AS_NODE === '1',
  isolatedStage: true,
  sourceNodeModulesRequired: false,
  tsxAbsent,
  runtimeAssetsStayInsideStage: true,
  worker: 'server/motion/worker.mjs',
  workerSha256: createHash('sha256')
    .update(await readFile(worker))
    .digest('hex'),
  runtime: result.manifest.runtime,
  duration: probe.format.duration,
  frames: video.nb_frames,
  width: video.width,
  height: video.height,
  hasAudio: probe.streams.some((stream: { codec_type: string }) => stream.codec_type === 'audio'),
  fontSubsets: Object.keys(files).filter((file) => file.endsWith('.woff2')).length,
  sourceBytes: result.sourceZip.byteLength,
  params: manifest.params,
  warnings: result.warnings,
  negativeCases: [tooLong, missingWorker!, missingFont!],
  frame: 'stage-frame.png',
}
await writeFile(join(root, 'stage-acceptance.json'), JSON.stringify(summary, null, 2) + '\n')
console.log(JSON.stringify({ root, ...summary }, null, 2))
