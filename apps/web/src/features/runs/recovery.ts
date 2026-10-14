import type { BatchItem, CanceledBy, HeldReason, JobInfo } from '@plein/protocol'

/** 任务恢复状态的说法：一句话现状、补充说明和提示色；不需要提示时为 null */
export interface RecoveryView {
  title: string
  detail?: string
  tone: 'warning' | 'danger' | 'muted'
}

const HELD: Record<HeldReason, string> = {
  canceled: '取消后才返回',
  input_changed: '提交后输入改过',
  node_deleted: '节点已删除，只留在执行记录里',
  superseded: '节点已有更新的结果',
}

export const CANCELED_BY: Record<CanceledBy, string> = {
  user: '已取消',
  remote: '平台取消了任务',
  system: '已停止（画布或节点已删除）',
}

export function describeRecovery(job: JobInfo): RecoveryView | null {
  const r = job.recovery
  if (!r || r.dismissed) return null
  const platform = r.provider ?? '平台'
  const id = r.remoteId ? `任务 ID ${r.remoteId}` : undefined
  switch (r.state) {
    case 'submit_unknown':
      return {
        title: '提交结果未知',
        detail: r.verifiable
          ? `没收到${platform}的确认，可以让系统按平台的查询接口再核查一次`
          : `没收到${platform}的确认，无法判断是否已受理。请先到${platform}控制台核对；重新提交可能重复计费`,
        tone: 'warning',
      }
    case 'fetch_failed':
      return {
        title: '平台已生成，结果没存到本地',
        detail: [r.refetchable ? '可以重新获取，不会重新提交' : r.note, id]
          .filter(Boolean)
          .join(' · '),
        tone: 'warning',
      }
    case 'remote_pending':
      return job.status === 'canceled'
        ? {
            title: '平台上的任务可能仍在生成',
            detail: [
              r.refetchable ? '取消前平台已受理，费用按平台规则计算；可以去取回结果' : r.note,
              id,
            ]
              .filter(Boolean)
              .join(' · '),
            tone: 'muted',
          }
        : null
    case 'stored':
      return {
        title: '结果已入库，待采用',
        detail: r.held ? HELD[r.held] : undefined,
        tone: 'muted',
      }
    case 'review':
      return { title: '输入已变，需要重新审查', detail: '没有提交，不会产生费用', tone: 'warning' }
    case 'remote_failed':
    case 'adopted':
      return null
  }
}

export const BATCH_OUTCOME: Record<BatchItem['outcome'], string> = {
  pending: '等待',
  running: '运行中',
  succeeded: '已生成',
  cached: '沿用',
  failed: '失败',
  canceled: '已取消',
  skipped: '跳过',
  review: '需重新审查',
}

export const BATCH_STAGE: Record<BatchItem['stage'], string> = {
  run: '生成',
  reuse: '沿用',
  blocked: '有阻断',
}
