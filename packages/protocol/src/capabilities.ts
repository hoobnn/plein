import { z } from 'zod'

/** 插件贡献的能力（给 ⌘K 和智能体面板显示） */
export interface PluginCapabilityInfo {
  /** 工具名，调用时用它 */
  name: string
  title: string
  description: string
  effect: 'read' | 'edit' | 'run' | 'destructive'
  palette?: 'always' | 'selection'
  /** 插件名 */
  plugin: string
}

/** 从 ⌘K 调用一个服务端能力 */
export const CapabilityCall = z.object({
  input: z.record(z.string(), z.unknown()).default({}),
  selection: z.array(z.string().max(200)).max(1000).default([]),
})
export type CapabilityCall = z.infer<typeof CapabilityCall>

export interface CapabilityCallResult {
  /** 能力的结果（文字） */
  result: string
  /** 改了画布时可以撤销：调用撤销接口时带上它 */
  undo?: string
}
