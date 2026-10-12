import type { DesktopBridge } from '@plein/protocol'

declare global {
  interface Window {
    /** 只在桌面端存在，由 preload 注入 */
    pleinDesktop?: DesktopBridge
  }
}

export const desktop = typeof window === 'undefined' ? undefined : window.pleinDesktop
