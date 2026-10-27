import type { Page } from '@playwright/test'
import { afterEach, expect, test, vi } from 'vite-plus/test'
import { readOpenSample } from '../../../../e2e/perf/probe'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

test('启动瀑布保留 probe 前完成和跨起点的请求，缓存命中保留零传输量', async () => {
  vi.stubGlobal('window', {
    __pleinOpenProbe: {
      startedAt: 100,
      engineReadyMs: 25,
      firstVisiblePreviewMs: 30,
      visibleMediaSettledMs: 40,
      stats: {},
      stop() {},
    },
  })
  vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
    {
      name: 'http://127.0.0.1:9510/assets/entry.js',
      initiatorType: 'script',
      startTime: 20,
      duration: 40,
      transferSize: 8192,
    },
    {
      name: 'http://127.0.0.1:9510/assets/editor.js',
      initiatorType: 'link',
      startTime: 95,
      duration: 30,
      transferSize: 4096,
    },
    {
      name: 'http://127.0.0.1:9510/api/assets/image/thumb-256',
      initiatorType: 'fetch',
      startTime: 125,
      duration: 2,
      transferSize: 0,
    },
  ] as PerformanceResourceTiming[])
  const page = {
    on: vi.fn(),
    off: vi.fn(),
    waitForFunction: async (check: () => unknown) => expect(check()).toBe(true),
    evaluate: async (read: (arg: unknown) => unknown, arg: unknown) => read(arg),
  } as unknown as Page
  const sample = await readOpenSample(page, {
    count: 1,
    failed: 0,
    variants: { 'thumb-256': 1 },
    runtimeErrors: [],
  })
  expect(sample.resources).toEqual([
    {
      name: '/assets/entry.js',
      initiator: 'script',
      startMs: -80,
      durationMs: 40,
      transferBytes: 8192,
    },
    {
      name: '/assets/editor.js',
      initiator: 'link',
      startMs: -5,
      durationMs: 30,
      transferBytes: 4096,
    },
    {
      name: '/api/assets/image/thumb-256',
      initiator: 'fetch',
      startMs: 25,
      durationMs: 2,
      transferBytes: 0,
    },
  ])
  expect(sample).toMatchObject({
    engineReadyMs: 25,
    firstVisiblePreviewMs: 30,
    visibleMediaSettledMs: 40,
  })
})
