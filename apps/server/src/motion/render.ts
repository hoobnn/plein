import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { zipSync } from 'fflate'
import {
  motionHtml,
  motionSize,
  motionDurationFrames,
  MOTION_TEMPLATE_VERSION,
  MotionParams,
} from '@plein/nodes'
import { runMotionWorker, type MotionProgress } from './child'
import { probeMotionRuntime } from './probe'
import { abortError, motionEnvironment, MotionError, runTool } from './process'
import { motionRendererIdentity } from './identity'
import { assertLocalMotionHtml } from './security'
import { assertMotionSourceDuration } from './timing'
import { HYPERFRAMES_VERSION, motionRuntimeAssets, type MotionRuntimeAssets } from './runtime'

export interface MotionInput {
  assetId: string
  path: string
  mime: string
}
export interface MotionInputs {
  image?: MotionInput
  video?: MotionInput
}
export interface MotionRenderOptions {
  signal?: AbortSignal
  progress?: (event: MotionProgress) => void
  ffmpeg: string
  ffprobe: string
  chromePath?: string
  workerPath?: string
  nodePath?: string
  runtimeAssets?: MotionRuntimeAssets
}
export interface MotionManifest {
  schema: 'plein.motion-source.v1'
  templateVersion: number
  engine: { name: 'hyperframes'; version: string; fps: 30 }
  params: MotionParams
  dependencyAssetIds: string[]
  inputs: Record<
    string,
    { assetId: string; mime: string; path: string; sha256: string; bytes: number }
  >
  dimensions: { width: number; height: number }
  durationFrames: number
  renderIdentity: string
  files: { path: string; sha256: string; bytes: number }[]
  runtime: { encoder: string; ffmpegVersion: string; ffprobeVersion: string }
}
export interface MotionRenderResult {
  outputPath: string
  mime: 'video/mp4' | 'video/webm'
  sourceZip: Uint8Array
  manifest: MotionManifest
  identity: string
  warnings: unknown[]
}
const sha = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex')
const SOURCE_LIMIT = 256 * 1024 * 1024
const encoder = new TextEncoder()

/** Local templates only. Storage/asset creation is owned by the host after this resolves. */
export async function renderMotion(
  params: MotionParams,
  inputs: MotionInputs,
  workDir: string,
  options: MotionRenderOptions,
): Promise<MotionRenderResult> {
  if (options.signal?.aborted) throw abortError()
  params = MotionParams.parse(params)
  // Alpha layers are always silent, including the frozen editable source contract.
  if (params.output === 'transparent-webm') params = { ...params, audio: 'mute' }
  if (!isAbsolute(workDir))
    throw new MotionError('motion_invalid_workdir', 'Motion workDir must be absolute')
  const projectDir = join(workDir, 'project'),
    home = join(workDir, 'home'),
    temp = join(workDir, 'tmp')
  await Promise.all([
    mkdir(projectDir, { recursive: true }),
    mkdir(home, { recursive: true }),
    mkdir(temp, { recursive: true }),
  ])
  const env = motionEnvironment({ ...options, home, temp })
  options.progress?.({ stage: 'preflight', percent: 0, message: 'Checking bundled render runtime' })
  const runtime = await probeMotionRuntime(
    { ...options, output: params.output },
    { env, signal: options.signal },
  )
  const assets = options.runtimeAssets ?? (await motionRuntimeAssets())
  const entries: Record<string, Uint8Array> = {}
  let totalBytes = 0
  async function put(path: string, data: Uint8Array) {
    if (isAbsolute(path) || path.split(/[\\/]/).some((part) => part === '..' || part === ''))
      throw new MotionError('motion_invalid_source', `Invalid source entry: ${path}`)
    totalBytes += data.byteLength
    if (totalBytes > SOURCE_LIMIT)
      throw new MotionError('motion_source_too_large', 'Motion source package exceeds 256 MiB')
    entries[path] = data
    await mkdir(dirname(join(projectDir, path)), { recursive: true })
    await writeFile(join(projectDir, path), data)
  }
  async function putRuntime(path: string, sourcePath: string) {
    let data: Uint8Array
    try {
      data = await readFile(sourcePath)
    } catch {
      throw new MotionError(
        'motion_runtime_unavailable',
        `Offline motion runtime resource is missing or unreadable: ${path}`,
      )
    }
    await put(path, data)
  }
  await putRuntime('vendor/gsap.min.js', assets.gsapPath)
  await put('fonts/noto-sans-sc.css', encoder.encode(assets.fontCss))
  for (const file of assets.files) await putRuntime(file.path, file.sourcePath)
  const bindings: MotionManifest['inputs'] = {},
    media: { image?: string; video?: string } = {}
  for (const kind of ['image', 'video'] as const) {
    const input = inputs[kind]
    if (!input) continue
    if (!isAbsolute(input.path))
      throw new MotionError('motion_invalid_input', 'Motion asset paths must be absolute')
    if (!input.mime.startsWith(`${kind}/`))
      throw new MotionError('motion_invalid_input', `Expected ${kind} asset`)
    const info = await stat(input.path)
    if (!info.isFile() || info.size > SOURCE_LIMIT - totalBytes)
      throw new MotionError(
        'motion_source_too_large',
        'Motion input exceeds the source package limit',
      )
    const extensions: Record<string, string> = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/webp': 'webp',
      'image/avif': 'avif',
      'image/gif': 'gif',
      'video/mp4': 'mp4',
      'video/webm': 'webm',
      'video/quicktime': 'mov',
    }
    const ext = extensions[input.mime]
    if (!ext)
      throw new MotionError('motion_invalid_input', `Unsupported motion input MIME: ${input.mime}`)
    if (kind === 'video' && params.template === 'video-title') {
      const probe = await runTool(
        options.ffprobe,
        ['-v', 'error', '-show_format', '-of', 'json', input.path],
        { env, signal: options.signal },
      )
      const duration = Number(
        (JSON.parse(probe.stdout) as { format?: { duration?: string } }).format?.duration,
      )
      assertMotionSourceDuration(params, duration)
    }
    const path = `media/${kind}.${ext}`,
      data = await readFile(input.path)
    await put(path, data)
    media[kind] = path
    bindings[kind] = {
      assetId: input.assetId,
      mime: input.mime,
      path,
      sha256: sha(data),
      bytes: data.byteLength,
    }
  }
  const html = motionHtml(params, {
    ...media,
    gsap: 'vendor/gsap.min.js',
    fontCss: 'fonts/noto-sans-sc.css',
  })
  // Parse execution contexts so text content cannot masquerade as resource code.
  assertLocalMotionHtml(html)
  await put('index.html', encoder.encode(html))
  const format = params.output === 'transparent-webm' ? 'webm' : 'mp4'
  const mime = format === 'webm' ? ('video/webm' as const) : ('video/mp4' as const)
  const outputPath = join(workDir, `output.${format}`)
  const rendered = await runMotionWorker(
    { projectDir, outputPath, format, useGpu: runtime.useGpu, chromePath: options.chromePath },
    { ...options, env },
  )
  if (options.signal?.aborted) throw abortError()
  const output = await stat(outputPath)
  if (!output.isFile() || !output.size)
    throw new MotionError(
      'motion_render_failed',
      'Motion renderer did not create the requested video',
    )
  // SDK stamps stable hf-ids in the worker. Archive those exact rendered sources.
  entries['index.html'] = await readFile(join(projectDir, 'index.html'))
  entries['hyperframes.lock.json'] = encoder.encode(
    JSON.stringify(
      {
        producer: HYPERFRAMES_VERSION,
        sdk: HYPERFRAMES_VERSION,
        gsap: '3.14.2',
        font: '@fontsource/noto-sans-sc@5.2.8',
      },
      null,
      2,
    ) + '\n',
  )
  const files = Object.entries(entries)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, data]) => ({ path, sha256: sha(data), bytes: data.byteLength }))
  const frozen = JSON.parse(JSON.stringify(params)) as MotionParams
  const identity = sha(
    JSON.stringify({
      engine: HYPERFRAMES_VERSION,
      renderer: motionRendererIdentity(options, options.chromePath),
      runtime,
      params: frozen,
      files,
      inputs: bindings,
    }),
  )
  const manifest: MotionManifest = {
    schema: 'plein.motion-source.v1',
    templateVersion: MOTION_TEMPLATE_VERSION,
    engine: { name: 'hyperframes', version: HYPERFRAMES_VERSION, fps: 30 },
    params: frozen,
    inputs: bindings,
    dependencyAssetIds: [...new Set(Object.values(bindings).map((input) => input.assetId))],
    dimensions: motionSize(params),
    durationFrames: motionDurationFrames(params),
    renderIdentity: identity,
    files,
    runtime: {
      encoder: runtime.encoder,
      ffmpegVersion: runtime.ffmpegVersion,
      ffprobeVersion: runtime.ffprobeVersion,
    },
  }
  entries['manifest.json'] = encoder.encode(JSON.stringify(manifest, null, 2) + '\n')
  const sourceZip = zipSync(
    Object.fromEntries(
      Object.entries(entries).map(([path, data]) => [
        path,
        [data, { level: 0, mtime: new Date('1980-01-01T00:00:00Z') }],
      ]),
    ),
  )
  options.progress?.({
    stage: 'complete',
    percent: 100,
    message: 'Motion render and immutable source package complete',
  })
  return { outputPath, mime, sourceZip, manifest, identity, warnings: rendered.warnings }
}

export { motionRuntimeAssets } from './runtime'
export { probeMotionRuntime } from './probe'
export { MotionError } from './process'
