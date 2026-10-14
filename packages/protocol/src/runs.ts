import { z } from 'zod'

export interface NodeRunStarted {
  runId: string
}

/** 开始运行单个节点的选项 */
export const NodeRunOptions = z.object({
  /**
   * 用户确认过的实际输入（PreparedInput.inputHash）。带上时，提交前重新准备的结果与它不一致就不运行，
   * 返回 409 input_changed 和新的实际输入，让用户看过再提交
   */
  expect: z.string().max(128).optional(),
})
export type NodeRunOptions = z.infer<typeof NodeRunOptions>

/** @ 引用的资产卡类别；直接 @ 的图片元素是 image */
export type InputRefKind = 'character' | 'scene' | 'prop' | 'style' | 'image' | 'other'

/**
 * 参考图没有（全部）送进模型的原因：
 * - over_limit：超过模型的参考图上限，按优先级舍弃
 * - unsupported：当前节点或模式不收参考图（如生成视频不是「图片参考」模式），只附文字设定
 * - no_image：被引用者没有可用的参考图（还没生成或没连），只附文字设定
 * - failed：被引用者的参考图生成失败，只附文字设定
 */
export type InputRefReason = 'over_limit' | 'unsupported' | 'no_image' | 'failed'

/** 提示词里 @ 到的一个引用，在本次运行中实际怎么用 */
export interface InputRef {
  /** 画布上的元素 id（改名不变） */
  elementId: string
  /** 显示名，写了档案项时是「林夏（少年·校服）」 */
  name: string
  kind: InputRefKind
  /** 用户设为必需：缺失、不可用或放不下时不提交 */
  required: boolean
  /** 它能提供的参考图资产 */
  available: string[]
  /** 实际送进模型的参考图资产 */
  sent: string[]
  /** available 里有图没送，或根本没图时的原因 */
  reason?: InputRefReason
}

/** 实际送进某个输入端口的一个值；图片按送入顺序排列 */
export interface InputValue {
  type: 'text' | 'json' | 'image' | 'video' | 'audio'
  assetId?: string
  /** 文本节选（长文本截断） */
  text?: string
  /** 来源元素：连线的上游或 @ 引用的卡片 */
  source?: string
  /** 来源是节点时，取的是它哪一个结果、哪一次运行产生的 */
  resultId?: string
  runId?: string
  /** text 只是开头，原文更长 */
  truncated?: true
}

/**
 * 实际输入里的一条提示或阻断。code 供程序判断，message 给人看；与某个引用有关时带 elementId。
 * - required_no_image / required_failed / required_unsupported / required_over_limit：必需参考用不上
 * - prepare_failed：准备输入本身失败（上游没结果、@ 重名、音色跨平台等）
 * - optional_dropped：可选参考超过上限没有送入
 * - mention_broken：@ 的名字找不到，可能改过名
 * - profile_miss / profile_conflict：@ 写的档案项不存在或冲突
 * - voice_unverified / voice_ambiguous：沿用的音色无法校验平台，或引用了多个有音色的角色
 * - unsupported_refs：当前模式不送参考图，只附文字设定
 */
export type InputIssueCode =
  | 'required_no_image'
  | 'required_failed'
  | 'required_unsupported'
  | 'required_over_limit'
  | 'prepare_failed'
  | 'optional_dropped'
  | 'mention_broken'
  | 'profile_miss'
  | 'profile_conflict'
  | 'voice_unverified'
  | 'voice_ambiguous'
  | 'unsupported_refs'

export interface InputIssue {
  code: InputIssueCode
  message: string
  elementId?: string
}

/** PreparedInput 的格式版本；结构变了递增，读旧执行记录时据此兼容 */
export const PREPARED_INPUT_VERSION = 1

/**
 * 一个节点的实际输入：预览、缓存判断和提交共用同一份准备结果。
 * 预览不调用付费生成；提交时重新准备，inputHash 不同说明输入在预览后变过。
 */
export interface PreparedInput {
  v: typeof PREPARED_INPUT_VERSION
  nodeId: string
  nodeType: string
  /** 节点定义版本（参数按它迁移） */
  nodeVersion?: number
  /** 准备时间（毫秒时间戳） */
  preparedAt: number
  /**
   * ready：可以提交；blocked：准备好了但有阻断；unprepared：准备本身失败，
   * 只给出能给的部分，没有 inputHash
   */
  status: 'ready' | 'blocked' | 'unprepared'
  capability?: string
  /**
   * 实际使用的模型；自动选择时是当前排第一的已启用模型，没有可用模型时缺省。
   * version 是平台声明的模型版本，没声明时缺省
   */
  model?: { ref: string; provider: string; title: string; auto: boolean; version?: string }
  /** 模型的参考图上限；没声明时不限 */
  referenceLimit?: number
  /** 展开 @ 并附上设定后的提示词（含上游文本） */
  prompt?: string
  /** 计入缓存的有效参数（不含提示词与内部字段） */
  params: Record<string, unknown>
  /** 各输入端口实际送入的值 */
  inputs: Record<string, InputValue[]>
  refs: InputRef[]
  /** 配音实际使用的音色 */
  voice?: { provider: string; voiceId: string }
  /** 降级与需要用户知道的提示，不阻断运行 */
  notices: InputIssue[]
  /** 阻断运行的问题（必需参考缺失、音色跨平台、上游没结果等）；非空时提交会失败 */
  blocked: InputIssue[]
  /**
   * 缓存键：节点类型与版本、实际模型及其平台插件版本、有效参数与实际输入内容的哈希，带算法版本前缀。
   * 准备失败（unprepared）时缺省
   */
  inputHash?: string
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
  /** 提交时冻结的实际输入（0.2 之前的任务没有） */
  input?: PreparedInput
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
