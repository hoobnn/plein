import { ApiError } from './http'

/**
 * 本机文档改动还没追平到服务端时，带同步凭据的读取（如 nodeInput）返回 409 sync_pending。
 * 这不是读取失败，而是「稍后重试」；这里集中判断与重试节奏，各调用点不各写一份。
 */
export function isSyncPending(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'sync_pending'
}

/** 轮询循环里用：未追平时返回 undefined（当作这一轮还没读到），其它错误照常抛出。 */
export async function readUnlessSyncPending<T>(read: Promise<T>): Promise<T | undefined> {
  try {
    return await read
  } catch (error) {
    if (isSyncPending(error)) return undefined
    throw error
  }
}

const SYNC_PENDING_RETRIES = 20

/** useQuery 的 retry：只对未追平重试，其它错误沿用不重试。重试期间查询仍是加载中，追平后自然恢复。 */
export function retryWhileSyncPending(failureCount: number, error: Error): boolean {
  return isSyncPending(error) && failureCount < SYNC_PENDING_RETRIES
}

/** useQuery 的 retryDelay：250ms 起翻倍，封顶 2 秒。 */
export function syncPendingRetryDelay(failureCount: number): number {
  return Math.min(250 * 2 ** failureCount, 2000)
}
