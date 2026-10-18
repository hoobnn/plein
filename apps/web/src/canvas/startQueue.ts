/** 首页只登记意图；编辑器加载后才执行节点创建。 */
export const DRAMA_START = 'builtin/drama'
const pending = new Map<string, string>()
const listeners = new Map<string, Set<() => void>>()
export const queueStartNode = (canvasId: string, nodeType: string) => {
  pending.set(canvasId, nodeType)
  // 创建应答也可能晚于目标画布就绪；异步通知避免在创建请求的回调中执行文档修改。
  for (const listener of listeners.get(canvasId) ?? []) queueMicrotask(listener)
}
export const watchStartNode = (canvasId: string, listener: () => void) => {
  let group = listeners.get(canvasId)
  if (!group) listeners.set(canvasId, (group = new Set()))
  group.add(listener)
  return () => {
    group.delete(listener)
    if (!group.size) listeners.delete(canvasId)
  }
}
export const takeStartNode = (canvasId: string) => {
  const type = pending.get(canvasId)
  pending.delete(canvasId)
  return type
}
