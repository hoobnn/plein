import type { MediaLibraryPage, MediaSourcesPage } from '@plein/protocol'
import { ApiError, api } from '../../api/client'

/** 素材与检查点共用 ApiError、登录失效及网络错误提示。 */
export async function mediaRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, { credentials: 'same-origin', ...init })
  } catch (reason) {
    if (reason instanceof TypeError && !init.signal?.aborted) {
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false
      throw new TypeError(
        offline ? '当前离线，请恢复网络连接。' : '无法连接服务，请检查网络或本地服务状态。',
        { cause: reason },
      )
    }
    throw reason
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string
      message?: string
    } | null
    if (response.status === 401) void api.session().catch(() => {})
    throw new ApiError(
      response.status,
      body?.error ?? 'http_error',
      body?.message ?? response.statusText,
      body,
    )
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

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
