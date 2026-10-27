import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { isProductionGoal, productionGoalSnapshot } from '@plein/doc'
import {
  DeliveryCheckRequest,
  DeliveryCheckReport,
  DELIVERY_CHECK_LIMITS as LIMITS,
  DELIVERY_CHECK_RULES as RULES,
} from '@plein/nodes'
import type { AssetRef, DeliveryCheckRequest as CheckRequest } from '@plein/plugin-sdk'
import type { AssetStore } from './store'
import { ffmpegBin, probeMedia, withMediaAbort } from './media'

// A P12 resource gate, independent of the P08 gate. NodeRuns remains the only task queue.
let occupied = false
const waiting: Array<() => void> = []
async function acquire(signal: AbortSignal): Promise<() => void> {
  signal.throwIfAborted()
  if (occupied)
    await new Promise<void>((resolve, reject) => {
      const ready = () => {
        signal.removeEventListener('abort', abort)
        resolve()
      }
      const abort = () => {
        const i = waiting.indexOf(ready)
        if (i >= 0) waiting.splice(i, 1)
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

async function processCheck(args: string[], signal: AbortSignal, line?: (value: string) => void) {
  signal.throwIfAborted()
  return new Promise<string>((resolve, reject) => {
    const child = spawn(ffmpegBin(), ['-hide_banner', '-nostdin', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let failure: unknown
    let output = '',
      pending = ''
    let kill: ReturnType<typeof setTimeout> | undefined
    const stop = (error: unknown) => {
      failure ??= error
      child.kill('SIGTERM')
      kill ??= setTimeout(() => child.kill('SIGKILL'), 1000)
      kill.unref()
    }
    const abort = () => stop(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    child.stdout.on('data', (data: Buffer) => {
      output = (output + data.toString()).slice(0, 8192)
    })
    child.stderr.on('data', (data: Buffer) => {
      pending += data.toString()
      if (pending.length > 131072) {
        stop(new Error('媒体诊断单行超过资源上限'))
        return
      }
      const lines = pending.split(/[\r\n]/)
      pending = lines.pop() ?? ''
      try {
        for (const value of lines) line?.(value)
      } catch (error) {
        stop(error)
      }
    })
    child.once('error', (error) => {
      failure ??= error
    })
    child.once('close', (code) => {
      clearTimeout(kill)
      signal.removeEventListener('abort', abort)
      if (signal.aborted) reject(signal.reason)
      else if (failure) reject(failure)
      else if (code !== 0)
        reject(new Error(`本地媒体检查未完成（退出码 ${code}），没有发布部分通过结论`))
      else {
        try {
          if (pending) line?.(pending)
          resolve(output)
        } catch (error) {
          reject(error)
        }
      }
    })
  })
}

type Check = DeliveryCheckReport['checks'][number]
export async function checkVideo(
  store: AssetStore,
  ownerId: string,
  ref: AssetRef,
  rawRequest: CheckRequest,
  parentSignal: AbortSignal,
  progress: (fraction: number) => void,
): Promise<DeliveryCheckReport> {
  const request = DeliveryCheckRequest.parse(rawRequest)
  if (request.source.assetId !== ref.assetId || ref.kind !== 'video')
    throw new Error('检查源视频与冻结请求不一致')
  if (
    request.subtitles &&
    (request.subtitles.assetId !== ref.assetId || request.subtitles.resultId !== request.resultId)
  )
    throw new Error('字幕计划不属于固定输出')
  const goal: unknown = JSON.parse(request.goal.snapshot)
  if (!isProductionGoal(goal) || productionGoalSnapshot(goal) !== request.goal.snapshot)
    throw new Error('制作目标快照无效')
  const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(LIMITS.timeoutMs)])
  const release = await acquire(signal)
  try {
    return await withMediaAbort(signal, async () => {
      const checks: Check[] = []
      const observed: DeliveryCheckReport['observed'] = {
        decodedFrames: 0,
        audioTracks: 0,
        audioDecoded: false,
        complete: false,
        black: [],
        silence: [],
      }
      let engine = 'Plein delivery-check@1'
      const set = (id: Check['id'], status: Check['status'], detail: string) => {
        const i = checks.findIndex((item) => item.id === id)
        const value = { id, status, detail: detail.slice(0, 1000) }
        if (i < 0) checks.push(value)
        else checks[i] = value
      }
      const report = () => {
        signal.throwIfAborted()
        const states = checks.map((item) => item.status)
        const status = states.includes('failed')
          ? 'failed'
          : states.includes('issues')
            ? 'issues'
            : states.includes('unchecked')
              ? 'unchecked'
              : 'passed'
        const value = DeliveryCheckReport.parse({
          format: 'plein-delivery-check',
          version: 1,
          request,
          at: Date.now(),
          rules: RULES,
          engine,
          status,
          checks,
          observed,
          unchecked: [
            '音轨存在不证明对白、音乐、音效或口型符合目标。',
            '未用 OCR 检查烧录字幕呈现；字幕检查仅覆盖本次导出计划。',
            '可解码视频或重复静帧不证明实际动作、身份或创作质量。',
          ],
        })
        if (Buffer.byteLength(JSON.stringify(value), 'utf8') > LIMITS.reportBytes)
          throw new Error('技术报告超过 512 KiB，未发布报告')
        return value
      }
      try {
        const source = store.get(ownerId, ref.assetId)
        if (!source || source.kind !== 'video') throw new Error('源视频资产已缺失或不可读取')
        const file = store.originalPath(source.id)
        const info = await stat(file)
        observed.bytes = info.size
        if (source.size > LIMITS.inputBytes || info.size > LIMITS.inputBytes)
          throw new Error('检查视频不能超过 512 MiB')
        const hash = createHash('sha256')
        for await (const bytes of createReadStream(file, { signal })) hash.update(bytes)
        observed.sha256 = hash.digest('hex')
        if (observed.sha256 !== request.source.assetId)
          throw new Error('源文件实际哈希与固定资产身份不一致')
        set('source', 'passed', '实际文件字节哈希与固定 assetId 一致')
        engine = (await processCheck(['-version'], signal)).split('\n')[0]!.slice(0, 300)
        const metadata = await probeMedia(file)
        signal.throwIfAborted()
        observed.audioTracks = metadata.audioCodecs?.length ?? (metadata.hasAudio ? 1 : 0)
        observed.audioCodecs = metadata.audioCodecs
        if (observed.audioTracks > 100) throw new Error('源音轨数量超过可检查上限')
        if (!metadata.hasVideo) throw new Error('文件没有可解码的视频轨，封面图不视为成片')
        if (Math.max(metadata.width ?? 0, metadata.height ?? 0) > LIMITS.dimension)
          throw new Error('检查视频最长边不能超过 4096 像素')
        if ((metadata.videoDuration ?? metadata.duration ?? 0) > LIMITS.duration)
          throw new Error('检查视频不能超过 600 秒')
        const black: Array<{ start: number; end: number }> = []
        const silence: Array<{ start: number; end: number }> = []
        const audioGaps: Array<{ start: number; end: number }> = []
        let first: number | undefined,
          last: number | undefined,
          frameDuration = 0
        let lastFrame = -1
        let silenceStart: number | undefined
        const number = (line: string, key: string) => {
          const match = new RegExp(`\\b${key}[: ]+([\\d.e+-]+)`).exec(line)
          return match && Number.isFinite(Number(match[1])) ? Number(match[1]) : undefined
        }
        const add = (list: typeof black, start: number, end: number) => {
          if (list.length >= LIMITS.intervals) throw new Error('检测区间超过 1000 项，检查未完成')
          if (end > start) list.push({ start, end })
        }
        const inspect = (line: string) => {
          // Audio/video log fragments may share a physical stderr line. Match the video frame
          // record itself; a showinfo color-description prefix followed by ashowinfo is not a frame.
          const videoRecord =
            /\[Parsed_showinfo_[^\]]+\]\s+n:\s*(\d+)\s+pts:\s*[-\d]+\s+pts_time:/.exec(line)
          if (videoRecord) {
            const frame = line.slice(videoRecord.index)
            const frameNumber = Number(videoRecord[1])
            if (frameNumber !== lastFrame + 1) throw new Error('解码帧日志不连续，不能宣称检查完成')
            lastFrame = frameNumber
            const at = number(frame, 'pts_time')
            if (at === undefined) throw new Error('无法读取解码视频时间戳')
            first ??= at
            if (last !== undefined && at < last)
              throw new Error('视频时间戳倒序，无法建立可靠检查时间轴')
            if (observed.decodedFrames >= LIMITS.frames) throw new Error('视频解码帧数超过资源上限')
            observed.decodedFrames++
            last = at
            frameDuration = number(frame, 'duration_time') ?? 0
            observed.firstVideoPts = first
            observed.lastVideoPts = at
            observed.lastFrameDuration = frameDuration
            const size = /\bs:(\d+)x(\d+)/.exec(frame),
              sar = /\bsar:(\d+)\/(\d+)/.exec(frame)
            if (size) {
              observed.width = Number(size[1])
              observed.height = Number(size[2])
              if (Math.max(observed.width, observed.height) > LIMITS.dimension)
                throw new Error('实际解码尺寸超过 4096 像素')
            }
            if (sar && Number(sar[2]) > 0) observed.sar = Number(sar[1]) / Number(sar[2])
            if (at - first > LIMITS.duration) throw new Error('实际解码时长超过 600 秒')
            progress(
              Math.min(0.95, (at - first) / Math.max(1, metadata.duration ?? LIMITS.duration)),
            )
          }
          const audioRecord =
            /\[Parsed_ashowinfo_[^\]]+\]\s+n:\s*\d+\s+pts:\s*[-\d]+\s+pts_time:/.exec(line)
          if (audioRecord) {
            const frame = line.slice(audioRecord.index),
              at = number(frame, 'pts_time')
            const rate = number(frame, 'rate'),
              samples = number(frame, 'nb_samples')
            if (at !== undefined) {
              if (
                observed.audioEndPts !== undefined &&
                at > observed.audioEndPts + RULES.durationTolerance
              )
                add(audioGaps, observed.audioEndPts, at)
              observed.firstAudioPts ??= at
              if (rate && samples) observed.audioEndPts = at + samples / rate
              observed.audioDecoded = true
            }
          }
          if (line.includes('black_start:')) {
            const start = number(line, 'black_start'),
              end = number(line, 'black_end')
            if (start !== undefined && end !== undefined) add(black, start, end)
          }
          if (observed.audioTracks === 1 && line.includes('silence_start:'))
            silenceStart = number(line, 'silence_start')
          if (observed.audioTracks === 1 && line.includes('silence_end:')) {
            const end = number(line, 'silence_end')
            if (silenceStart !== undefined && end !== undefined) add(silence, silenceStart, end)
            silenceStart = undefined
          }
        }
        // 音视频滤镜各在线程中分段写 stderr，同一行甚至会丢失 showinfo 前缀。
        // 分开解码，让两种诊断各自拥有输出流；两轮都完成后才发布完整报告。
        const input = [
          '-v',
          'info',
          '-nostats',
          '-xerror',
          '-err_detect',
          'explode',
          '-copyts',
          '-threads',
          '2',
          '-i',
          file,
          '-sn',
          '-dn',
          '-filter_threads',
          '1',
        ]
        await processCheck(
          [
            ...input,
            '-map',
            '0:V:0',
            '-an',
            '-vf',
            `showinfo=checksum=0,blackdetect=d=${RULES.blackSeconds}:pix_th=${RULES.blackPixel}:pic_th=${RULES.blackRatio}`,
            '-fps_mode',
            'passthrough',
            '-f',
            'null',
            '-',
          ],
          signal,
          inspect,
        )
        if (observed.audioTracks)
          await processCheck(
            [
              ...input,
              '-map',
              '0:a',
              '-vn',
              ...(observed.audioTracks === 1
                ? [
                    '-af',
                    `ashowinfo,silencedetect=noise=${RULES.silenceDb}dB:d=${RULES.silenceSeconds}`,
                  ]
                : []),
              '-f',
              'null',
              '-',
            ],
            signal,
            inspect,
          )
        if (first === undefined || last === undefined || !observed.decodedFrames)
          throw new Error('视频没有实际解码帧')
        const duration = last - first + frameDuration
        // The preceding PTS delta does not prove a VFR final frame's duration.
        if (frameDuration > 0 && duration > 0) observed.duration = duration
        if (duration > LIMITS.duration + RULES.durationTolerance)
          throw new Error('实际解码时长超过 600 秒')
        observed.complete = true
        // Detection logs use original PTS; presentation intervals are relative to first video frame.
        const relative = (list: typeof black) =>
          list
            .map((item) => ({
              start: Math.max(0, item.start - first!),
              end: Math.min(duration, item.end - first!),
            }))
            .filter((item) => item.end > item.start)
        observed.black = relative(black)
        observed.silence = relative(silence)
        if (
          observed.audioTracks === 1 &&
          observed.firstAudioPts !== undefined &&
          observed.audioEndPts !== undefined &&
          observed.duration !== undefined
        ) {
          if (observed.firstAudioPts > first + RULES.durationTolerance)
            add(audioGaps, first, observed.firstAudioPts)
          if (observed.audioEndPts < first + duration - RULES.durationTolerance)
            add(audioGaps, observed.audioEndPts, first + duration)
          observed.audioUncovered = relative(audioGaps).sort((a, b) => a.start - b.start)
        }
        set(
          'decode',
          'passed',
          `完整解码 ${observed.decodedFrames} 个视频帧；这不判断实际动作。${observed.audioTracks > 1 ? '多音轨已交解码器处理，静音范围未检查。' : ''}`,
        )
        const width = observed.width,
          height = observed.height,
          sar = observed.sar
        const size =
          goal.resolution === '1080p'
            ? [1080, 1920]
            : goal.resolution === '720p'
              ? [720, 1280]
              : undefined
        const targetRatio =
          goal.aspectRatio === '9:16' ? 9 / 16 : goal.aspectRatio === '16:9' ? 16 / 9 : undefined
        const specIssue =
          !!(
            size &&
            width &&
            height &&
            (Math.min(width, height) !== size[0] || Math.max(width, height) !== size[1])
          ) ||
          !!(
            targetRatio &&
            width &&
            height &&
            sar &&
            Math.abs((width * sar) / height / targetRatio - 1) > 0.005
          )
        set(
          'spec',
          specIssue
            ? 'issues'
            : (!size && !targetRatio) || !width || !height || (targetRatio && !sar)
              ? 'unchecked'
              : 'passed',
          specIssue
            ? '实际像素规格或显示画幅与目标不同'
            : '按解码尺寸／SAR核对已约定规格；未约定项不作为通过要求',
        )
        const durationIssue =
          goal.duration &&
          observed.duration !== undefined &&
          ((goal.duration.min !== undefined &&
            observed.duration + RULES.durationTolerance < goal.duration.min) ||
            (goal.duration.max !== undefined &&
              observed.duration - RULES.durationTolerance > goal.duration.max))
        set(
          'duration',
          durationIssue
            ? 'issues'
            : goal.duration && observed.duration !== undefined
              ? 'passed'
              : 'unchecked',
          observed.duration === undefined
            ? '缺少可靠的末帧持续时间，实际时长未检查'
            : `解码视频时长 ${observed.duration.toFixed(3)} 秒；目标区间比较容差 ${RULES.durationTolerance} 秒`,
        )
        const audioRequired = [goal.dialogue, goal.originalAudio, goal.music, goal.sfx].includes(
          'required',
        )
        set(
          'audio',
          audioRequired && !observed.audioTracks ? 'issues' : 'passed',
          observed.audioTracks
            ? `存在 ${observed.audioTracks} 条音轨；不证明任何具体声音内容满足要求`
            : audioRequired
              ? '目标要求声音，但文件没有音轨'
              : '文件没有音轨，目标未要求必须有声音',
        )
        const subtitles = request.subtitles
        const subtitlesUnwanted =
          goal.subtitles === 'none' &&
          subtitles?.enabled &&
          subtitles.cues.some((cue) => cue.text.trim())
        const invalidCue = subtitles?.cues.some(
          (cue) =>
            !Number.isFinite(cue.start) ||
            !Number.isFinite(cue.end) ||
            cue.start < -RULES.durationTolerance ||
            cue.end <= cue.start ||
            !cue.text.trim() ||
            (observed.duration !== undefined &&
              cue.end > observed.duration + RULES.durationTolerance),
        )
        set(
          'subtitles',
          !subtitles || observed.duration === undefined
            ? 'unchecked'
            : invalidCue ||
                (!subtitles.enabled && subtitles.cues.length > 0) ||
                (goal.subtitles === 'required' && (!subtitles.enabled || !subtitles.cues.length)) ||
                subtitlesUnwanted
              ? 'issues'
              : 'passed',
          subtitlesUnwanted
            ? '目标明确不需要字幕，但实际执行的导出计划含非空字幕；这里只判定计划冲突，不声称已用OCR检查实际烧录内容'
            : invalidCue
              ? '字幕计划存在非法或超出实际视频时长的区间；原计划保留供核对，没有夹取或重写'
              : !subtitles
                ? '旧交付缺少本次实际导出字幕计划，未拿当前字幕反推旧文件'
                : '只检查实际使用的导出计划区间和目标要求，不证明烧录字幕呈现正确',
        )
        set(
          'black',
          observed.duration === undefined
            ? 'unchecked'
            : observed.black.length && !goal.allowBlack
              ? 'issues'
              : 'passed',
          observed.duration === undefined
            ? '缺少可靠的实际视频时长，黑场区间未判定'
            : observed.black.length
              ? `${observed.black.length} 个黑场候选区间${goal.allowBlack ? '；目标明确允许有意黑场，仍需人工核对内容' : '，请核对是否有意安排'}`
              : '完整检查未发现达到冻结阈值的黑场候选',
        )
        set(
          'silence',
          observed.duration === undefined ||
            !observed.audioTracks ||
            !observed.audioUncovered ||
            observed.audioUncovered.length > 0
            ? 'unchecked'
            : observed.audioTracks !== 1 || !observed.audioDecoded
              ? 'unchecked'
              : observed.silence.length && !goal.allowSilence
                ? 'issues'
                : 'passed',
          observed.audioUncovered?.length
            ? `音频样本未覆盖完整视频范围（${observed.audioUncovered.length} 个区间），这些区间未检查；不能宣称整片无静音`
            : !observed.audioUncovered && observed.audioTracks === 1
              ? '没有可靠的音频样本覆盖依据，静音范围未检查'
              : !observed.audioTracks
                ? '没有音轨，不将缺轨伪装为静音检测通过'
                : observed.audioTracks !== 1
                  ? '多音轨没有执行统一静音判定'
                  : observed.silence.length
                    ? `${observed.silence.length} 个静音候选区间${goal.allowSilence ? '；目标明确允许有意静音' : '，请人工核对'}`
                    : '单混音轨未发现达到冻结阈值的静音候选',
        )
        signal.throwIfAborted()
        progress(1)
      } catch (error) {
        if (signal.aborted) throw signal.reason
        observed.complete = false
        set(
          checks.some((item) => item.id === 'source' && item.status === 'passed')
            ? 'decode'
            : 'source',
          'failed',
          error instanceof Error ? error.message : '本地技术检查失败',
        )
        for (const id of [
          'decode',
          'spec',
          'duration',
          'audio',
          'subtitles',
          'black',
          'silence',
        ] as const)
          if (!checks.some((item) => item.id === id))
            set(id, 'unchecked', '检查未完成，未发布此项通过结论')
      }
      return report()
    })
  } finally {
    release()
  }
}
