import type { Engine } from '@plein/canvas-core'
import { afterEach, expect, test, vi } from 'vite-plus/test'
import { useCanvas } from './canvas'

const initial = useCanvas.getState()
const engine = () =>
  ({
    state: {
      tool: 'select',
      zoom: 1,
      selection: 0,
      canUndo: false,
      canRedo: false,
      edgesHidden: false,
    },
    onStateChange: () => () => {},
    onMenu: () => () => {},
    onArrange: () => () => {},
  }) as unknown as Engine

afterEach(() => {
  useCanvas.getState().notify(null)
  useCanvas.setState(initial, true)
  vi.useRealTimers()
})

test('普通画布提示及其操作在画布退出时清理', () => {
  const detach = useCanvas.getState().attach(engine())
  useCanvas.getState().notify('画布内的操作结果', { label: '撤销', run: vi.fn() })
  detach()
  expect(useCanvas.getState().notice).toBeNull()
  expect(useCanvas.getState().noticeAction).toBeNull()
})

test('应用级导航提示保留到画布退出后，并按原提示时限自动结束', () => {
  vi.useFakeTimers()
  const detach = useCanvas.getState().attach(engine())
  useCanvas.getState().notify('画布不存在或已被删除', undefined, 'app')
  vi.advanceTimersByTime(1000)
  detach()
  expect(useCanvas.getState().engine).toBeNull()
  expect(useCanvas.getState().notice).toBe('画布不存在或已被删除')
  vi.advanceTimersByTime(2999)
  expect(useCanvas.getState().notice).not.toBeNull()
  vi.advanceTimersByTime(1)
  expect(useCanvas.getState().notice).toBeNull()
  expect(useCanvas.getState().noticeAction).toBeNull()
})
