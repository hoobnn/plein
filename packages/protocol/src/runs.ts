import { z } from 'zod'

export interface NodeRunStarted {
  runId: string
}

/** 整组运行（Frame）的选项 */
export const GroupRunOptions = z.object({
  /** 是否包含视频节点（贵且慢，默认不跑） */
  video: z.boolean().default(false),
  /** 忽略缓存：参数和输入都没变的节点也重新运行 */
  force: z.boolean().default(false),
})
export type GroupRunOptions = z.infer<typeof GroupRunOptions>

/** 从一个节点出发运行：upstream 运行到此处（含上游），downstream 运行它和下游 */
export const FlowRunOptions = z.object({
  scope: z.enum(['upstream', 'downstream']),
  /** 忽略缓存，范围内的节点全部重新运行 */
  force: z.boolean().default(false),
})
export type FlowRunOptions = z.infer<typeof FlowRunOptions>

/** 从一个节点发起批量运行（分镜的「批量出分镜图」）：这些节点重新运行，@ 到的卡片的上游先跑 */
export const BatchRunOptions = z.object({
  nodes: z.array(z.string().min(1).max(200)).min(1).max(500),
})
export type BatchRunOptions = z.infer<typeof BatchRunOptions>

/** 画布上需要重跑的节点 */
export interface StaleNodes {
  /** 自己的参数或输入变了，当前结果已经过期 */
  stale: string[]
  /** 上游过期，跟着需要重跑 */
  upstream: string[]
}

export interface GroupRunStarted {
  groupId: string
  /** 组内要运行的节点数 */
  total: number
}

export interface GroupRunSummary {
  succeeded: number
  /** 参数和输入都没变，沿用已有结果 */
  cached: number
  failed: number
  canceled: number
  /** 上游失败或取消而没有运行 */
  skipped: number
}

export interface GroupRunState {
  id: string
  status: 'running' | 'done' | 'canceled'
  total: number
  summary?: GroupRunSummary
}

/** 任务面板里的一条运行记录 */
/** 任务状态；与 @plein/doc 的 RunStatus 一致，见 apps/server/src/shared-types.test.ts */
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'

export interface JobInfo {
  id: string
  nodeId: string
  nodeType: string
  /** 整组运行时所属的那次运行 */
  groupId?: string
  status: JobStatus
  /** 已尝试次数（含自动重试） */
  attempts: number
  error?: string
  createdAt: number
  startedAt?: number
  finishedAt?: number
}

export interface GroupInfo extends GroupRunState {
  /** Frame 整组运行时是 Frame，运行到此处 / 运行下游时是出发的节点 */
  frameId: string
  scope: 'frame' | 'upstream' | 'downstream'
  createdAt: number
  finishedAt?: number
}

/** 画布最近的运行记录，新的在前 */
export interface JobList {
  jobs: JobInfo[]
  groups: GroupInfo[]
}
