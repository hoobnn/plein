import { vi } from 'vite-plus/test'

// 系统主题等模块会在 import 时持有 MQL；用例重置只能改值，不能换掉订阅对象。
const lists = new Map<string, MediaQueryList>()

/** 按查询表达式设置初值，并可主动派发 change；不假装执行 CSS 布局。 */
export function mockMatchMedia(matches: (query: string) => boolean = () => false) {
  const matchMedia = vi.fn((query: string): MediaQueryList => {
    const existing = lists.get(query)
    if (existing) return existing
    const events = new EventTarget()
    const list = Object.assign(events, {
      media: query,
      matches: matches(query),
      onchange: null as MediaQueryList['onchange'],
      addListener(listener: (event: MediaQueryListEvent) => void) {
        events.addEventListener('change', listener as EventListener)
      },
      removeListener(listener: (event: MediaQueryListEvent) => void) {
        events.removeEventListener('change', listener as EventListener)
      },
    }) as MediaQueryList
    lists.set(query, list)
    return list
  })
  vi.stubGlobal('matchMedia', matchMedia)
  const controller = {
    matchMedia,
    set(query: string, value: boolean) {
      const list = matchMedia(query)
      if (list.matches === value) return
      Object.defineProperty(list, 'matches', { configurable: true, value })
      const event = new Event('change') as MediaQueryListEvent
      Object.defineProperties(event, { matches: { value }, media: { value: query } })
      list.dispatchEvent(event)
      list.onchange?.call(list, event)
    },
  }
  for (const query of lists.keys()) controller.set(query, matches(query))
  return controller
}

/** happy-dom 不计算布局；测试显式提供尺寸，只验证组件收到尺寸后的反应。 */
export function mockResizeObserver() {
  const observers = new Set<Observer>()
  class Observer implements ResizeObserver {
    readonly targets = new Set<Element>()
    constructor(readonly callback: ResizeObserverCallback) {
      observers.add(this)
    }
    observe(target: Element) {
      this.targets.add(target)
      observers.add(this)
    }
    unobserve(target: Element) {
      this.targets.delete(target)
    }
    disconnect() {
      this.targets.clear()
      observers.delete(this)
    }
  }
  vi.stubGlobal('ResizeObserver', Observer)
  return {
    resize(target: Element, width: number, height: number) {
      const size = { inlineSize: width, blockSize: height }
      const entry: ResizeObserverEntry = {
        target,
        contentRect: new DOMRectReadOnly(0, 0, width, height),
        borderBoxSize: [size],
        contentBoxSize: [size],
        devicePixelContentBoxSize: [size],
      }
      for (const observer of observers) {
        if (observer.targets.has(target)) observer.callback([entry], observer)
      }
    },
  }
}
