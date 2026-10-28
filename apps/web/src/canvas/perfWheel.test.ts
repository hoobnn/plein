import type { Page } from '@playwright/test'
import { afterEach, expect, test, vi } from 'vite-plus/test'
import { dispatchWheel } from '../../../../e2e/perf/wheel'
import { fitDemoMarkdown } from '../../../../e2e/perf/fixtures'

afterEach(() => vi.unstubAllGlobals())

async function gesture(zoom: boolean, stepsPerFrame?: number) {
  const events: WheelEventInit[] = []
  let frames = 0
  const host = {
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 1440, height: 900 }),
    dispatchEvent: (event: WheelEventInit) => events.push(event),
  }
  vi.stubGlobal('document', { querySelector: () => ({ parentElement: host }) })
  vi.stubGlobal(
    'WheelEvent',
    class {
      constructor(_type: string, init: WheelEventInit) {
        Object.assign(this, init)
      }
    },
  )
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => {
    frames++
    queueMicrotask(callback)
  })
  const page = { evaluate: (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg) }
  await dispatchWheel(page as unknown as Page, { frames: 60, perFrame: 2, zoom, stepsPerFrame })
  return { events, frames }
}

test.each([false, true])('CI 合并步骤保留全部滚轮事件及路径，zoom=%s', async (zoom) => {
  const original = await gesture(zoom)
  const batched = await gesture(zoom, 5)
  expect(original.events).toHaveLength(120)
  expect(batched.events).toEqual(original.events)
  // 最后一帧等待绘制后才返回，不能派发完事件就采样堆。
  expect(original.frames).toBe(61)
  expect(batched.frames).toBe(13)
  expect(original.events[0]).toMatchObject({ clientX: 730, clientY: 470, ctrlKey: zoom })
})

test.each([false, true])(
  '计时前统一实际便签高度，正文结构变化仍失败，changed=%s',
  async (changed) => {
    const elements = [
      { id: 'visible', kind: 'markdown', w: 240, h: 100, text: '# 镜头 354\n画面描述' },
      {
        id: 'offscreen',
        kind: 'markdown',
        w: 240,
        h: 180,
        text: changed ? '# 另一种正文' : '# 镜头 358\n画面描述',
      },
    ]
    const get = (id: string) => elements.find((el) => el.id === id)!
    const engine = {
      scene: { get },
      doc: {
        elements: () => elements,
        mutable: (id: string) => ({
          set: (_key: string, height: number) => {
            get(id).h = height
          },
        }),
        ydoc: { transact: (fn: () => void) => fn() },
        undo: { clear: vi.fn() },
      },
    }
    vi.stubGlobal('window', { __plein: { engine } })
    vi.stubGlobal('document', {
      querySelectorAll: () => [{ dataset: { markdownId: 'visible' } }],
    })
    const page = { evaluate: (fn: () => unknown) => fn() } as unknown as Page
    if (changed) {
      await expect(fitDemoMarkdown(page)).rejects.toThrow(/uniform width and line structure/)
      expect(elements[1]!.h).toBe(180)
    } else {
      await fitDemoMarkdown(page)
      expect(elements.map((el) => el.h)).toEqual([100, 100])
      expect(engine.doc.undo.clear).toHaveBeenCalledOnce()
    }
  },
)
