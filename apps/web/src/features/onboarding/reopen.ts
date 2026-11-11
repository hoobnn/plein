import { create } from 'zustand'

interface WelcomeReopen {
  open: boolean
  /** 打开过一次后保持挂载，让关闭动画播完 */
  used: boolean
  /** 首页自动弹出的首次引导正开着；此时不再叠加第二份 */
  autoOpen: boolean
  dismiss(): void
}

/** 重开新手引导的请求状态；对话框本身在 App 里按需加载，任何页面都能调用 reopenWelcome。 */
export const useWelcomeReopen = create<WelcomeReopen>()((set) => ({
  open: false,
  used: false,
  autoOpen: false,
  dismiss: () => set({ open: false }),
}))

/** 重新打开新手引导（命令面板、设置页入口共用），不改动「已看过」标记。 */
export function reopenWelcome() {
  if (useWelcomeReopen.getState().autoOpen) return
  useWelcomeReopen.setState({ open: true, used: true })
}
