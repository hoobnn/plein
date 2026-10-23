import { CompositionSourceRef } from '@plein/plugin-sdk'
import { request } from '../../api/client'

export interface MediaCompositionSource {
  compositionSource: CompositionSourceRef
  title: string
}

/** 一个媒体哈希可对应多份源工程；只接受宿主验证后返回的明确身份。 */
export async function loadMediaCompositionSources(
  assetId: string,
  signal: AbortSignal,
): Promise<MediaCompositionSource[]> {
  const result = await request<{ sources?: unknown }>(
    `/api/motion/asset/${encodeURIComponent(assetId)}/sources`,
    { signal },
  )
  if (!Array.isArray(result.sources)) throw new Error('素材来源响应不合法')
  const sources = new Map<string, MediaCompositionSource>()
  for (const item of result.sources) {
    if (!item || typeof item !== 'object') throw new Error('素材来源响应不合法')
    const value = item as { compositionSource?: unknown; title?: unknown }
    const parsed = CompositionSourceRef.safeParse(value.compositionSource)
    if (!parsed.success || typeof value.title !== 'string') throw new Error('素材源工程身份不合法')
    sources.set(parsed.data.manifestAssetId, {
      compositionSource: parsed.data,
      title: value.title.slice(0, 1000),
    })
  }
  return [...sources.values()]
}
