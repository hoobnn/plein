import { API } from '@plein/protocol'
import { ApiError } from '../api/client'
import { useCanvas } from '../stores/canvas'

async function post(path: string) {
  const res = await fetch(path, { method: 'POST', credentials: 'same-origin' })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null
    throw new ApiError(res.status, body?.error ?? 'http_error', body?.message ?? res.statusText)
  }
}

/**
 * 运行 / 取消画布上的节点。状态和结果由服务端写回文档，经同步回到画布，
 * 这里只负责发起请求和提示错误。
 */
export async function runNode(id: string) {
  const { canvasId, notify } = useCanvas.getState()
  if (!canvasId) {
    notify('演示画布不能运行节点，请在首页新建画布')
    return
  }
  try {
    await post(API.nodeRun(canvasId, id))
  } catch (err) {
    notify((err as Error).message)
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
