import { z } from 'zod'
import type { PreparedInput } from './runs'

/**
 * 任务的恢复状态（内部合同，界面据此给出可执行的处理）：
 * - remote_failed：平台明确返回失败
 * - submit_unknown：提交后没收到回应，不知道平台有没有受理
 * - remote_pending：平台已受理、还在处理（包括取消后平台可能没停下来的）
 * - fetch_failed：平台已生成，下载或保存到本地失败
 * - stored：产物已入库，但没有成为当前结果（待采用）
 * - adopted：产物已入库并且是节点当前采用的结果
 * - review：实际输入相对批准的计划变了，没有提交，需要重新审查
 */
export type RecoveryState =
  | 'remote_failed'
  | 'submit_unknown'
  | 'remote_pending'
  | 'fetch_failed'
  | 'stored'
  | 'adopted'
  | 'review'

/** 谁取消的：用户、平台，还是系统（删除画布或节点、服务重启后找不到节点） */
export type CanceledBy = 'user' | 'remote' | 'system'

/**
 * 产物入库了却没成为当前结果的原因：
 * - canceled：用户取消后才返回
 * - input_changed：节点的输入在提交后改过
 * - node_deleted：节点已删除，结果只留在执行记录里
 * - superseded：节点已经有更新一次运行的结果
 * - candidate_only：用户只要求生成候选，没有批准替换当前结果
 */
export type HeldReason =
  | 'canceled'
  | 'input_changed'
  | 'node_deleted'
  | 'superseded'
  | 'candidate_only'

export interface JobRecovery {
  state: RecoveryState
  /** 平台上的任务 ID（有的话），人工核查时对照 */
  remoteId?: string
  /** 平台名 */
  provider?: string
  /**
   * submit_unknown：平台有按幂等键查询或幂等提交的合同，系统能自动核查；
   * 为 false 时只能人工核查，重新提交可能重复计费
   */
  verifiable?: boolean
  /** submit_unknown：平台支持按任务 ID 查询，可以填平台控制台里查到的任务 ID 接着取结果 */
  attachable?: boolean
  /** fetch_failed / remote_pending：能「重新获取」（不重新提交） */
  refetchable?: boolean
  /** 不能恢复或需要说明的情况 */
  note?: string
  /** stored / adopted：这次运行产生的结果 */
  resultIds?: string[]
  /** stored：没有成为当前结果的原因 */
  held?: HeldReason
  /** 节点已删除时产物的资产 ID：只留在执行记录里 */
  assets?: string[]
  /** 用户标记过已处理（人工核查后放弃） */
  dismissed?: true
}

/**
 * 任务恢复操作：
 * - refetch：重新获取（按调用记录续查或重新下载保存，不重新提交）
 * - attach：填平台上查到的任务 ID，接着取结果
 * - resubmit：核查后确认平台没有受理，重新提交（平台若其实已受理，可能重复计费）
 * - dismiss：标记已处理，不再提示
 */
export const RecoverJobOptions = z.discriminatedUnion('action', [
  z.object({ action: z.literal('refetch') }),
  z.object({ action: z.literal('attach'), remoteId: z.string().trim().min(1).max(200) }),
  z.object({ action: z.literal('resubmit') }),
  z.object({ action: z.literal('dismiss') }),
])
export type RecoverJobOptions = z.infer<typeof RecoverJobOptions>

/**
 * 批次快照里一个目标在启动时定下的执行阶段：
 * - run：要调用执行器（可能付费）
 * - reuse：当前结果有效，沿用
 * - blocked：准备不过去或有阻断（必需参考缺失等），提交时会失败
 */
export type BatchStage = 'run' | 'reuse' | 'blocked'

/** 批次里一个目标的结局 */
export type BatchOutcome =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'cached'
  | 'failed'
  | 'canceled'
  | 'skipped'
  | 'review'

/** 待解析的依赖：上游也在本批次里、还要重新生成，提交前才冻结实际输入 */
export interface BatchDependency {
  nodeId: string
  /** 启动时上游当前的结果（没有时缺省）；结果换成别处来的就要重新审查 */
  resultId?: string
  /** 预检批准的上游内容与连线；移动画布、审片元数据不使它改变。 */
  sourceKey?: string
}

/** 批次快照里的一个目标；持久化在服务端任务层，不写进画布文档 */
export interface BatchItem {
  nodeId: string
  /** 调度先后（启动时的目标顺序） */
  seq: number
  stage: BatchStage
  /** 阻断、跳过或沿用的原因 */
  reason?: string
  /** 启动时批准的实际输入哈希；有待解析依赖时缺省 */
  inputHash?: string
  /** 待解析的依赖 */
  deps: BatchDependency[]
  /** 启动时准备的实际输入（有待解析依赖时只是参考，提交前重新准备） */
  input?: PreparedInput
  /** 实际提交时冻结的输入哈希 */
  frozenHash?: string
  jobId?: string
  outcome: BatchOutcome
  /** 本批次最后落定的结果（生成的或沿用的候选） */
  resultId?: string
  updatedAt: number
}
