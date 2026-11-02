import { createPendingSetStore } from '../../stores/pendingSet'

/**
 * 任务恢复：JSON 编码的 [canvasId, jobId]；请求完成前跨面板、跨挂载共享。
 */
export const useRecoveryRequests = createPendingSetStore()
