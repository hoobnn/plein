import { isGenerationOrigin, type NodeResult } from '@plein/doc'
import type { JobInfo } from '@plein/protocol'
import { api } from '../api/client'

export interface CandidateInputEvidence {
  job: JobInfo
  /** local：本画布里的作业别名；origin：候选最初生成位置的任务记录 */
  scope: 'local' | 'origin'
}

const matches = (job: JobInfo, nodeId: string, runId: string) =>
  job.id === runId &&
  job.nodeId === nodeId &&
  (job.input === undefined || job.input.nodeId === nodeId)

/**
 * 按候选的本地作业别名读取冻结输入。别名和当前节点对不上时，只有候选记录了完整原执行出处
 * 才去原 canvas / node / run 精确读；找不到就如实失败，绝不按相同文件猜。
 */
export async function readCandidateJob(
  canvasId: string,
  nodeId: string,
  result: NodeResult,
): Promise<CandidateInputEvidence> {
  const origin = result.generationOrigin
  let local: JobInfo | undefined
  try {
    const job = await api.canvasJob(canvasId, result.runId)
    if (matches(job, nodeId, result.runId)) local = job
    // 同画布复制 / 粘贴的节点复用了原结果和 runId，服务端按 runId 返回的仍是原节点的记录；
    // 同一个响应里就有原执行证据，不必再请求一次。
    else if (
      isGenerationOrigin(origin) &&
      origin.canvasId === canvasId &&
      origin.runId === result.runId &&
      matches(job, origin.nodeId, origin.runId)
    )
      return { job, scope: 'origin' }
  } catch {
    // 别名读不到时仍可尝试候选明确记录的原执行出处
  }
  if (local?.input) return { job: local, scope: 'local' }
  if (
    isGenerationOrigin(origin) &&
    (origin.canvasId !== canvasId || origin.runId !== result.runId)
  ) {
    try {
      const job = await api.canvasJob(origin.canvasId, origin.runId)
      if (matches(job, origin.nodeId, origin.runId)) return { job, scope: 'origin' }
    } catch {
      if (!local) throw new Error('没有与此候选匹配的生成记录')
    }
  }
  if (local) return { job: local, scope: 'local' }
  throw new Error('没有与此候选匹配的生成记录')
}
