import { api } from '../api/client'

/** 本地演示画布没有服务端文档，不能运行 */
export const DEMO_RUN_NOTICE = '演示画布不能运行节点，请在首页新建画布'

/**
 * 运行 / 取消画布上的节点。状态和结果由服务端写回文档，经同步回到画布，
 * 这里只负责发起请求；请求被拒时抛出 ApiError，由调用方提示。
 */
/** 返回这次运行的 id */
export async function runNode(canvasId: string, id: string): Promise<string> {
  return (await api.runNode(canvasId, id)).runId
}

export function cancelNode(canvasId: string, id: string): Promise<void> {
  return api.cancelNode(canvasId, id)
}
