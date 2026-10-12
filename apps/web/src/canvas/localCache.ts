/** 画布在浏览器本地缓存（IndexedDB，y-indexeddb）里的库名 */
export const localCacheName = (canvasId: string) => `plein-canvas:${canvasId}`

/** 删除画布后丢掉它的本地缓存 */
export function forgetLocalCache(canvasId: string) {
  try {
    indexedDB.deleteDatabase(localCacheName(canvasId))
  } catch {
    // 隐私模式等不可用时本来就没有缓存
  }
}
