import { create } from 'zustand'

/**
 * “请求在飞”的集合：同一把 key 只允许一个在飞。
 * 提交、取消、恢复三处逻辑完全一样，只有 key 的算法不同，所以共用一个工厂；
 * 各 feature 只保留自己的 key 函数。
 */
export interface PendingSetStore {
  pending: ReadonlySet<string>
  /** 抢到锁返回 true；已经在飞返回 false。 */
  begin(key: string): boolean
  end(key: string): void
}

export function createPendingSetStore() {
  return create<PendingSetStore>((set, get) => ({
    pending: new Set(),
    begin(key) {
      if (get().pending.has(key)) return false
      set({ pending: new Set(get().pending).add(key) })
      return true
    },
    end(key) {
      if (!get().pending.has(key)) return
      const pending = new Set(get().pending)
      pending.delete(key)
      set({ pending })
    },
  }))
}
