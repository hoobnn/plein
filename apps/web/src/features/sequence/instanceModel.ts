import { currentResult, isGenerationOrigin, type CanvasElement, type Edge } from '@plein/doc'
import type { PortValue } from '@plein/plugin-sdk'

/** The exact connected output, including an empty pending slot; never a primary-output guess. */
export function sequenceInputValue(
  source: CanvasElement,
  edge: Edge,
  value: { type: string; assetId?: string; caption?: string; mime?: string } | undefined,
  canvasId?: string | null,
): PortValue {
  const result = source.kind === 'node' ? currentResult(source, edge.from[1]) : undefined
  const metadata = {
    source: source.id,
    sourcePort: edge.from[1],
    edgeId: edge.id,
    ...(result ? { resultId: result.id, runId: result.runId } : {}),
    ...(canvasId ? { sourceCanvasId: canvasId } : {}),
    ...(isGenerationOrigin(result?.generationOrigin)
      ? { generationOrigin: result.generationOrigin }
      : {}),
  }
  if (value && ['video', 'audio', 'image'].includes(value.type) && value.assetId)
    return {
      type: value.type as 'video' | 'audio' | 'image',
      kind: value.type as 'video' | 'audio' | 'image',
      assetId: value.assetId,
      caption: value.caption,
      mime: value.mime,
      ...metadata,
    }
  return { type: 'video', kind: 'video', assetId: '', ...metadata }
}

export const sequenceSourceIdentity = (row: {
  clipInstanceId?: string
  source?: string
  port?: string
  edgeId?: string
  segment?: unknown
  clip: {
    assetId: string
    resultId?: string
    runId?: string
    sourceCanvasId?: string
    generationOrigin?: unknown
  }
}) =>
  JSON.stringify([
    row.clipInstanceId,
    row.source,
    row.port,
    row.edgeId,
    row.segment,
    row.clip.assetId,
    row.clip.resultId,
    row.clip.runId,
    row.clip.sourceCanvasId,
    row.clip.generationOrigin,
  ])

/** The label carries only an already-known complete tuple, never a reconstructed origin. */
export const sequenceTupleLabel = (value: unknown) =>
  isGenerationOrigin(value)
    ? [value.canvasId, value.nodeId, value.port, value.resultId, value.runId].join(' / ')
    : '未知'
