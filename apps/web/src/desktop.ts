import type { DesktopBridge } from '@plein/protocol'

declare global {
  interface Window {
    /** 只在桌面端存在，由 preload 注入 */
    pleinDesktop?: DesktopBridge
  }
}

export const desktop = typeof window === 'undefined' ? undefined : window.pleinDesktop

// 桌面端样式开关：macOS 隐藏了标题栏，顶栏要给红绿灯让位并可拖动窗口（styles.css）
if (desktop) document.documentElement.dataset.desktop = desktop.platform
