import type { CanvasElement } from '@plein/doc'
import type { MediaSource } from '@plein/protocol'

/**
 * 节点是否仍然引用这份素材：资产、生成结果、交付物和参数里的引用都算。
 * 定位来源前要复核一次，别把已经换掉的节点当成来源。
 */
export function referencesAsset(node: CanvasElement, assetId: string) {
  const contains = (value: unknown): boolean =>
    typeof value === 'string'
      ? value === assetId
      : Array.isArray(value)
        ? value.some(contains)
        : !!value && typeof value === 'object' && Object.values(value).some(contains)
  return (
    node.assetId === assetId ||
    node.results?.some((result) => 'assetId' in result.value && result.value.assetId === assetId) ||
    node.deliveries?.some((delivery) => delivery.assetId === assetId) ||
    contains(node.params)
  )
}

/** 同名来源只有目的地不同时才需要额外标识，避免正常来源列表堆满 ID。 */
export function sourceHint(source: MediaSource, sources: MediaSource[]) {
  if (!source.locatable || !source.canvasId || !source.nodeId) return ''
  const peers = sources.filter((item) => item.locatable && item.label === source.label)
  if (!peers.some((item) => item.canvasId !== source.canvasId || item.nodeId !== source.nodeId))
    return ''
  const suffix = (id: string, key: 'canvasId' | 'nodeId') => {
    let size = 6
    while (
      peers.some(
        (item) => item[key] && item[key] !== id && item[key]!.slice(-size) === id.slice(-size),
      )
    )
      size++
    return id.slice(-size)
  }
  return `画布 ${suffix(source.canvasId, 'canvasId')} · 元素 ${suffix(source.nodeId, 'nodeId')}`
}
