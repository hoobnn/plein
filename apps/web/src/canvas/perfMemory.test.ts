import type { CDPSession, Page } from '@playwright/test'
import { afterEach, expect, test, vi } from 'vite-plus/test'
import { measureSession, sampleHeap } from '../../../../e2e/perf/memory'

afterEach(() => vi.useRealTimers())

function fixture(onGc = () => {}) {
  const page = {
    waitForFunction: vi.fn(async () => {}),
    evaluate: vi.fn(async () => ({
      resources: { previews: { failed: 0 }, textures: { loadErrors: 0, unloadErrors: 0 } },
      caches: null,
    })),
  }
  const cdp = {
    send: vi.fn(async (method: string) => {
      if (method === 'HeapProfiler.collectGarbage') onGc()
      if (method === 'Runtime.getHeapUsage') return { usedSize: 1000 }
      return { documents: 1, nodes: 10, jsEventListeners: 2 }
    }),
  }
  return { page, cdp, runPage: page as unknown as Page, runCdp: cdp as unknown as CDPSession }
}

test('固定工作量不因慢机器减少循环次数，预热不计入测量次数', async () => {
  vi.useFakeTimers({ toFake: ['performance'] })
  const f = fixture()
  const interact = vi.fn(async () => {
    vi.advanceTimersByTime(40_000)
  })
  const result = await measureSession(f.runPage, f.runCdp, 1000, interact, 3)
  expect(interact).toHaveBeenCalledTimes(4)
  expect(result.iterations).toBe(3)
  expect(result.samples.at(-1)!.iteration).toBe(3)
  expect(result.samples.at(-1)!.elapsedMs).toBe(120_000)
})

test('十分钟诊断先完成基线 GC 再计时，不把资源等待冒充交互', async () => {
  vi.useFakeTimers({ toFake: ['performance'] })
  const f = fixture(() => vi.advanceTimersByTime(60_000))
  const interact = vi.fn(async () => {
    vi.advanceTimersByTime(1000)
  })
  const result = await measureSession(f.runPage, f.runCdp, 1000, interact)
  expect(result.iterations).toBe(1)
  expect(interact).toHaveBeenCalledTimes(2)
  expect(result.samples.at(-1)!.elapsedMs).toBe(1000)
})

test('媒体加载失败不能以较小堆伪装成内存改善', async () => {
  const f = fixture()
  f.page.evaluate.mockResolvedValue({
    resources: { previews: { failed: 1 }, textures: { loadErrors: 1, unloadErrors: 0 } },
    caches: null,
  })
  await expect(sampleHeap(f.runPage, f.runCdp)).rejects.toThrow(/failed media/)
})
