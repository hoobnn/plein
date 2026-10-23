import { beforeEach, expect, it } from 'vite-plus/test'
import { useRecoveryRequests } from './recoveryRequests'

const key = (canvasId: string, jobId: string) => JSON.stringify([canvasId, jobId])
const store = () => useRecoveryRequests.getState()

beforeEach(() => useRecoveryRequests.setState({ pending: new Set() }))

it('同一帧重复提交同一任务的恢复请求时，只有第一次能开始', () => {
  const a = key('canvas', 'pending-recovery')
  expect(store().begin(a)).toBe(true)
  expect(store().begin(a)).toBe(false)
  expect([...store().pending]).toEqual([a])
})

it('请求结束后同一任务可以再次发起恢复', () => {
  const a = key('canvas', 'pending-recovery')
  store().begin(a)
  store().end(a)
  expect(store().pending.has(a)).toBe(false)
  expect(store().begin(a)).toBe(true)
})

it.each([
  ['不同任务', key('canvas', 'job-a'), key('canvas', 'job-b')],
  ['不同画布的同名任务', key('canvas-a', 'job'), key('canvas-b', 'job')],
])('%s的恢复请求互不影响', (_, a, b) => {
  expect(store().begin(a)).toBe(true)
  expect(store().begin(b)).toBe(true)
  store().end(a)
  expect(store().pending.has(b)).toBe(true)
  expect(store().begin(a)).toBe(true)
  expect(store().begin(b)).toBe(false)
})

it('开始和结束都换新集合以通知订阅的入口同步禁用，结束未进行的请求不改动状态', () => {
  const a = key('canvas', 'job')
  const states: ReadonlySet<string>[] = []
  const unsubscribe = useRecoveryRequests.subscribe((s) => states.push(s.pending))
  const before = store().pending
  store().begin(a)
  store().begin(a)
  const during = store().pending
  store().end(key('canvas', 'other'))
  store().end(a)
  store().end(a)
  unsubscribe()
  expect(during).not.toBe(before)
  expect(before.size).toBe(0)
  expect(states.map((s) => [...s])).toEqual([[a], []])
})
