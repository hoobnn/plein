import { create } from 'zustand'

/** 工作流左侧栏：展开状态、宽度与页签；展开状态和宽度跨画布、跨会话记住 */
export type SidebarTab = 'layers' | 'assets'

export const SIDEBAR_WIDTH = { min: 220, max: 480, default: 272 } as const

const KEY = 'plein:sidebar'
const WIDTH_KEY = 'plein:sidebar-width'

function read(key: string) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // 存不下就只在本次生效
  }
}

const clamp = (w: number) => Math.round(Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, w)))

interface SidebarStore {
  open: boolean
  width: number
  tab: SidebarTab
  toggle(open?: boolean): void
  /** 拖动中只改内存，松手时 persist 写入 */
  setWidth(width: number, persist?: boolean): void
  setTab(tab: SidebarTab): void
}

export const useSidebar = create<SidebarStore>((set, get) => ({
  open: read(KEY) !== 'closed',
  width: clamp(Number(read(WIDTH_KEY)) || SIDEBAR_WIDTH.default),
  tab: 'layers',
  toggle(open) {
    const next = open ?? !get().open
    write(KEY, next ? 'open' : 'closed')
    set({ open: next })
  },
  setWidth(width, persist = true) {
    const w = clamp(width)
    if (persist) write(WIDTH_KEY, String(w))
    set({ width: w })
  },
  setTab: (tab) => set({ tab }),
}))
