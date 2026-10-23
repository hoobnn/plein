/** Actual local VP9 alpha acceptance. Run through alpha-acceptance.build.mjs for isolated stage proof. */
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { readFile, writeFile, mkdir, stat, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { unzipSync, strFromU8 } from 'fflate'
import type { CaptionSourceManifest } from './captions'
import type { MotionManifest } from './render'
import { MotionParams, CaptionLayerParams } from '@plein/nodes'
import { renderMotion } from './render'
import { renderCaptionLayer } from './captions'
import { runTool } from './process'

const base = dirname(dirname(fileURLToPath(import.meta.url)))
const ffmpeg = process.env.PLEIN_FFMPEG_PATH!,
  ffprobe = process.env.PLEIN_FFPROBE_PATH!,
  chromePath = process.env.PRODUCER_HEADLESS_SHELL_PATH!
if (!ffmpeg || !ffprobe || !chromePath)
  throw new Error('Explicit ffmpeg, ffprobe and Chrome paths required')
const options = {
  ffmpeg,
  ffprobe,
  chromePath,
  workerPath: join(dirname(fileURLToPath(import.meta.url)), 'motion/worker.mjs'),
  progress: (event: { stage: string; percent: number }) => console.log(JSON.stringify(event)),
}
const captionParams = CaptionLayerParams.parse({
  width: 1280,
  height: 720,
  fps: 30,
  duration: 2,
  style: 'boxed',
  animation: 'pop',
  cues: [
    {
      id: 'manual-1',
      source: 'clip-A',
      origin: 'manual',
      start: 0.2,
      end: 0.9,
      text: '真实中文动画字幕 · Alpha',
    },
    {
      id: 'estimated-2',
      source: 'clip-B',
      origin: 'estimated',
      start: 1.1,
      end: 1.8,
      text: '保留来源，只按整句时间动画',
    },
  ],
})
const outputs = []
for (const kind of ['motion', 'captions'] as const) {
  const started = performance.now(),
    dir = join(base, `alpha-${kind}`)
  await mkdir(dir, { recursive: true })
  const sourceZip = process.env.PLEIN_MOTION_ALPHA_REUSE
    ? new Uint8Array(await readFile(join(dir, 'source.zip')))
    : undefined
  const reusedManifest = sourceZip
    ? (JSON.parse(strFromU8(unzipSync(sourceZip)['manifest.json']!)) as
        | MotionManifest
        | CaptionSourceManifest)
    : undefined
  const result =
    sourceZip && reusedManifest
      ? {
          outputPath: join(dir, 'output.webm'),
          mime: 'video/webm',
          sourceZip,
          identity: reusedManifest.renderIdentity,
          warnings: [],
          manifest: reusedManifest,
        }
      : kind === 'motion'
        ? await renderMotion(
            MotionParams.parse({
              title: '透明标题 · HyperFrames',
              subtitle: '随包 VP9 / 无背景 / 静音',
              output: 'transparent-webm',
              audio: 'source',
              duration: 2,
              aspectRatio: '16:9',
              resolution: '720p',
            }),
            {},
            dir,
            options,
          )
        : await renderCaptionLayer(captionParams, dir, options)
  const elapsedMs = Math.round(performance.now() - started)
  await writeFile(join(dir, 'source.zip'), result.sourceZip)
  const probe = JSON.parse(
    (
      await runTool(ffprobe, [
        '-v',
        'error',
        '-count_frames',
        '-show_streams',
        '-show_format',
        '-of',
        'json',
        result.outputPath,
      ])
    ).stdout,
  ) as {
    streams: {
      codec_name: string
      codec_type: string
      width: number
      height: number
      nb_read_frames: string
      tags?: Record<string, string>
    }[]
    format: { duration: string }
  }
  const video = probe.streams.find((v) => v.codec_type === 'video')!
  if (
    video.codec_name !== 'vp9' ||
    video.width !== 1280 ||
    video.height !== 720 ||
    video.nb_read_frames !== '60' ||
    (video.tags?.ALPHA_MODE ?? video.tags?.alpha_mode) !== '1' ||
    probe.streams.some((v) => v.codec_type === 'audio')
  )
    throw new Error(`Invalid alpha output: ${JSON.stringify(probe)}`)
  const png = join(dir, 'alpha-frame.png')
  await runTool(ffmpeg, [
    '-y',
    '-c:v',
    'libvpx-vp9',
    '-i',
    result.outputPath,
    '-vf',
    'select=eq(n\\,15),format=rgba',
    '-frames:v',
    '1',
    png,
  ])
  const pixels = await sharp(png).ensureAlpha().raw().toBuffer()
  let clear = 0,
    opaque = 0,
    partial = 0
  for (let n = 3; n < pixels.length; n += 4) {
    const a = pixels[n]!
    if (a === 0) clear++
    else if (a === 255) opaque++
    else partial++
  }
  if (clear < 1280 * 720 * 0.5 || opaque < 100 || partial < 10)
    throw new Error(`Alpha lost: ${JSON.stringify({ clear, opaque, partial })}`)
  const hiddenFrames: { frame: number; visiblePixels: number }[] = []
  if (kind === 'captions')
    for (const frame of [0, 30, 59]) {
      const hidden = join(dir, `hidden-${frame}.png`)
      await runTool(ffmpeg, [
        '-y',
        '-c:v',
        'libvpx-vp9',
        '-i',
        result.outputPath,
        '-vf',
        `select=eq(n\\,${frame}),format=rgba`,
        '-frames:v',
        '1',
        hidden,
      ])
      const data = await sharp(hidden).ensureAlpha().raw().toBuffer()
      let visiblePixels = 0
      for (let n = 3; n < data.length; n += 4) if (data[n] !== 0) visiblePixels++
      if (visiblePixels)
        throw new Error(`Caption cue leaked into hidden frame ${frame}: ${visiblePixels}`)
      hiddenFrames.push({ frame, visiblePixels })
    }
  outputs.push({
    kind,
    elapsedMs: sourceZip ? null : elapsedMs,
    reused: Boolean(sourceZip),
    output: result.outputPath,
    mime: result.mime,
    bytes: (await stat(result.outputPath)).size,
    sourceBytes: result.sourceZip.byteLength,
    identity: result.identity,
    video,
    duration: probe.format.duration,
    ffmpegAlpha: { clear, opaque, partial },
    warnings: result.warnings,
    hiddenFrames,
    png,
  })
}

const cancelledAt = performance.now(),
  controller = new AbortController()
let cancellationRequested = false
try {
  await renderCaptionLayer({ ...captionParams, duration: 30 }, join(base, 'alpha-cancel'), {
    ...options,
    signal: controller.signal,
    progress: (event) => {
      if (event.stage.includes('frame') && !cancellationRequested) {
        cancellationRequested = true
        controller.abort()
      }
    },
  })
  throw new Error('Cancelled alpha render unexpectedly completed')
} catch (error) {
  if (!(error instanceof Error) || error.name !== 'AbortError' || !cancellationRequested)
    throw error
}
const cancellation = {
  requestedDuringFrames: cancellationRequested,
  elapsedMs: Math.round(performance.now() - cancelledAt),
  result: 'AbortError after worker close',
}

const producerRequire = createRequire(import.meta.resolve('@hyperframes/producer'))
interface Page {
  goto(url: string): Promise<unknown>
  evaluate<T>(fn: () => Promise<T>): Promise<T>
  screenshot(options: { path: string }): Promise<unknown>
  setViewport(options: { width: number; height: number }): Promise<unknown>
}
interface Browser {
  newPage(): Promise<Page>
  close(): Promise<void>
}
const puppeteer = producerRequire('puppeteer-core') as {
  launch(options: { executablePath: string; headless: boolean; args: string[] }): Promise<Browser>
}
const server = createServer(async (req, res) => {
  const kind = req.url?.includes('captions') ? 'captions' : 'motion'
  if (req.url?.endsWith('.webm')) {
    const bytes = await readFile(join(base, `alpha-${kind}`, 'output.webm'))
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
    const start = range ? Number(range[1]) : 0,
      end = range?.[2] ? Math.min(bytes.length - 1, Number(range[2])) : bytes.length - 1
    if (start > end || start >= bytes.length) {
      res.writeHead(416, { 'Content-Range': `bytes */${bytes.length}` })
      res.end()
      return
    }
    res.writeHead(range ? 206 : 200, {
      'Content-Type': 'video/webm',
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } : {}),
    })
    res.end(bytes.subarray(start, end + 1))
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(
      `<html><body style="margin:0;background:#00ff88"><video muted preload="auto" src="/${kind}.webm" style="width:1280px;height:720px"></video></body></html>`,
    )
  }
})
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
const address = server.address()
if (!address || typeof address === 'string') throw new Error('Missing acceptance origin')
const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1280,720',
  ],
})
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 720 })
  for (const out of outputs) {
    await page.goto(`http://127.0.0.1:${address.port}/${out.kind}`)
    const nativeAlpha = await page.evaluate(async () => {
      interface NativeVideo {
        readyState: number
        onloadeddata?: () => void
        onerror?: () => void
        onseeked?: () => void
        currentTime: number
        videoWidth: number
        videoHeight: number
        muted: boolean
        paused: boolean
      }
      interface NativeCanvas {
        width: number
        height: number
        getContext(type: string): {
          drawImage(video: NativeVideo, x: number, y: number): void
          getImageData(
            x: number,
            y: number,
            width: number,
            height: number,
          ): { data: Uint8ClampedArray }
        }
      }
      const document = (
        globalThis as unknown as {
          document: {
            querySelector(selector: string): NativeVideo
            createElement(tag: string): NativeCanvas
          }
        }
      ).document
      const video = document.querySelector('video')
      if (video.readyState < 2)
        await new Promise<void>((done, fail) => {
          video.onloadeddata = () => done()
          video.onerror = () => fail(new Error('Native video decode failed'))
        })
      await new Promise<void>((done) => {
        video.onseeked = () => done()
        video.currentTime = 0.5
      })
      const canvas = document.createElement('canvas')
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(video, 0, 0)
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
      let clear = 0,
        opaque = 0,
        partial = 0
      for (let n = 3; n < data.length; n += 4) {
        const a = data[n]!
        if (a === 0) clear++
        else if (a === 255) opaque++
        else partial++
      }
      return {
        clear,
        opaque,
        partial,
        width: video.videoWidth,
        height: video.videoHeight,
        muted: video.muted,
        paused: video.paused,
        time: video.currentTime,
      }
    })
    if (
      nativeAlpha.clear < 1280 * 720 * 0.5 ||
      nativeAlpha.opaque < 100 ||
      nativeAlpha.partial < 10 ||
      !nativeAlpha.paused ||
      !nativeAlpha.muted
    )
      throw new Error(`Native video lost alpha: ${JSON.stringify(nativeAlpha)}`)
    Object.assign(out, { nativeAlpha })
    await page.screenshot({ path: join(base, `alpha-${out.kind}`, 'native-preview.png') })
  }
} finally {
  await browser.close()
  await new Promise<void>((done) => server.close(() => done()))
}
async function measure(dir: string): Promise<{ files: number; bytes: number }> {
  let files = 0,
    bytes = 0
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const nested = await measure(join(dir, entry.name))
      files += nested.files
      bytes += nested.bytes
    } else {
      files++
      bytes += (await stat(join(dir, entry.name))).size
    }
  }
  return { files, bytes }
}
const report = {
  schema: 'plein.motion-alpha-acceptance.v1',
  at: new Date().toISOString(),
  base,
  node: process.version,
  ffmpeg: (await runTool(ffmpeg, ['-version'])).stdout.split('\n')[0],
  chromePath,
  packagedWorker: options.workerPath,
  stage: await measure(dirname(fileURLToPath(import.meta.url))),
  outputs,
  cancellation,
  peakRss: 'not measured across the complete child process tree',
  signedInstaller: false,
}
await writeFile(join(base, 'alpha-acceptance.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
