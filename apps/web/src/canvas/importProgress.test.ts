import type { Engine } from '@plein/canvas-core'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { useCanvas } from '../stores/canvas'
import { beginImport } from './importProgress'

afterEach(() => {
  useCanvas.setState({ engine: null, importing: null, notice: null })
  vi.useRealTimers()
})

it('切换画布取消所有旧入口，已结束及未结束任务的迟到回调都不覆盖新进度', () => {
  vi.useFakeTimers()
  const old = {} as Engine
  useCanvas.setState({ engine: old })
  const reference = beginImport(old, 1)
  const toolbar = beginImport(old, 2)
  reference.progress(1)
  reference.finish(['旧画布失败'])
  expect(useCanvas.getState().importing).toEqual({ done: 1, total: 3 })
  const current = {} as Engine
  useCanvas.setState({ engine: current })
  expect(toolbar.signal.aborted).toBe(true)
  const fresh = beginImport(current, 4)
  reference.progress(99)
  toolbar.progress(99)
  toolbar.finish(['迟到错误'])
  expect(useCanvas.getState().importing).toEqual({ done: 0, total: 4 })
  expect(useCanvas.getState().notice).toBeNull()
  fresh.finish()
  expect(useCanvas.getState().importing).toBeNull()
})

it('跨入口先失败后成功，全部完成才显示失败且结束回调幂等', () => {
  vi.useFakeTimers()
  const engine = {} as Engine
  useCanvas.setState({ engine })
  const grid = beginImport(engine, 4)
  const history = beginImport(engine, 1)
  grid.progress(2)
  history.finish(['读取历史素材失败'])
  vi.advanceTimersByTime(5000)
  expect(useCanvas.getState().importing).toEqual({ done: 3, total: 5 })
  expect(useCanvas.getState().notice).toBeNull()
  grid.finish()
  expect(useCanvas.getState().notice).toBe('读取历史素材失败')
  const next = beginImport(engine, 2)
  grid.finish(['旧任务错误'])
  expect(useCanvas.getState().importing).toEqual({ done: 0, total: 2 })
  expect(useCanvas.getState().notice).toBeNull()
  next.finish()
})
