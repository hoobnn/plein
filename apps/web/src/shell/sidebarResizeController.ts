import { SIDEBAR_WIDTH } from '../stores/sidebar'

/**
 * 侧栏宽度调整的接驳层。
 *
 * 指针捕获、像素约束与拖拽本身由 react-resizable-panels 负责；这里接住旧版手写实现里
 * 库没有直接覆盖的三件事：
 * - 取消（Esc / 失焦 / pointercancel / 收起侧栏 / 卸载）恢复拖拽前宽度，不写偏好；
 * - 只在指针抬起时提交一次偏好；
 * - 方向键按像素微调（库默认步长是面板组宽的 5%，随窗口宽度变化，与旧行为不一致）。
 *
 * 不直接依赖 DOM，便于单测；与库的对接见 Sidebar.tsx。
 */

export interface SidebarResizeDeps {
  /** 当前偏好宽度（store） */
  getWidth(): number
  setWidth(width: number, persist?: boolean): void
  /** 把面板调整到指定像素宽度（库的命令式 API） */
  resize(width: number): void
  /** 让库结束进行中的拖拽（对拖拽元素合成 pointercancel） */
  cancelLibraryDrag(pointerId: number): void
}

export type SidebarResizeKey = 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End'

const clamp = (w: number) => Math.round(Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, w)))

export function createSidebarResizeController(deps: SidebarResizeDeps) {
  let drag: { startWidth: number; pointerId: number } | null = null
  return {
    get active() {
      return drag !== null
    },
    begin(pointerId: number) {
      if (drag) return
      drag = { startWidth: deps.getWidth(), pointerId }
    },
    /** 指针抬起：按面板最终像素宽度提交一次偏好 */
    commit(width: number) {
      if (!drag) return
      drag = null
      deps.setWidth(width, true)
    },
    /** 取消路径统一走这里：结束库的拖拽、恢复原宽度，不写偏好 */
    cancel() {
      const current = drag
      if (!current) return
      drag = null
      deps.cancelLibraryDrag(current.pointerId)
      deps.setWidth(current.startWidth, false)
      deps.resize(current.startWidth)
    },
    /** 方向键 ±8px（Shift ±40px）微调，Home/End 到边界；返回是否已处理（应阻止默认与冒泡） */
    key(key: SidebarResizeKey, shiftKey: boolean) {
      const width = clamp(deps.getWidth())
      const next =
        key === 'Home'
          ? SIDEBAR_WIDTH.min
          : key === 'End'
            ? SIDEBAR_WIDTH.max
            : width + (key === 'ArrowLeft' ? -1 : 1) * (shiftKey ? 40 : 8)
      const clamped = clamp(next)
      if (clamped !== width) {
        deps.setWidth(clamped, true)
        deps.resize(clamped)
      }
      return true
    },
  }
}
