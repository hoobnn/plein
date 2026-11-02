/**
 * 能力审批的声明类型：能力自己说明「要确认时怎么写」；要不要问的通用规则留在调度器。
 * 自带能力与内置插件共用同一套声明；第三方插件本期不能提供能力，宿主在加载时直接拒绝。
 */

/** 审批模式（与协议里的 AgentApprovalMode 一致；SDK 不依赖协议包，这里保留字面量） */
export type CapabilityApprovalMode = 'rules' | 'always' | 'auto'

/** 宿主在审批时提供的上下文：声明里用得到的部分 */
export interface CapabilityApprovalContext {
  /** 当前审批模式；只读，仅用于生成说明文案。是否必须确认由调度层兜底：always 下返回 null 仍会回退要确认 */
  mode: CapabilityApprovalMode
  /** 本轮改动集：新建的元素删除不用确认；一轮的运行次数有上限 */
  changes: {
    createdThisTurn(id: string): boolean
    runCount: number
  }
}

/** 需要用户点头的一次调用 */
export interface CapabilityApproval {
  /** 给用户看的一句话：要做什么、为什么要问 */
  reason: string
  /** 相关元素，确认卡片悬停时在画布上高亮 */
  ids: string[]
}

/**
 * 显式放行：声明命中豁免时任何审批模式都不问。
 * 目前只有 delete_elements 的「删本轮自建的东西」使用；插件声明不含这个变体，
 * 宿主在透传处运行时拒绝。
 */
export interface CapabilityExemption {
  /** 放行依据（不展示给用户） */
  exempt: string
}
