import { z } from 'zod'

/** 端口数据类型，与文档里节点元素的端口一致 */
export const PortType = z.enum(['text', 'image', 'video', 'audio', 'json', 'any'])
export type PortType = z.infer<typeof PortType>

export const PortSpec = z.object({
  id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
  label: z.string(),
  type: PortType,
  /** 输入端口可接多条连线（如多张参考图） */
  multiple: z.boolean().optional(),
  /** 输入端口必须连线才能运行 */
  required: z.boolean().optional(),
})
export type PortSpec = z.infer<typeof PortSpec>

/** 资产引用：节点之间传递图片 / 视频 / 音频时只传 id，二进制在资产库 */
export interface AssetRef {
  assetId: string
  kind: 'image' | 'video' | 'audio' | 'file'
  mime?: string
}

/** 端口上流动的值 */
export type PortValue =
  | { type: 'text'; text: string }
  | { type: 'json'; value: unknown }
  | ({ type: 'image' | 'video' | 'audio' } & AssetRef)

export function portAccepts(port: PortType, value: PortValue['type']) {
  return port === 'any' || port === value
}
