import { createPendingSetStore } from '../../stores/pendingSet'

export const runRequestKey = (canvasId: string | null, nodeId: string) =>
  JSON.stringify([canvasId, nodeId])

/** 等待受理应答期间也保护单节点提交，状态独立于生成器与任务面板生命周期。 */
export const useRunRequests = createPendingSetStore()
