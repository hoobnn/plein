import type { Engine } from '@plein/canvas-core'
import type { StaleNodes } from '@plein/protocol'
import { create } from 'zustand'
import { api } from '../../api/client'

/** kept：过期但用户确认过保留（缓存判断不变，整组运行仍会重跑） */
export type StaleKind = 'self' | 'upstream' | 'kept'

interface StaleStore {
  /** 节点 id → 自己过期 / 上游过期 / 已确认保留 */
  nodes: ReadonlyMap<string, StaleKind>
  set(s: StaleNodes | null): void
}

export const useStale = create<StaleStore>((set) => ({
  nodes: new Map(),
  set: (s) =>
    set({
      nodes: new Map<string, StaleKind>([
        ...(s?.stale ?? []).map((id) => [id, 'self'] as const),
        ...(s?.upstream ?? []).map((id) => [id, 'upstream'] as const),
        ...(s?.kept ?? []).map((id) => [id, 'kept'] as const),
      ]),
    }),
}))

/**
 * 文档变化后（停一会儿再）问服务端哪些节点需要重跑：
 * 判断要算缓存键，和整组运行用的是同一套规则，所以放在服务端。
 */
export function watchStale(engine: Engine, canvasId: string) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let seq = 0
  const load = async () => {
    const mine = ++seq
    try {
      const stale = await api.canvasStale(canvasId)
      if (mine === seq) useStale.getState().set(stale)
    } catch {}
  }
  const schedule = () => {
    clearTimeout(timer)
    timer = setTimeout(load, 1200)
  }
  const off = engine.doc.subscribe(schedule)
  void load()
  return () => {
    off()
    clearTimeout(timer)
    seq++
    useStale.getState().set(null)
  }
}
