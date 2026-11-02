import { createPendingSetStore } from '../../stores/pendingSet'

export const cancelRequestKey = (canvasId: string | null, nodeId: string, runId?: string) =>
  JSON.stringify([canvasId, nodeId, runId ?? null])

export const groupCancelRequestKey = (canvasId: string | null, groupId: string) =>
  JSON.stringify(['group', canvasId, groupId, null])

export const useCancelRequests = createPendingSetStore()
