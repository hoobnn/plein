import { create } from 'zustand'

interface GroupRunsStore {
  /** Frame id → 整组运行的 id；已发起、还没拿到 id 时为 null */
  runs: Readonly<Record<string, string | null>>
  /** 登记一次运行；这个 Frame 已在运行时返回 false */
  begin(frameId: string): boolean
  started(frameId: string, groupId: string): void
  end(frameId: string): void
}

/** 进行中的整组运行，按 Frame 记：取消选中 Frame 后再选回来，仍能看到并停止它 */
export const useGroupRuns = create<GroupRunsStore>((set, get) => ({
  runs: {},
  begin(frameId) {
    if (frameId in get().runs) return false
    set({ runs: { ...get().runs, [frameId]: null } })
    return true
  },
  started(frameId, groupId) {
    if (frameId in get().runs) set({ runs: { ...get().runs, [frameId]: groupId } })
  },
  end(frameId) {
    const { [frameId]: _, ...rest } = get().runs
    set({ runs: rest })
  },
}))

let controller = new AbortController()

/** 当前画布上轮询用的信号 */
export function groupRunSignal() {
  return controller.signal
}

/** 离开画布时停止所有轮询（服务端的运行照常继续） */
export function abortGroupRuns() {
  controller.abort()
  controller = new AbortController()
  useGroupRuns.setState({ runs: {} })
}
