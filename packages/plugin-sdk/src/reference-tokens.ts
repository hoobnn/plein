import type { PortValue } from './ports'

/**
 * 参考素材在最终提示词里的编号写法。
 *
 * 服务端、面板与提示词正文共用这一份规则：图片节点写「图N」，
 * MiniMax 视频写「图片N」，其余视频（方舟系等）写「@imageN」。
 * 编号从 1 开始，按实际送入模型的顺序排列。
 */
export type ReferenceLabelStyle = 'image' | 'minimax-video' | 'video'

/** 按节点能力与模型厂商决定编号写法；非参考模式不编号。 */
export function referenceLabelStyle(
  capability: string | undefined,
  provider: string | undefined,
): ReferenceLabelStyle {
  if (capability === 'image.generate') return 'image'
  if (provider === 'minimax/api') return 'minimax-video'
  return 'video'
}

/** 第 index 张参考图在提示词正文里的编号（index 从 1 开始）。 */
export function referenceLabel(style: ReferenceLabelStyle, index: number): string {
  if (style === 'image') return `图${index}`
  if (style === 'minimax-video') return `图片${index}`
  return `@image${index}`
}

/**
 * 一批送入模型的参考素材的编号表：资产 → 编号与写法。
 * 编号顺序就是最终提示词里的编号顺序，面板顶部列表与正文徽标都用它。
 */
export function referenceNumbering(
  style: ReferenceLabelStyle,
  images: readonly PortValue[],
): { index(assetId: string): number | undefined; label(assetId: string): string | undefined } {
  const indexes = new Map<string, number>()
  let count = 0
  for (const value of images) {
    if (value.type !== 'image' || !('assetId' in value)) continue
    count++
    if (!indexes.has(value.assetId)) indexes.set(value.assetId, count)
  }
  return {
    index: (assetId) => indexes.get(assetId),
    label: (assetId) => {
      const index = indexes.get(assetId)
      return index === undefined ? undefined : referenceLabel(style, index)
    },
  }
}
