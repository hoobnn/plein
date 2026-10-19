import type { Engine } from '@plein/canvas-core'
import type { StaleNodes } from '@plein/protocol'
import { create } from 'zustand'
import { api } from '../../api/client'

/** kept：过期但用户确认过保留（缓存判断不变，整组运行仍会重跑） */
export type StaleKind = 'self' | 'upstream' | 'kept'

/** 工作流与故事板共享的过期提示。 */
export const STALE_TEXT: Record<StaleKind, string> = {
  self: '需要重跑',
  upstream: '上游已改',
  kept: '已保留',
}
export const STALE_HINT: Record<StaleKind, string> = {
  self: '参数或输入改过，当前结果不是按现在的设置生成的',
  upstream: '上游节点改过，重跑上游后这里也要重跑',
  kept: '结果已过期，你在「查看影响」里确认过先保留',
}

type Watch = { engine: Engine; canvasId: string; refresh(): void }
let activeWatch: Watch | undefined

/** 保留决定不修改文档，成功后显式刷新；旧面板不能刷新其他画布。 */
export function refreshStale(engine: Engine, canvasId: string) {
  if (activeWatch?.engine === engine && activeWatch.canvasId === canvasId) activeWatch.refresh()
}

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
      if (mine === seq && activeWatch === watcher) useStale.getState().set(stale)
    } catch {}
  }
  const schedule = () => {
    // 改动发生时旧查询就已失效，不等防抖结束才拒绝它。
    seq++
    clearTimeout(timer)
    timer = setTimeout(load, 1200)
  }
  const watcher: Watch = {
    engine,
    canvasId,
    refresh() {
      clearTimeout(timer)
      void load()
    },
  }
  activeWatch = watcher
  useStale.getState().set(null)
  const off = engine.doc.subscribe(schedule)
  void load()
  return () => {
    off()
    clearTimeout(timer)
    seq++
    if (activeWatch === watcher) {
      activeWatch = undefined
      useStale.getState().set(null)
    }
  }
}
