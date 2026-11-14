/**
 * 在按钮或快捷键时先记下的「这次生成」。
 *
 * 预览还没备好时不能只记一个布尔：用户随后改了输入，那次点击授权的是改之前的输入，
 * 不能拿新输入顶上。这里把它绑定到点击时的实际输入摘要，备好后摘要一致才提交。
 */
export interface PendingRunIntent {
  canvasId: string | null
  nodeId: string
  /** 点击时的实际输入摘要（见 previewInputKey） */
  key: string
}

export interface PendingRunState {
  intent: PendingRunIntent | null
  canvasId: string | null
  nodeId: string
  /** 当前的（或最近一次读取到的）实际输入摘要 */
  key: string
  loading: boolean
  stale: boolean
  /** 本机改动还没同步到服务端 */
  syncPending: boolean
  error: boolean
  hasInput: boolean
  requiresInput: boolean
  problem: string | null
  running: boolean
}

export type PendingRunDecision =
  | { kind: 'wait' }
  | { kind: 'submit' }
  | { kind: 'cancel'; reason: string | null }

/** 判断记下的这次生成现在该等、该提交、还是作废 */
export function planPendingRun(state: PendingRunState): PendingRunDecision {
  const { intent } = state
  if (!intent) return { kind: 'wait' }
  if (intent.canvasId !== state.canvasId || intent.nodeId !== state.nodeId)
    return { kind: 'cancel', reason: null }
  // 任务已经跑起来（自己提交的、或别处发起的）：这次授权已经用掉，不再排队
  if (state.running) return { kind: 'cancel', reason: null }
  // 校验问题面板上已经写明，任务就不该记下来
  if (state.problem) return { kind: 'cancel', reason: null }
  // 本机改动没到服务端：提交会被拒，等同步完成后由用户再确认
  if (state.syncPending)
    return {
      kind: 'cancel',
      reason: '本机改动还没有同步到服务端，这次生成已取消；同步完成后再点一次生成。',
    }
  // 读取实际输入失败：拿旧哈希提交会被判成输入已变，不能替用户决定
  if (state.error) return { kind: 'cancel', reason: '读取实际输入失败，这次生成已取消，请重试。' }
  // 点击之后输入改了：授权的是改之前的那一版
  if (intent.key !== state.key)
    return { kind: 'cancel', reason: '输入已修改，这次生成已取消；确认无误后再点一次生成。' }
  if (state.loading || (state.stale && !state.error)) return { kind: 'wait' }
  if (state.requiresInput && !state.hasInput) return { kind: 'wait' }
  return { kind: 'submit' }
}
