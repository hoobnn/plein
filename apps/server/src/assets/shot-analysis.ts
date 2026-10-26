import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  SHOT_ANALYSIS_LIMITS,
  shotAnalysisNode,
  shotAnalysisRanges,
  type ShotAnalysisManifest,
} from '@plein/nodes'
import type { AssetRef, VideoAnalysisOptions } from '@plein/plugin-sdk'
import { ffmpegBin, h264Args, probeMedia, withMediaAbort } from './media'
import type { AssetStore } from './store'

let occupied = false
const waiting: Array<() => void> = []

/** A cancellable process-wide slot: simultaneous node jobs do not decode several videos. */
async function acquire(signal: AbortSignal): Promise<() => void> {
  signal.throwIfAborted()
  if (occupied)
    await new Promise<void>((resolve, reject) => {
      const ready = () => {
        signal.removeEventListener('abort', abort)
        resolve()
      }
      const abort = () => {
        const index = waiting.indexOf(ready)
        if (index >= 0) waiting.splice(index, 1)
        reject(signal.reason)
      }
      waiting.push(ready)
      signal.addEventListener('abort', abort, { once: true })
    })
  occupied = true
  return () => {
    const next = waiting.shift()
    if (next) next()
    else occupied = false
  }
}

async function outputSize(directory: string) {
  const files = await readdir(directory)
  const sizes = await Promise.all(
    files.map(async (name) => (await stat(join(directory, name))).size),
  )
  return sizes.reduce((sum, size) => sum + size, 0)
}

async function processVideo(
  args: string[],
  directory: string,
  signal: AbortSignal,
  onLine?: (line: string) => void,
) {
  signal.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpegBin(), ['-hide_banner', '-nostdin', '-y', ...args], {
      signal,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let failure: unknown
    let tail = ''
    let pending = ''
    let killTimer: ReturnType<typeof setTimeout> | undefined
    let checking = false
    const stop = (error: unknown) => {
      failure ??= error
      proc.kill('SIGTERM')
      if (!killTimer) {
        killTimer = setTimeout(() => proc.kill('SIGKILL'), 1000)
        killTimer.unref()
      }
    }
    const budget = setInterval(() => {
      if (checking) return
      checking = true
      void outputSize(directory)
        .then((bytes) => {
          if (bytes > SHOT_ANALYSIS_LIMITS.outputBytes)
            stop(new Error('本次拉片输出超过 1 GiB，已停止'))
        }, stop)
        .finally(() => {
          checking = false
        })
    }, 200)
    budget.unref()
    proc.stderr.on('data', (data: Buffer) => {
      const text = data.toString()
      tail = (tail + text).slice(-4000)
      pending += text
      const lines = pending.split(/[\r\n]/)
      pending = lines.pop() ?? ''
      try {
        for (const line of lines) onLine?.(line)
      } catch (error) {
        stop(error)
      }
    })
    proc.on('error', stop)
    proc.on('close', (code) => {
      clearInterval(budget)
      clearTimeout(killTimer)
      if (signal.aborted) reject(signal.reason)
      else if (failure) reject(failure)
      else if (code !== 0) reject(new Error(`本地拉片失败（${code}）：${tail.trim()}`))
      else {
        try {
          if (pending) onLine?.(pending)
          resolve()
        } catch (error) {
          reject(error)
        }
      }
    })
  })
  if ((await outputSize(directory)) > SHOT_ANALYSIS_LIMITS.outputBytes)
    throw new Error('本次拉片输出超过 1 GiB')
}

function frameTime(line: string) {
  const match = /\bpts_time:([\d.e+-]+)/.exec(line)
  const value = match ? Number(match[1]) : undefined
  return value !== undefined && Number.isFinite(value) ? value : undefined
}

const seconds = (value: number) => Number(value.toFixed(9)).toString()

/** Full decode on real PTS. No FPS conversion, frame-number clock or semantic scene claim. */
export async function analyzeVideo(
  store: AssetStore,
  ownerId: string,
  ref: AssetRef,
  options: VideoAnalysisOptions,
  parentSignal: AbortSignal,
  onProgress: (fraction: number) => void,
): Promise<ShotAnalysisManifest> {
  const parsed = shotAnalysisNode.params.parse({
    ...options,
    ...(options.points !== undefined
      ? { cutPlan: { sourceAssetId: ref.assetId, points: options.points } }
      : {}),
  })
  options = { ...parsed, points: parsed.cutPlan?.points }
  const signal = AbortSignal.any([
    parentSignal,
    AbortSignal.timeout(SHOT_ANALYSIS_LIMITS.timeoutMs),
  ])
  const release = await acquire(signal)
  return withMediaAbort(signal, async () => {
    let directory: string | undefined
    try {
      signal.throwIfAborted()
      const source = store.get(ownerId, ref.assetId)
      if (!source || source.kind !== 'video') throw new Error('拉片需要本机可读取的视频资产')
      if (source.size > SHOT_ANALYSIS_LIMITS.inputBytes) throw new Error('拉片视频不能超过 512 MiB')
      const file = store.originalPath(source.id)
      if ((await stat(file)).size > SHOT_ANALYSIS_LIMITS.inputBytes)
        throw new Error('拉片视频不能超过 512 MiB')
      const metadata = await probeMedia(file)
      signal.throwIfAborted()
      if (!metadata.hasVideo || !metadata.width || !metadata.height)
        throw new Error('无法读取视频画面')
      if (Math.max(metadata.width, metadata.height) > SHOT_ANALYSIS_LIMITS.dimension)
        throw new Error('拉片视频最长边不能超过 4096 像素')
      if (
        metadata.videoDuration !== undefined &&
        metadata.videoDuration > SHOT_ANALYSIS_LIMITS.duration
      )
        throw new Error('拉片视频不能超过 600 秒')
      directory = await store.tempDir('shot-analysis-')
      let first: number | undefined
      let last: number | undefined
      let frameDuration = 0
      const frameTimes: number[] = []
      const candidates: number[] = []
      await processVideo(
        [
          '-v',
          'info',
          '-copyts',
          '-i',
          file,
          '-vf',
          `scale=256:-2,showinfo@all=checksum=0,select='gt(scene,${options.threshold})',showinfo@cuts=checksum=0`,
          '-map',
          '0:V:0',
          '-an',
          '-fps_mode',
          'passthrough',
          '-f',
          'null',
          '-',
        ],
        directory,
        signal,
        (line) => {
          const at = frameTime(line)
          if (at === undefined) return
          if (line.includes('showinfo@all')) {
            first ??= at
            if (last !== undefined && at < last)
              throw new Error('视频帧时间倒序，不能建立可靠的拉片时间轴')
            last = at
            frameTimes.push(at)
            if (frameTimes.length > 1_000_000) throw new Error('视频解码帧数超过本地拉片资源上限')
            const duration = /\bduration_time:([\d.e+-]+)/.exec(line)
            const reportedDuration = duration ? Number(duration[1]) : 0
            frameDuration =
              Number.isFinite(reportedDuration) && reportedDuration > 0 ? reportedDuration : 0
            if (at - first > SHOT_ANALYSIS_LIMITS.duration)
              throw new Error('解码视频超过 600 秒，已停止')
            onProgress(Math.min(0.4, ((at - first) / Math.max(1, metadata.duration ?? 600)) * 0.4))
          } else if (line.includes('showinfo@cuts')) {
            if (first === undefined) throw new Error('无法确定视频首帧时间')
            candidates.push(at - first)
          }
        },
      )
      if (first === undefined) throw new Error('视频没有可解码的画面')
      if (!frameDuration) throw new Error('无法确定末帧持续时间，不能证明全片覆盖')
      const duration = Number((last! - first + frameDuration).toFixed(9))
      // Close candidate pairs are often flashes. Drop both rather than invent a tiny scene.
      const detected = candidates.filter(
        (point, i) =>
          point >= options.minSceneSeconds &&
          duration - point >= options.minSceneSeconds &&
          (i === 0 || point - candidates[i - 1]! >= options.minSceneSeconds) &&
          (i === candidates.length - 1 || candidates[i + 1]! - point >= options.minSceneSeconds),
      )
      const ranges = shotAnalysisRanges(duration, options.points ?? detected)
      if (options.clips && ranges.some((range) => range.end - range.start < 1 / 30 - 0.000000001))
        throw new Error('提取 30 fps 视频片段时，每段必须至少 1/30 秒；更短区间可以只提取关键帧')
      const frameIndexAt = (time: number) => {
        let lo = 0
        let hi = frameTimes.length
        while (lo < hi) {
          const mid = (lo + hi) >>> 1
          if (frameTimes[mid]! <= first! + time + 0.000001) lo = mid + 1
          else hi = mid
        }
        return Math.max(0, lo - 1)
      }
      const sourceRef = { assetId: source.id, kind: 'video' as const, mime: source.mime }
      const manifest: ShotAnalysisManifest = {
        version: 1,
        source: sourceRef,
        timeBasis: 'first-video-frame',
        firstVideoPts: first,
        duration,
        algorithm: {
          name: 'ffmpeg-scene',
          version: 1,
          threshold: options.threshold,
          minSceneSeconds: options.minSceneSeconds,
          manual: options.points !== undefined,
        },
        scenes: [],
        notes: [
          '切点依据画面差异；闪光可能误切，渐变转场或语义变化可能漏检，请人工校正。服务中断后按冻结输入重新执行本地处理。',
          ...(options.clips
            ? [
                '视频片段按源区间重编码为 30 fps，每段至少 1/30 秒，时长误差最多一帧（约 0.033 秒）。',
              ]
            : []),
        ],
      }
      const put = async (path: string, mime: string, name: string): Promise<AssetRef> => {
        signal.throwIfAborted()
        if ((await outputSize(directory!)) > SHOT_ANALYSIS_LIMITS.outputBytes)
          throw new Error('本次拉片输出超过 1 GiB')
        const asset = await store.ingest(ownerId, createReadStream(path, { signal }), {
          mime,
          name,
        })
        signal.throwIfAborted()
        return { assetId: asset.id, kind: asset.kind, mime: asset.mime }
      }
      const encoder = options.clips ? await h264Args() : []
      for (const [index, range] of ranges.entries()) {
        signal.throwIfAborted()
        const absoluteStart = first + range.start
        const absoluteEnd = first + range.end
        const requested = (range.start + range.end) / 2
        const frameIndex = frameIndexAt(requested)
        const frameFile = join(directory, `frame-${index}.jpg`)
        let sampled: number | undefined
        await processVideo(
          [
            '-v',
            'info',
            '-copyts',
            '-i',
            file,
            '-map',
            '0:V:0',
            '-an',
            '-vf',
            `select='eq(n,${frameIndex})',showinfo@frame=checksum=0,setpts=PTS-STARTPTS,scale='min(1280,iw)':-2`,
            '-frames:v',
            '1',
            '-q:v',
            '3',
            frameFile,
          ],
          directory,
          signal,
          (line) => {
            if (line.includes('showinfo@frame')) sampled ??= frameTime(line)
          },
        )
        if (sampled === undefined)
          throw new Error(`镜头 ${index + 1} 没有可提取的关键帧，请调整切点`)
        const frame = await put(frameFile, 'image/jpeg', `拉片-${index + 1}-关键帧.jpg`)
        const scene: ShotAnalysisManifest['scenes'][number] = {
          id: `scene-${index + 1}`,
          ...range,
          frame: {
            ...frame,
            kind: 'image',
            mime: 'image/jpeg',
            at: requested,
            actualAt: Number((sampled - first).toFixed(9)),
            actualEnd: Number(
              ((frameTimes[frameIndex + 1] ?? first + duration) - first).toFixed(9),
            ),
          },
        }
        if (options.clips) {
          const clipFile = join(directory, `clip-${index}.mp4`)
          const filters = [
            `[0:V:0]trim=start=${seconds(frameTimes[frameIndexAt(range.start)]!)}:end=${seconds(absoluteEnd)},setpts='max(PTS-${seconds(absoluteStart)}/TB,0)',fps=30,trim=duration=${seconds(range.end - range.start)}[v]`,
          ]
          if (metadata.hasAudio)
            filters.push(
              `[0:a:0]atrim=start=${seconds(absoluteStart)}:end=${seconds(absoluteEnd)},asetpts=PTS-${seconds(absoluteStart)}/TB,aresample=async=1:first_pts=0,apad,atrim=duration=${seconds(range.end - range.start)}[a]`,
            )
          await processVideo(
            [
              '-v',
              'error',
              '-copyts',
              '-i',
              file,
              '-filter_complex',
              filters.join(';'),
              '-map',
              '[v]',
              ...(metadata.hasAudio ? ['-map', '[a]', '-c:a', 'aac'] : ['-an']),
              ...encoder,
              '-t',
              seconds(range.end - range.start),
              '-map_metadata',
              '-1',
              '-metadata:s:v:0',
              'rotate=0',
              '-movflags',
              '+faststart',
              clipFile,
            ],
            directory,
            signal,
          )
          const clipMetadata = await probeMedia(clipFile)
          if (
            !clipMetadata.hasVideo ||
            !clipMetadata.duration ||
            clipMetadata.duration <= 0 ||
            Math.abs(clipMetadata.duration - (range.end - range.start)) > 1 / 30 + 0.005
          )
            throw new Error(`镜头 ${index + 1} 未生成有效且时长匹配的视频片段`)
          const clip = await put(clipFile, 'video/mp4', `拉片-${index + 1}-片段.mp4`)
          scene.clip = { ...clip, kind: 'video', mime: 'video/mp4' }
        }
        manifest.scenes.push(scene)
        onProgress(0.4 + ((index + 1) / ranges.length) * 0.5)
      }
      if (options.audio && metadata.hasAudio) {
        const audioFile = join(directory, 'original.m4a')
        await processVideo(
          [
            '-v',
            'error',
            '-copyts',
            '-i',
            file,
            '-map',
            '0:a:0',
            '-vn',
            '-af',
            `atrim=start=${seconds(first)}:end=${seconds(first + duration)},asetpts=PTS-${seconds(first)}/TB,aresample=async=1:first_pts=0,apad,atrim=duration=${seconds(duration)}`,
            '-c:a',
            'aac',
            audioFile,
          ],
          directory,
          signal,
        )
        const audioMetadata = await probeMedia(audioFile)
        if (!audioMetadata.hasAudio || !audioMetadata.duration || audioMetadata.duration <= 0)
          throw new Error('没有生成有效的原音轨')
        const audio = await put(audioFile, 'audio/mp4', '拉片-原音轨.m4a')
        manifest.audio = { ...audio, kind: 'audio', mime: 'audio/mp4' }
      } else if (options.audio) manifest.notes.push('源视频没有音轨，没有生成原音轨素材。')
      signal.throwIfAborted()
      onProgress(1)
      return manifest
    } finally {
      try {
        if (directory) await rm(directory, { recursive: true, force: true })
      } finally {
        release()
      }
    }
  })
}
