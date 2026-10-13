const dateFmt = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })
const relFmt = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' })
const pad = (n: number) => String(n).padStart(2, '0')

/** 完整日期时间，放在悬停提示里 */
export const fullTime = (ts: number) => dateFmt.format(ts)

/** 一周内写相对时间（刚刚、3 分钟前、昨天），更早写日期 */
export function relativeTime(ts: number, now = Date.now()) {
  const s = Math.max(0, (now - ts) / 1000)
  if (s < 10) return '刚刚'
  if (s < 60) return relFmt.format(-Math.floor(s), 'second')
  if (s < 3600) return relFmt.format(-Math.floor(s / 60), 'minute')
  if (s < 86400) return relFmt.format(-Math.floor(s / 3600), 'hour')
  if (s < 7 * 86400) return relFmt.format(-Math.floor(s / 86400), 'day')
  return dateFmt.format(ts)
}

/** 当天写「今天 14:05」，更早写「3月5日 14:05」 */
export function shortTime(ts: number) {
  const d = new Date(ts)
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return d.toDateString() === new Date().toDateString()
    ? `今天 ${hm}`
    : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
}

/** 时长：「42 秒」「3 分 5 秒」 */
export function duration(ms: number) {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`
}

/** 文件大小：「820 KB」「12.3 MB」「1.2 GB」 */
export function bytes(n: number) {
  if (n < 1024) return `${Math.round(n)} B`
  const units = ['KB', 'MB', 'GB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}
