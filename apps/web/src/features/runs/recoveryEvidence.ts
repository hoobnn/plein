import type { JobInfo } from '@plein/protocol'

/** 仅取任务元数据与已有错误说明，不额外附带输入正文、参数或素材。 */
export function recoveryEvidence(job: JobInfo) {
  const time = (at: number | undefined) =>
    at === undefined ? '未记录' : new Date(at).toISOString()
  return [
    'Plein 任务核查信息',
    `本地任务 ID：${job.id}（不是平台任务 ID）`,
    `模型：${job.input?.model?.ref ?? job.recovery?.provider ?? '未记录'}`,
    `状态：${job.status} / ${job.recovery?.state ?? '未记录'}`,
    `尝试次数：${job.attempts}`,
    `创建时间（UTC）：${time(job.createdAt)}`,
    `开始时间（UTC）：${time(job.startedAt)}`,
    `结束时间（UTC）：${time(job.finishedAt)}`,
    `平台任务 ID：${job.recovery?.remoteId ?? '未记录'}`,
    `错误信息：${job.error ?? '未记录'}`,
  ].join('\n')
}
