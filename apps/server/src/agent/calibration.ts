/**
 * 估算校准：本地对 token 的估算偏保守（每个非 ASCII 字符按 2 token 算），
 * 平台每步报告的真实输入 token 与同一请求的估算相比，得到一个系数，之后的预算判断用 估算 × 系数。
 * 按模型 ref 在进程内维护（指数滑动平均），重启后从 1 重新开始。
 * 校准只改变估算，预算上限（窗口 − 输出预留）本身不会被突破。
 */

/** 新样本的权重 */
const ALPHA = 0.3
/** 系数下限、上限：估算不会被压得太低，偏低时也只放大一点 */
export const CALIBRATION_MIN = 0.5
export const CALIBRATION_MAX = 1.2
/** 样本比值落在这个区间外视为口径不一致（例如平台报告的输入不含缓存命中），不采纳 */
const VALID_MIN = 0.4
const VALID_MAX = 2

const averages = new Map<string, number>()

/** 当前模型的校准系数；没有样本时为 1（偏保守） */
export function calibrationOf(model: string): number {
  const avg = averages.get(model)
  return avg === undefined ? 1 : Math.min(CALIBRATION_MAX, Math.max(CALIBRATION_MIN, avg))
}

/** 是否已有可用的样本 */
export const calibrated = (model: string) => averages.has(model)

/**
 * 记一个样本：平台报告的输入 token 与同一请求的（未校准）估算。
 * 比值异常或数据无效时不更新。返回是否采纳。
 */
export function recordUsage(model: string, estimated: number, reported: number): boolean {
  if (!(estimated > 0) || !Number.isFinite(reported) || reported <= 0) return false
  const ratio = reported / estimated
  if (ratio < VALID_MIN || ratio > VALID_MAX) return false
  const prev = averages.get(model)
  averages.set(model, prev === undefined ? ratio : prev * (1 - ALPHA) + ratio * ALPHA)
  return true
}

/** 清空校准样本（测试用） */
export function resetCalibration(): void {
  averages.clear()
}
