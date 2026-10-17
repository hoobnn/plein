import { parseTimecode } from '../canvas/media'

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
