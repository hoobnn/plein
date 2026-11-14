import {
  type HistoryEntry,
  type NewElement,
  type PleinDoc,
  type VideoSegment,
  isGenerationOrigin,
  isVideoSegment,
} from '@plein/doc'
import type { Asset } from '@plein/protocol'
import { elementFor } from './import'

/** 放到画布上的输入（位置由调用方补齐） */
export type MaterialInput = Omit<NewElement, 'x' | 'y'>

export type HistoryMaterial = { input: MaterialInput; notice?: string } | { problem: string }

/**
 * 生成历史的一项 → 画布素材。
 * 视频带上精确候选选择：selection 指向当前画布里的原节点、端口、候选与运行，
 * origin 只在候选记录了完整原执行出处时照搬；读不到来源就明确拒绝，不按文件猜。
 * 结果可能已在等待素材元数据期间被删除或改动，写入前应再调用一次。
 */
export function historyMaterial(
  doc: PleinDoc,
  canvasId: string | null,
  entry: HistoryEntry,
  asset: Asset,
): HistoryMaterial {
  const input = elementFor(asset, entry.result.value.compositionSource)
  if (!input) return { problem: '这个文件不能放到画布上' }
  if (entry.result.value.type !== 'video') return { input }
  if (!canvasId) return { problem: '当前画布尚未连接到服务器，无法记录候选来源' }
  const node = doc.get(entry.elementId)
  if (!node) return { problem: '来源节点已删除' }
  const result = node.results?.find((r) => r.id === entry.result.id)
  if (
    !result ||
    result.value.type !== 'video' ||
    result.runId !== entry.result.runId ||
    result.port !== entry.result.port ||
    result.value.assetId !== entry.result.value.assetId
  )
    return { problem: '来源候选已变化' }
  if (asset.kind !== 'video' || asset.id !== result.value.assetId)
    return { problem: '素材信息与候选不一致' }
  // 旧候选没有记录生成任务或读不到时长时仍可作为普通视频素材使用，但要说明返工来源缺失。
  if (!result.runId) return { input, notice: '没有记录生成任务，只能作为普通视频素材使用' }
  if (asset.duration === undefined || !(asset.duration > 0))
    return { input, notice: '读不到视频时长，只能作为普通视频素材使用' }
  const segment: VideoSegment = {
    version: 1,
    segmentId: `segment:${crypto.randomUUID()}`,
    asset: {
      assetId: result.value.assetId,
      kind: 'video',
      ...(result.value.mime ? { mime: result.value.mime } : {}),
    },
    duration: asset.duration,
    selection: {
      canvasId,
      nodeId: node.id,
      port: result.port,
      resultId: result.id,
      runId: result.runId,
    },
    ...(isGenerationOrigin(result.generationOrigin) ? { origin: result.generationOrigin } : {}),
  }
  if (!isVideoSegment(segment)) return { problem: '视频候选信息不完整' }
  return { input: { ...input, videoSegment: segment } }
}
