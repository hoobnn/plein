import { API, type NodeRunStarted } from '@plein/protocol'
import { ApiError } from '../api/client'
import { useCanvas } from '../stores/canvas'

async function post<T>(path: string): Promise<T | undefined> {
  const res = await fetch(path, { method: 'POST', credentials: 'same-origin' })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null
    throw new ApiError(res.status, body?.error ?? 'http_error', body?.message ?? res.statusText)
  }
  return res.status === 204 ? undefined : ((await res.json()) as T)
}

/**
 * 运行 / 取消画布上的节点。状态和结果由服务端写回文档，经同步回到画布，
 * 这里只负责发起请求和提示错误。
 */
/** 返回这次运行的 id；没能开始（演示画布、请求被拒）时返回 null */
export async function runNode(id: string): Promise<string | null> {
  const { canvasId, notify } = useCanvas.getState()
  if (!canvasId) {
    notify('演示画布不能运行节点，请在首页新建画布')
    return null
  }
  try {
    return (await post<NodeRunStarted>(API.nodeRun(canvasId, id)))?.runId ?? null
  } catch (err) {
    notify((err as Error).message)
    return null
  }
}

export async function cancelNode(id: string) {
  const { canvasId, notify } = useCanvas.getState()
  if (!canvasId) return
  try {
    await post(API.nodeCancel(canvasId, id))
  } catch (err) {
    notify((err as Error).message)
  }
}
