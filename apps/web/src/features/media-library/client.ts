import type { MediaLibraryPage, MediaSourcesPage } from '@plein/protocol'
import { request } from '../../api/http'

/** 素材与检查点共用统一的请求层：鉴权失效、网络中断、错误响应的处理只有一份。 */
export const mediaRequest = request

export function mediaQuery(values: Record<string, string | number | undefined>) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values))
    if (value !== undefined && value !== '') params.set(key, String(value))
  return params.toString()
}

export const mediaApi = {
  list: (
    values: { projectId?: string; kind?: string; q?: string; cursor?: string },
    signal?: AbortSignal,
  ) => mediaRequest<MediaLibraryPage>(`/api/assets?${mediaQuery(values)}`, { signal }),
  sources: (assetId: string, cursor?: string, signal?: AbortSignal) =>
    mediaRequest<MediaSourcesPage>(`/api/assets/${assetId}/sources?${mediaQuery({ cursor })}`, {
      signal,
    }),
}
