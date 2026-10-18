import type { Engine } from '@plein/canvas-core'
import { afterEach, beforeEach, expect, it, vi } from 'vite-plus/test'
import { useCanvas } from '../../stores/canvas'
import { locateTaskTarget } from './taskNavigation'

const initial = useCanvas.getState()
let desktop = false
let frames: FrameRequestCallback[] = []
const has = vi.fn(() => true)
const select = vi.fn()
const fit = vi.fn()
const engine = { doc: { has }, selection: { set: select }, zoomToFit: fit } as unknown as Engine
beforeEach(() => {
  desktop = false
  frames = []
  has.mockReset().mockReturnValue(true)
  select.mockReset()
  fit.mockReset()
  vi.stubGlobal('window', { matchMedia: () => ({ matches: desktop }) })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
  useCanvas.setState({ ...initial, canvasId: 'original-canvas', engine, tasks: true }, true)
})
afterEach(() => {
  useCanvas.setState(initial, true)
  vi.unstubAllGlobals()
})

it('桌面保留任务面板并立即定位，手机先收起面板再等待可见区域更新', () => {
  desktop = true
  locateTaskTarget('node')
  expect(select).toHaveBeenLastCalledWith(['node'])
  expect(fit).toHaveBeenCalledWith(['node'])
  expect(useCanvas.getState().tasks).toBe(true)
  expect(frames).toHaveLength(0)
  desktop = false
  fit.mockClear()
  locateTaskTarget('node')
  expect(useCanvas.getState().tasks).toBe(false)
  expect(fit).not.toHaveBeenCalled()
  frames[0]!(0)
  expect(fit).toHaveBeenCalledExactlyOnceWith(['node'])
})

it.each(['canvas', 'engine', 'deleted', 'reopened'] as const)(
  '定位等待期间 %s 变化不能操作旧目标',
  (change) => {
    locateTaskTarget('node')
    if (change === 'canvas') useCanvas.setState({ canvasId: 'other-canvas' })
    if (change === 'engine') useCanvas.setState({ engine: null })
    if (change === 'deleted') has.mockReturnValue(false)
    if (change === 'reopened') useCanvas.setState({ tasks: true })
    frames[0]!(0)
    expect(fit).not.toHaveBeenCalled()
  },
)

it('已删除目标不改变选区、不关闭面板，也不安排延迟定位', () => {
  has.mockReturnValue(false)
  locateTaskTarget('missing')
  expect(select).not.toHaveBeenCalled()
  expect(useCanvas.getState().tasks).toBe(true)
  expect(frames).toHaveLength(0)
})
