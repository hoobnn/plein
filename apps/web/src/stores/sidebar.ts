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
const initialWidth = clamp(Number(read(WIDTH_KEY)) || SIDEBAR_WIDTH.default)

interface SidebarStore {
  open: boolean
  /** 用户确认的宽度；窗口临时变窄时仍保留。 */
  width: number
  /** 画布布局实际要让出的宽度，随可用空间和未提交的拖动变化。 */
  displayedWidth: number
  tab: SidebarTab
  toggle(open?: boolean): void
  setWidth(width: number): void
  setDisplayedWidth(width: number): void
  setTab(tab: SidebarTab): void
}

export const useSidebar = create<SidebarStore>((set, get) => ({
  open: read(KEY) !== 'closed',
  width: initialWidth,
  displayedWidth: initialWidth,
  tab: 'layers',
  toggle(open) {
    const next = open ?? !get().open
    write(KEY, next ? 'open' : 'closed')
    set({ open: next })
  },
  setWidth(width) {
    const w = clamp(width)
    write(WIDTH_KEY, String(w))
    set({ width: w })
  },
  setDisplayedWidth: (displayedWidth) => set({ displayedWidth }),
  setTab: (tab) => set({ tab }),
}))
