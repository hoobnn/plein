// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { useSidebar } from '../stores/sidebar'
import { createSidebarResizeController } from './sidebarResizeController'

/** 与库对接的最小替身：setWidth 走真实 store，resize / cancelLibraryDrag 记录调用 */
function setup() {
  const resized: number[] = []
  const cancelledPointers: number[] = []
  const controller = createSidebarResizeController({
    getWidth: () => useSidebar.getState().width,
    setWidth: useSidebar.getState().setWidth,
    resize: (width) => resized.push(width),
    cancelLibraryDrag: (pointerId) => cancelledPointers.push(pointerId),
  })
  return { controller, resized, cancelledPointers }
}

let written: Array<[string, string]>

beforeEach(() => {
  written = []
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => (key === 'plein:sidebar' ? 'open' : null),
    setItem: (key: string, value: string) => written.push([key, value]),
    removeItem: () => {},
  })
  useSidebar.setState({ width: 300 })
})
afterEach(() => vi.unstubAllGlobals())

describe('侧栏调整接驳层', () => {
  it('拖动中只改内存，松手按面板像素宽度提交一次偏好，重复提交不生效', () => {
    const { controller } = setup()
    controller.begin(7)
    expect(controller.active).toBe(true)
    // 模拟库拖动中经 onResize 回写的中间宽度：不写偏好
    useSidebar.getState().setWidth(360, false)
    expect(written).toEqual([])
    controller.commit(360)
    expect(written).toEqual([['plein:sidebar-width', '360']])
    expect(useSidebar.getState().width).toBe(360)
    // 已结束的拖拽再提交/取消都是空操作
    controller.commit(999)
    controller.cancel()
    expect(written).toEqual([['plein:sidebar-width', '360']])
  })

  it.each(['pointercancel', 'blur', 'Escape', '收起侧栏', '卸载'])(
    '%s 取消：恢复拖拽前宽度且不改写偏好，并让库结束拖拽',
    () => {
      const { controller, resized, cancelledPointers } = setup()
      controller.begin(7)
      useSidebar.getState().setWidth(400, false)
      controller.cancel()
      expect(cancelledPointers).toEqual([7])
      expect(resized).toEqual([300])
      expect(useSidebar.getState().width).toBe(300)
      expect(written).toEqual([])
      expect(controller.active).toBe(false)
      // 重复取消是空操作
      controller.cancel()
      expect(resized).toEqual([300])
    },
  )

  it('方向键按像素微调并即时提交，Shift 加倍步长', () => {
    const { controller } = setup()
    expect(controller.key('ArrowRight', false)).toBe(true)
    expect(useSidebar.getState().width).toBe(308)
    expect(controller.key('ArrowRight', true)).toBe(true)
    expect(useSidebar.getState().width).toBe(348)
    expect(controller.key('ArrowLeft', false)).toBe(true)
    expect(useSidebar.getState().width).toBe(340)
    expect(written).toEqual([
      ['plein:sidebar-width', '308'],
      ['plein:sidebar-width', '348'],
      ['plein:sidebar-width', '340'],
    ])
  })

  it('方向键在最小/最大宽度处停下，Home/End 直接到边界', () => {
    const { controller } = setup()
    useSidebar.setState({ width: 230 })
    controller.key('ArrowLeft', false)
    expect(useSidebar.getState().width).toBe(222)
    controller.key('ArrowLeft', false)
    expect(useSidebar.getState().width).toBe(220)
    controller.key('ArrowLeft', false)
    expect(useSidebar.getState().width).toBe(220)
    controller.key('End', false)
    expect(useSidebar.getState().width).toBe(480)
    controller.key('ArrowRight', true)
    expect(useSidebar.getState().width).toBe(480)
    controller.key('Home', false)
    expect(useSidebar.getState().width).toBe(220)
  })

  it('已存的旧宽度偏好照常读出生效', async () => {
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => (key === 'plein:sidebar-width' ? '360' : null),
      setItem: () => {},
      removeItem: () => {},
    })
    vi.resetModules()
    const { useSidebar: fresh } = await import('../stores/sidebar')
    expect(fresh.getState().width).toBe(360)
  })
})
