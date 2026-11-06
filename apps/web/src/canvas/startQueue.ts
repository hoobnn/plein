/** 首页只登记意图；编辑器加载后才执行节点创建。 */
export const DRAMA_START = 'builtin/drama'
/** 从模板新建的项目沿用模板名，不显示成「未命名项目」；普通快速开始返回 undefined 走服务端默认名 */
export const startProjectTitle = (nodeType?: string) =>
  nodeType === DRAMA_START ? '短剧模板' : undefined
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
