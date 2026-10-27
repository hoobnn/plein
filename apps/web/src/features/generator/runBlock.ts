/**
 * 生成按钮被禁用时，给出用户看得懂的原因。
 *
 * 按钮禁用有几种来源：正在提交、正在取消、有校验问题、实际输入还没备好、
 * 实际输入已过期正在重新准备。只有「校验问题」会显示在面板上，
 * 其余几种如果不写清楚，用户只看到一个点不动的按钮，不知道该等还是该做什么。
 *
 * 禁用条件与原因说明走同一套判断：按钮能点时不该显示「正在准备」这类原因，
 * 任务在跑时按钮是取消，不该被输入相关的理由盖住。
 */

export interface RunBlockInput {
  /** 正在取消上一次任务 */
  canceling: boolean
  /** 提交请求已发出，等服务端受理 */
  awaitingAcceptance: boolean
  /** 面板上已经显示的校验问题（已经说清楚了，不用重复） */
  problem: string | null
  /** 任务在跑 */
  running: boolean
  /** 这个节点必须先备好实际输入 */
  requiresInput: boolean
  /** 实际输入还在准备 */
  loading: boolean
  /** 实际输入已备好 */
  hasInput: boolean
  /** 实际输入已过期，正在重新准备 */
  stale: boolean
  /** 实际输入读取失败 */
  error: boolean
}

/** 按钮禁用时用的原因；没禁用时返回 null */
export function runBlockReason(input: RunBlockInput): string | null {
  // 校验问题优先：面板上已经写明了，按钮的悬停提示照旧给同一个原因
  if (input.problem) return input.problem
  if (input.canceling) return '正在停止任务…'
  if (input.awaitingAcceptance) return '正在提交生成请求…'
  // 任务在跑时按钮是取消，不要用输入相关的理由盖住
  if (input.running) return null
  if (input.stale && !input.error) return '实际输入已更新，正在重新准备…'
  if (input.requiresInput && !input.loading && !input.hasInput)
    return '正在准备实际输入，备好后即可生成'
  return null
}

/** 按钮是否禁用 */
export function runDisabled(input: RunBlockInput): boolean {
  if (input.canceling || input.awaitingAcceptance) return true
  if (!input.running && input.problem) return true
  if (!input.running && input.requiresInput && !input.loading && !input.hasInput) return true
  if (!input.running && input.stale && !input.error) return true
  return false
}
