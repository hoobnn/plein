import { z } from 'zod'

/**
 * 结果过期的原因，对比的是产生当前结果时冻结的实际输入（JobInfo.input）与现在准备出的：
 * - prompt：提示词变了；配音节点就是台词
 * - params：有效参数变了，key 是参数键
 * - model：实际使用的模型变了
 * - reference：@ 引用实际送入的参考图变了，key 是被引用的元素 id
 * - input：连线上游送来的内容变了（含上游采用了另一个候选），key 是上游元素 id
 * - voice：配音音色变了
 * - plan：分镜表改了，展开出来的节点还没同步（节点本身的结果还没过期）
 * - unknown：结果早于实际输入记录，说不出具体哪里变了
 */
export type ImpactCauseKind =
  | 'prompt'
  | 'params'
  | 'model'
  | 'reference'
  | 'input'
  | 'voice'
  | 'plan'
  | 'unknown'

export interface ImpactCause {
  kind: ImpactCauseKind
  key?: string
  /** 给人看的说明 */
  label: string
}

/**
 * 建议：
 * - rerun：重新生成（默认勾选）
 * - review：先看看新输入再决定，如参考图换了的镜头图、换了来源的序列
 * - keep：保留现有结果，如上游镜头图要重做时的原视频
 * - sync：分镜表改了，先看计划与节点的差异
 */
export type ImpactSuggestion = 'rerun' | 'review' | 'keep' | 'sync'

/** 受影响的一个节点 */
export interface ImpactNode {
  nodeId: string
  name: string
  nodeType: string
  /** 分镜展开的节点：按稳定镜头 id 关联，镜号只用来显示 */
  shot?: { storyboard: string; id: string; no?: number; role: 'image' | 'video' | 'speech' }
  /**
   * direct：自己的输入或参数变了；indirect：上游要重做，跟着受影响；
   * related：同一镜头里没受影响、可以顺带重做的（台词改了时的画面）
   */
  impact: 'direct' | 'indirect' | 'related'
  causes: ImpactCause[]
  suggest: ImpactSuggestion
  /** 当前采用的结果，即保留时留下的产物 */
  current?: { resultId: string; type: string; assetId?: string }
  /** 已有候选里有按现在的输入生成过的：重做时直接改用它，不调用平台 */
  cached?: { resultId: string }
  /** 现在的实际输入哈希；保留决定按它对应，输入再变（如上游重做之后）决定就不再适用 */
  inputHash?: string
  /** 用户确认过保留的过期结果 */
  kept?: ImpactDecision
  /** 预估费用；模型没配价格时缺省，算作未知 */
  price?: { amount: number; currency: string }
}

/**
 * 序列里一段镜头的问题（换了视频候选、改了台词之后）：
 * - out_of_range：入点或出点超出新素材时长
 * - dialogue_overflow：对白比这段镜头长
 * - transition：转场比这段可用的长度长，会被缩短
 * - subtitle：这段字幕是手写的，台词改了不会跟着变
 */
export type SequenceIssueKind = 'out_of_range' | 'dialogue_overflow' | 'transition' | 'subtitle'

export interface SequenceIssue {
  sequenceId: string
  /** 这段镜头的来源（视频节点 id），序列参数里按它记入出点 */
  source: string
  shotId?: string
  kind: SequenceIssueKind
  message: string
}

/** 保留过期结果的决定：持久记录，不改缓存键，输入或结果变了就不再适用 */
export interface ImpactDecision {
  id: string
  nodeId: string
  resultId: string
  inputHash: string
  /** 决定时的过期原因 */
  causes: ImpactCause[]
  note?: string
  createdAt: number
  revokedAt?: number
}

/** 修改的影响：只读分析，不调用付费平台 */
export interface ImpactReport {
  nodes: ImpactNode[]
  /** 分镜表改了、展开节点还没同步的镜头 */
  plan: Array<{ storyboard: string; shot: string; no: number; fields: number }>
  sequence: SequenceIssue[]
  summary: {
    direct: number
    indirect: number
    /** 按建议重做时可以沿用已有候选的个数 */
    cached: number
    /** 按建议重做时要调用平台的个数（不含沿用和已保留的） */
    pending: number
    kept: number
    /** 待执行里有价格的合计；缺价格的个数记在 unknown */
    cost: { amount: number; currency?: string; unknown: number }
  }
  /** 这张画布最近的保留决定（含已撤销、已不适用的），新的在前 */
  decisions: ImpactDecision[]
}

/** 保留过期结果：带上用户看到的 inputHash，输入在那之后又变了就不记 */
export const KeepResults = z.object({
  nodes: z
    .array(z.object({ nodeId: z.string().min(1).max(200), inputHash: z.string().max(128) }))
    .min(1)
    .max(500),
  note: z.string().max(500).optional(),
})
export type KeepResults = z.infer<typeof KeepResults>

/** 只运行用户勾选的受影响节点 */
export const ImpactRunOptions = z.object({
  nodes: z.array(z.string().min(1).max(200)).min(1).max(500),
  /** 不沿用已有候选，勾选的全部重新生成 */
  force: z.boolean().default(false),
})
export type ImpactRunOptions = z.infer<typeof ImpactRunOptions>
