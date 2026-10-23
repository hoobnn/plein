import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { zipSync } from 'fflate'
import {
  CAPTION_TEMPLATE_VERSION,
  CaptionLayerParams,
  captionDurationFrames,
  captionLayerHtml,
} from '@plein/nodes'
import { runMotionWorker } from './child'
import { motionRendererIdentity } from './identity'
import { probeMotionRuntime } from './probe'
import { abortError, motionEnvironment, MotionError } from './process'
import { HYPERFRAMES_VERSION, motionRuntimeAssets } from './runtime'
import { assertLocalMotionHtml } from './security'
import type { MotionRenderOptions } from './render'

export interface CaptionSourceManifest {
  schema: 'plein.caption-source.v1'
  templateVersion: number
  engine: { name: 'hyperframes'; version: string; fps: 30 }
  params: CaptionLayerParams
  dependencyAssetIds: string[]
  dimensions: { width: number; height: number }
  durationFrames: number
  renderIdentity: string
  files: { path: string; sha256: string; bytes: number }[]
  runtime?: { encoder: string; ffmpegVersion: string; ffprobeVersion: string }
}
export interface CaptionRenderResult {
  outputPath: string
  mime: 'video/webm'
  sourceZip: Uint8Array
  manifest: CaptionSourceManifest
  identity: string
  warnings: unknown[]
}
const utf8 = new TextEncoder()
const sha = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex')
function archive(entries: Record<string, Uint8Array>, manifest: CaptionSourceManifest) {
  return zipSync(
    Object.fromEntries(
      Object.entries({
        ...entries,
        'manifest.json': utf8.encode(JSON.stringify(manifest, null, 2) + '\n'),
      }).map(([path, data]) => [
        path,
        [data, { level: 0, mtime: new Date('1980-01-01T00:00:00Z') }],
      ]),
    ),
  )
}
function describe(
  params: CaptionLayerParams,
  entries: Record<string, Uint8Array>,
  renderer?: string,
  runtime?: CaptionSourceManifest['runtime'],
): CaptionSourceManifest {
  const files = Object.entries(entries)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, data]) => ({ path, sha256: sha(data), bytes: data.byteLength }))
  const frozen = JSON.parse(JSON.stringify(params)) as CaptionLayerParams
  return {
    schema: 'plein.caption-source.v1',
    templateVersion: CAPTION_TEMPLATE_VERSION,
    engine: { name: 'hyperframes', version: HYPERFRAMES_VERSION, fps: 30 },
    params: frozen,
    dependencyAssetIds: [],
    dimensions: { width: params.width, height: params.height },
    durationFrames: captionDurationFrames(params),
    files,
    renderIdentity: sha(
      JSON.stringify({
        adapter: 2,
        templateVersion: CAPTION_TEMPLATE_VERSION,
        params: frozen,
        files,
        renderer,
        runtime,
      }),
    ),
    ...(runtime ? { runtime } : {}),
  }
}
async function buildSource(
  value: CaptionLayerParams,
  assets?: MotionRenderOptions['runtimeAssets'],
) {
  const params = CaptionLayerParams.parse(value),
    runtime = assets ?? (await motionRuntimeAssets())
  const html = captionLayerHtml(params)
  assertLocalMotionHtml(html)
  const entries: Record<string, Uint8Array> = {
    'index.html': utf8.encode(html),
    'fonts/noto-sans-sc.css': utf8.encode(runtime.fontCss),
    'hyperframes.lock.json': utf8.encode(
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
    ),
  }
  for (const file of [
    { path: 'vendor/gsap.min.js', sourcePath: runtime.gsapPath },
    ...runtime.files,
  ]) {
    if (
      !/^[A-Za-z0-9_-][A-Za-z0-9_./-]*$/.test(file.path) ||
      file.path.split('/').some((part) => !part || part === '.' || part === '..')
    )
      throw new MotionError('motion_invalid_source', 'Invalid offline caption resource path')
    try {
      entries[file.path] = await readFile(file.sourcePath)
    } catch {
      throw new MotionError(
        'motion_runtime_unavailable',
        `Offline caption resource is missing or unreadable: ${file.path}`,
      )
    }
  }
  if (Object.values(entries).reduce((sum, bytes) => sum + bytes.byteLength, 0) > 256 * 1024 * 1024)
    throw new MotionError('motion_source_too_large', 'Caption source package exceeds 256 MiB')
  return { params, entries }
}

/** Build an editable offline source archive without starting a browser or encoder. */
export async function captionSourceArchive(params: CaptionLayerParams): Promise<Uint8Array> {
  const source = await buildSource(params)
  return archive(source.entries, describe(source.params, source.entries))
}

/** Trusted cue timings only. No transcription, speech synthesis or inferred word timestamps. */
export async function renderCaptionLayer(
  value: CaptionLayerParams,
  workDir: string,
  options: MotionRenderOptions,
): Promise<CaptionRenderResult> {
  if (options.signal?.aborted) throw abortError()
  const params = CaptionLayerParams.parse(value)
  if (!isAbsolute(workDir))
    throw new MotionError('motion_invalid_workdir', 'Caption workDir must be absolute')
  const projectDir = join(workDir, 'project'),
    home = join(workDir, 'home'),
    temp = join(workDir, 'tmp')
  await Promise.all([projectDir, home, temp].map((path) => mkdir(path, { recursive: true })))
  const env = motionEnvironment({ ...options, home, temp })
  options.progress?.({
    stage: 'preflight',
    percent: 0,
    message: 'Checking bundled VP9 alpha runtime',
  })
  const runtime = await probeMotionRuntime(
    { ...options, output: 'transparent-webm' },
    { env, signal: options.signal },
  )
  const { entries } = await buildSource(params, options.runtimeAssets)
  for (const [path, data] of Object.entries(entries)) {
    if (options.signal?.aborted) throw abortError()
    await mkdir(dirname(join(projectDir, path)), { recursive: true })
    await writeFile(join(projectDir, path), data)
  }
  const outputPath = join(workDir, 'output.webm')
  const rendered = await runMotionWorker(
    { projectDir, outputPath, format: 'webm', useGpu: false, chromePath: options.chromePath },
    { ...options, env },
  )
  if (options.signal?.aborted) throw abortError()
  const output = await stat(outputPath)
  if (!output.isFile() || !output.size)
    throw new MotionError('motion_render_failed', 'Caption renderer did not create a WebM')
  entries['index.html'] = await readFile(join(projectDir, 'index.html'))
  const manifest = describe(params, entries, motionRendererIdentity(options, options.chromePath), {
    encoder: runtime.encoder,
    ffmpegVersion: runtime.ffmpegVersion,
    ffprobeVersion: runtime.ffprobeVersion,
  })
  options.progress?.({
    stage: 'complete',
    percent: 100,
    message: 'Caption alpha layer and editable source package complete',
  })
  return {
    outputPath,
    mime: 'video/webm',
    sourceZip: archive(entries, manifest),
    manifest,
    identity: manifest.renderIdentity,
    warnings: rendered.warnings,
  }
}
