import type { Engine } from '@plein/canvas-core'
import { openDoc } from '@plein/doc/testing'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { useCanvas } from '../../stores/canvas'
import { beginContinueRequest, continueRequestKey, useContinueRequests } from './continueRequests'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  for (const controller of useContinueRequests.getState().pending.values()) controller.abort()
  useContinueRequests.setState({ pending: new Map() })
  useCanvas.setState({ engine: null, canvasId: null })
  useCanvas.getState().notify(null)
  vi.useRealTimers()
})
function owner() {
  vi.useFakeTimers()
  const doc = openDoc()
  cleanups.push(() => doc.destroy())
  const engine = { doc } as Engine
  useCanvas.setState({ engine, canvasId: 'canvas-a' })
  return engine
}
it('等待按文档、元素、素材和操作隔离；旧 finally 不清掉新的请求', () => {
  const engine = owner()
  const key = continueRequestKey(engine, 'create', 'source', 'asset-a')
  const store = useContinueRequests.getState()
  const first = store.begin(key)!
  expect(store.begin(key)).toBeNull()
  expect(
    new Set([
      key,
      continueRequestKey(engine, 'refresh', 'source', 'asset-a'),
      continueRequestKey(engine, 'create', 'other', 'asset-a'),
      continueRequestKey(engine, 'create', 'source', 'asset-b'),
    ]).size,
  ).toBe(4)
  store.cancel('missing')
  store.cancel(key)
  store.cancel(key)
  expect(first.signal.aborted).toBe(true)
  store.end(key, first)
  const second = store.begin(key)!
  store.end(key, first)
  expect(useContinueRequests.getState().pending.get(key)).toBe(second)
  store.end(key, second)
  expect(useContinueRequests.getState().pending.size).toBe(0)
})
it('旧引擎不提交；同画布普通状态变化不取消，同引擎画布身份变化也会取消', () => {
  const engine = owner()
  const key = continueRequestKey(engine, 'create', 'source', 'asset')
  expect(beginContinueRequest({} as Engine, key)).toBeNull()
  const request = beginContinueRequest(engine, key)!
  cleanups.push(request.finish)
  expect(beginContinueRequest(engine, key)).toBeNull()
  useCanvas.getState().notify('继续编辑')
  expect(request.current()).toBe(true)
  expect(request.signal.aborted).toBe(false)
  useCanvas.setState({ canvasId: 'canvas-b' })
  expect(request.current()).toBe(false)
  expect(request.signal.aborted).toBe(true)
  request.finish()
  expect(useContinueRequests.getState().pending.size).toBe(0)
})
it('切换引擎取消旧等待；完成后解除订阅，不误伤以后请求', () => {
  const engine = owner()
  const key = continueRequestKey(engine, 'refresh', 'source', 'asset')
  const request = beginContinueRequest(engine, key)!
  cleanups.push(request.finish)
  useCanvas.setState({ engine: null })
  expect(request.signal.aborted).toBe(true)
  request.finish()
  useCanvas.setState({ engine })
  const fresh = beginContinueRequest(engine, key)!
  fresh.finish()
  useCanvas.setState({ canvasId: 'canvas-b' })
  expect(fresh.signal.aborted).toBe(false)
})
