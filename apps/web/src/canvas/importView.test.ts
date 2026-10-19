import { Camera, type Engine } from '@plein/canvas-core'
import { createElement } from '@plein/doc'
import { openDoc } from '@plein/doc/testing'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { useCanvas } from '../stores/canvas'
import { importLocation, watchImportView } from './importView'

class Target extends EventTarget {
  isContentEditable = false
  closest() {
    return null
  }
}
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const dispose of cleanups.splice(0)) dispose()
  useCanvas.setState({ engine: null, canvasId: null })
  useCanvas.getState().notify(null)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
function setup() {
  vi.useFakeTimers()
  const win = new EventTarget(),
    body = new Target()
  const page = { activeElement: body }
  vi.stubGlobal('window', win)
  vi.stubGlobal('document', page)
  vi.stubGlobal('HTMLElement', Target)
  for (const name of [
    'HTMLInputElement',
    'HTMLTextAreaElement',
    'HTMLSelectElement',
    'HTMLMediaElement',
  ])
    vi.stubGlobal(name, class extends Target {})
  const selection = new Set<() => void>(),
    state = new Set<() => void>()
  const camera = new Camera()
  camera.setViewport(800, 600)
  const doc = openDoc()
  cleanups.push(() => doc.destroy())
  let ids: string[] = []
  const engine = {
    doc,
    camera,
    state: { tool: 'select' },
    selection: {
      onChange(fn: () => void) {
        selection.add(fn)
        return () => selection.delete(fn)
      },
      set(next: string[]) {
        ids = next
        for (const fn of selection) fn()
      },
      values: () => ids,
    },
    onStateChange(fn: () => void) {
      state.add(fn)
      return () => state.delete(fn)
    },
    setTool: vi.fn(),
    zoomToFit: vi.fn(),
  } as unknown as Engine
  useCanvas.setState({ engine, canvasId: 'canvas' })
  return { engine, win, page, body, selection, state }
}
it.each(['selection', 'camera', 'tool', 'input', 'pointerdown', 'wheel'] as const)(
  '%s 操作即使最终恢复也不允许后台完成接管上下文',
  (change) => {
    const f = setup(),
      view = watchImportView(f.engine)
    cleanups.push(view.dispose)
    expect(view.unchanged()).toBe(true)
    if (change === 'selection') {
      f.engine.selection.set(['new'])
      f.engine.selection.set([])
    } else if (change === 'camera') {
      f.engine.camera.panBy(10, 0)
      f.engine.camera.panBy(-10, 0)
    } else if (change === 'tool') {
      Object.assign(f.engine.state, { tool: 'hand' })
      for (const fn of f.state) fn()
      Object.assign(f.engine.state, { tool: 'select' })
      for (const fn of f.state) fn()
    } else f.win.dispatchEvent(new Event(change))
    expect(view.unchanged()).toBe(false)
  },
)
it('没有交互的普通状态更新保持上下文；切到其他可编辑控件则放弃接管', () => {
  const f = setup(),
    view = watchImportView(f.engine)
  cleanups.push(view.dispose)
  for (const fn of f.state) fn()
  expect(view.unchanged()).toBe(true)
  const Input = globalThis.HTMLInputElement
  f.page.activeElement = new Input() as unknown as Target
  expect(view.unchanged()).toBe(false)
  f.page.activeElement = f.body
  expect(view.unchanged()).toBe(true)
})
it.each([false, true])('取消（预先取消 %s）解除所有监听，重复清理无副作用', (before) => {
  const f = setup(),
    controller = new AbortController()
  if (before) controller.abort()
  const remove = vi.spyOn(f.win, 'removeEventListener')
  const view = watchImportView(f.engine, controller.signal)
  controller.abort()
  view.dispose()
  view.dispose()
  expect(view.unchanged()).toBe(false)
  expect(f.selection.size).toBe(0)
  expect(f.state.size).toBe(0)
  expect(remove).toHaveBeenCalledTimes(3)
})
it('定位只使用仍存在的产物，并遵守当前引擎；全部删除后明确提示', () => {
  const f = setup()
  const id = createElement(f.engine.doc, {
    kind: 'image',
    assetId: 'new',
    x: 2000,
    y: 1000,
    w: 100,
    h: 80,
  })
  const action = importLocation(f.engine, [id, 'missing'])
  useCanvas.setState({ engine: null })
  action.run()
  expect(f.engine.selection.values()).toEqual([])
  useCanvas.setState({ engine: f.engine })
  action.run()
  expect(f.engine.selection.values()).toEqual([id])
  const p = f.engine.camera.worldToScreen(2050, 1040)
  expect(p.x).toBeGreaterThan(0)
  expect(p.x).toBeLessThan(800)
  expect(p.y).toBeGreaterThan(0)
  expect(p.y).toBeLessThan(600)
  f.engine.doc.elementMaps.delete(id)
  action.run()
  expect(useCanvas.getState().notice).toBe('导入的素材已不在画布上')
})
