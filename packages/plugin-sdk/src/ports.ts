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

/** 端口值的附加信息，由宿主填写 */
export interface PortValueMeta {
  /** 来自画布上的哪个元素：同一端口有多个上游时，执行器靠它对应参数里的设置 */
  source?: string
}

/** 端口上流动的值 */
export type PortValue = (
  | { type: 'text'; text: string }
  | { type: 'json'; value: unknown }
  | ({ type: 'image' | 'video' | 'audio' } & AssetRef & {
        /** 语音的台词：配音节点写入，序列导出时用作字幕 */
        caption?: string
      })
) &
  PortValueMeta

export function portAccepts(port: PortType, value: PortValue['type']) {
  return port === 'any' || port === value
}
