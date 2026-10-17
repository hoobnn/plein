/** 首页只登记意图；编辑器加载后才执行节点创建。 */
export const DRAMA_START = 'builtin/drama'
const pending = new Map<string, string>()
export const queueStartNode = (canvasId: string, nodeType: string) => {
  pending.set(canvasId, nodeType)
}
export const takeStartNode = (canvasId: string) => {
  const type = pending.get(canvasId)
  pending.delete(canvasId)
  return type
}
