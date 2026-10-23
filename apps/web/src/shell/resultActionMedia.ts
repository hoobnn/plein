import type { CanvasElement } from '@plein/doc'
import { CompositionSourceRef } from '@plein/plugin-sdk'
import type { CanvasMedia } from '../features/library/canvas'

export interface ResultActionMedia {
  assetId: string
  kind: 'image' | 'video'
  compositionSource?: unknown
}

/** 按钮属于实际展示的候选；节点当前采用项不能替换调用方携带的源身份。 */
export function resultActionMedia(element: CanvasElement, media: ResultActionMedia): CanvasMedia {
  const raw =
    media.compositionSource !== undefined
      ? media.compositionSource
      : element.kind === media.kind && element.assetId === media.assetId
        ? element.params?.compositionSource
        : undefined
  const source = CompositionSourceRef.safeParse(raw)
  return {
    elId: element.id,
    assetId: media.assetId,
    kind: media.kind,
    name: element.name ?? '',
    ...(source.success
      ? { compositionSource: source.data }
      : raw !== undefined
        ? { compositionSourceInvalid: true }
        : {}),
  }
}
