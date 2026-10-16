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

/**
 * y-indexeddb 的 update 入队不等于事务已提交。排在写事务后的只读事务完成后，
 * 才确认这一版已经落盘；期间又有改动则再确认一次，旧回执不能把新改动标为已保存。
 */
export function watchCacheWrites(
  doc: import('yjs').Doc,
  local: Pick<import('y-indexeddb').IndexeddbPersistence, 'whenSynced' | 'db'>,
  onState: (state: 'saving' | 'saved' | 'failed') => void,
) {
  let revision = 0
  let stopped = false
  let flushing = false
  let failed = false
  let database: IDBDatabase | null = null
  const fail = () => {
    failed = true
    if (!stopped) onState('failed')
  }
  const flush = async () => {
    if (stopped || flushing || failed) return
    flushing = true
    const version = revision
    try {
      await local.whenSynced
      if (stopped) return
      const db = local.db
      if (!db) throw new Error('缓存未打开')
      if (!database) {
        database = db
        // 只读屏障完成不能掩盖前面的写事务失败。
        db.addEventListener('abort', fail)
        db.addEventListener('error', fail)
      }
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('updates', 'readonly')
        tx.objectStore('updates').count()
        tx.oncomplete = () => resolve()
        tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('缓存写入失败'))
      })
      if (!stopped && !failed && version === revision) onState('saved')
    } catch {
      fail()
    } finally {
      flushing = false
      if (!stopped && version !== revision) void flush()
    }
  }
  const update = () => {
    revision++
    onState(failed ? 'failed' : 'saving')
    void flush()
  }
  doc.on('update', update)
  update()
  return () => {
    stopped = true
    doc.off('update', update)
    database?.removeEventListener('abort', fail)
    database?.removeEventListener('error', fail)
  }
}
