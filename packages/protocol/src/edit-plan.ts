import { z } from 'zod'
import type { ImpactCause, ImpactNode, ImpactReport } from './impact'
import type { InputIssue, InputRef } from './runs'

/**
 * 修改方案的批准范围：
 * - text：只把文字改动写进画布，不调用平台
 * - images：写入文字后只重新生成方案里的图片（候选图）
 * - full：写入文字后按方案执行全部生成步骤（图、视频、配音）
 */
export const EditScope = z.enum(['text', 'images', 'full'])
export type EditScope = z.infer<typeof EditScope>

/** 一个字段的改动 */
export interface EditFieldChange {
  key: string
  /** 字段的显示名 */
  label: string
  before: unknown
  after: unknown
}

/** 方案里绑定的对象版本：批准时重新检查，变了就不执行 */
export interface EditBinding {
  /** 节点参数的哈希（文档版本） */
  version: string
  /** 提出方案时的实际输入哈希；准备不过去时没有 */
  inputHash?: string
}

/** 要改文字的目标 */
export interface EditTarget extends EditBinding {
  nodeId: string
  name: string
  nodeType: string
  /** 分镜展开的节点：按稳定镜头 id 关联，镜号只用来显示 */
  shot?: ImpactNode['shot']
  changes: EditFieldChange[]
  /** 改完之后实际会送进模型的 @ 引用（同生成前的实际输入） */
  refs: InputRef[]
  /** 改完之后实际输入里的阻断与提示 */
  issues: InputIssue[]
}

/** 执行阶段：按节点输出归类 */
export type EditStage = 'image' | 'video' | 'speech' | 'other'

/** 批准后要运行的一个节点 */
export interface EditStep extends EditBinding {
  nodeId: string
  name: string
  shot?: ImpactNode['shot']
  stage: EditStage
  /** 最小的会执行它的批准范围：images 时 images 和 full 都执行，full 时只有完整方案执行 */
  scope: Exclude<EditScope, 'text'>
  /** 因为哪些目标要重做（目标节点 id） */
  targets: string[]
  causes: ImpactCause[]
  /** 已有候选是按改完后的输入生成的：直接改用它，不调用平台 */
  cached?: boolean
  /** 预估费用；模型没配价格时缺省，算作未知 */
  price?: { amount: number; currency: string }
}

/** 方案里明确保留、不重做的对象 */
export interface EditKeep {
  nodeId: string
  name: string
  shot?: ImpactNode['shot']
  reason: string
}

/** 某个批准范围的调用估算 */
export interface EditEstimate {
  /** 要调用平台的次数（不含沿用已有候选的） */
  calls: number
  /** 沿用已有候选的个数 */
  cached: number
  cost: ImpactReport['summary']['cost']
}

/**
 * 智能体的修改方案：先给用户看要改什么、保留什么、会运行什么、花多少，用户按范围批准后才执行。
 * 方案绑定目标与要运行的节点在提出时的版本，批准时任何一个变了都不执行，要求重新检查。
 */
export interface EditPlan {
  id: string
  canvasId: string
  summary: string
  targets: EditTarget[]
  steps: EditStep[]
  keep: EditKeep[]
  /** 方案之外已有结果、不受影响的节点数 */
  untouched: number
  estimate: Record<EditScope, EditEstimate>
  /**
   * pending 等用户批准；applied 已按某个范围执行；stale 批准时目标变了，没有执行；
   * denied 用户没有采用；expired 过期作废
   */
  status: 'pending' | 'applied' | 'stale' | 'denied' | 'expired'
  /** 执行情况 */
  applied?: {
    scope: EditScope
    at: number
    /** 写入文字的目标 */
    targets: string[]
    /** 交给运行队列的节点 */
    nodes: string[]
    groupId?: string
  }
  /** 批准时发现变了的对象 */
  changed?: string[]
  createdAt: number
}

/** 批准方案：范围，可只批准部分目标（目标节点 id 或镜头 id） */
export const ApplyEditPlan = z.object({
  scope: EditScope,
  only: z.array(z.string().min(1).max(200)).min(1).max(200).optional(),
})
export type ApplyEditPlan = z.infer<typeof ApplyEditPlan>
