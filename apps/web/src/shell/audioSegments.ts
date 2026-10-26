import { parseTimecode } from '../canvas/media'
import type { JobInfo } from '@plein/protocol'

export interface TranscriptionSegment {
  start: number
  end: number
  text: string
}

/** 必须是该识别作业提交时冻结的唯一音频，当前连线不能证明历史结果的归属。 */
export function transcriptionSourceMatches(
  job: JobInfo,
  nodeId: string,
  runId: string,
  assetId: string,
) {
  const input = job.input
  if (
    job.id !== runId ||
    job.nodeId !== nodeId ||
    job.nodeType !== 'plein/transcribe' ||
    job.status !== 'succeeded' ||
    !input ||
    input.v !== 1 ||
    input.nodeId !== nodeId ||
    input.nodeType !== 'plein/transcribe' ||
    (input.capability !== undefined && input.capability !== 'audio.transcribe') ||
    input.status !== 'ready'
  )
    return false
  if (
    !input.inputs ||
    typeof input.inputs !== 'object' ||
    Object.values(input.inputs).some((values) => !Array.isArray(values))
  )
    return false
  const audio = input.inputs.audio
  if (
    !Array.isArray(audio) ||
    audio.length !== 1 ||
    audio[0]?.type !== 'audio' ||
    audio[0].assetId !== assetId
  )
    return false
  const values = Object.values(input.inputs).flat()
  if (
    values.some(
      (value) =>
        !value ||
        typeof value !== 'object' ||
        !['text', 'json', 'audio', 'video', 'image'].includes(value.type),
    )
  )
    return false
  const media = values.filter(
    (value) => ['audio', 'video', 'image'].includes(value.type) || value.assetId !== undefined,
  )
  return media.length === 1 && media[0] === audio[0]
}

/** 保留平台原始时间精度和顺序；超出切分限额时完整导入，由用户明确编辑。 */
export function transcriptionSplitPlan(value: unknown, duration: number | undefined) {
  if (!duration || !Number.isFinite(duration) || duration <= 0)
    throw new Error('等待素材时长读取完成后再使用识别区间')
  if (
    !value ||
    typeof value !== 'object' ||
    !('segments' in value) ||
    !Array.isArray(value.segments) ||
    !value.segments.length
  )
    throw new Error('识别结果没有分句时间戳，请手动填写区间或重新识别')
  const segments: TranscriptionSegment[] = []
  for (const [index, entry] of value.segments.entries()) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof entry.start !== 'number' ||
      typeof entry.end !== 'number' ||
      !Number.isFinite(entry.start) ||
      !Number.isFinite(entry.end) ||
      entry.start < 0 ||
      entry.end <= entry.start ||
      typeof entry.text !== 'string'
    )
      throw new Error(`第 ${index + 1} 句缺少有效时间戳，请手动填写区间或重新识别`)
    if (entry.end > duration) throw new Error(`第 ${index + 1} 句超出音频时长，请手动核对区间`)
    if (index && entry.start < segments[index - 1]!.end)
      throw new Error(`第 ${index + 1} 句与前句重叠或乱序，请手动核对，不会自动排序`)
    segments.push({ start: entry.start, end: entry.end, text: entry.text })
  }
  return {
    segments,
    text: segments.map((segment) => `${segment.start} - ${segment.end}`).join('\n'),
    issue:
      segments.length < 2
        ? '识别只有 1 句，切分需要 2–20 段；导入后请手动补充区间。'
        : segments.length > 20
          ? `识别有 ${segments.length} 句，切分最多 20 段；会完整导入，请手动合并或移除区间。`
          : undefined,
  }
}

/** 显式切点必须严格递增；不静默排序、夹断或吞掉无效区间。 */
export function audioSplitPlan(
  duration: number | undefined,
  mode: string,
  value: string,
  count = 2,
) {
  if (!duration || !Number.isFinite(duration)) throw new Error('等待素材时长读取完成后再切分')
  if (mode === 'even') {
    if (!Number.isFinite(count) || count < 2 || count > 20) throw new Error('段数需要在 2–20 之间')
    const n = Math.round(count)
    return Array.from({ length: n }, (_, i) => ({
      start: (duration * i) / n,
      end: (duration * (i + 1)) / n,
    }))
  }
  if (mode === 'cuts') {
    const cuts = value
      .split(/[,，\s]+/)
      .filter(Boolean)
      .map(parseTimecode)
    if (!cuts.length || cuts.length > 19 || cuts.some((n) => n === null))
      throw new Error('请输入 1–19 个切点，使用秒数或时间码，以逗号分隔')
    const points = [0, ...(cuts as number[]), duration]
    if (points.some((n, i) => i > 0 && n <= points[i - 1]!))
      throw new Error('切点需严格递增，并位于素材开始与结尾之间')
    return points.slice(1).map((end, i) => ({ start: points[i]!, end }))
  }
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length < 2 || lines.length > 20)
    throw new Error('请输入 2–20 个区间，每行“开始 - 结束”')
  return lines.map((line, i) => {
    const pair = line.split(/\s*[-–—]\s*/)
    const start = pair[0] ? parseTimecode(pair[0]) : null
    const end = pair[1] ? parseTimecode(pair[1]) : null
    if (pair.length !== 2 || start === null || end === null || end <= start || end > duration)
      throw new Error(`第 ${i + 1} 个区间无效：结束应晚于开始，且不能超出素材时长`)
    return { start, end }
  })
}
