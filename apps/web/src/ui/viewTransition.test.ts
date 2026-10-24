import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

vi.mock('react-dom', () => ({ flushSync: (update: () => void) => update() }))

function deferred() {
  let resolve!: () => void
  let reject!: (reason: Error) => void
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

class TestElement {
  values = new Map<string, string>()
  style = {
    getPropertyValue: (key: string) => this.values.get(key) ?? '',
    getPropertyPriority: () => '',
    setProperty: (key: string, value: string) => this.values.set(key, value),
    removeProperty: (key: string) => this.values.delete(key),
  }
  getBoundingClientRect() {
    return { top: 20, left: 20, right: 240, bottom: 160 }
  }
}

function environment(reduced = false) {
  const attrs = new Map<string, string>()
  const runs: Array<{
    update: () => void
    ready: ReturnType<typeof deferred>
    finished: ReturnType<typeof deferred>
    skip: ReturnType<typeof vi.fn>
  }> = []
  const start = vi.fn((update: () => void) => {
    const ready = deferred()
    const finished = deferred()
    const skip = vi.fn(() => ready.reject(new Error('superseded')))
    runs.push({ update, ready, finished, skip })
    return { ready: ready.promise, finished: finished.promise, skipTransition: skip }
  })
  vi.stubGlobal('document', {
    documentElement: {
      setAttribute: (key: string, value: string) => attrs.set(key, value),
      removeAttribute: (key: string) => attrs.delete(key),
    },
    startViewTransition: start,
  })
  vi.stubGlobal('window', { matchMedia: () => ({ matches: reduced }) })
  vi.stubGlobal('HTMLElement', TestElement)
  vi.stubGlobal('innerHeight', 900)
  vi.stubGlobal('innerWidth', 1440)
  return { attrs, runs, start }
}

const element = () => new TestElement() as unknown as HTMLElement

beforeEach(() => vi.resetModules())
afterEach(() => vi.unstubAllGlobals())

describe('连续操作的空间转场', () => {
  it('工作流按钮能取消尚未执行的故事板切换，保留最后一次选择', async () => {
    const { attrs, runs } = environment()
    const { switchMode, useCanvas } = await import('../stores/canvas')
    useCanvas.setState({ mode: 'flow', engine: null })
    switchMode('board')
    switchMode('flow')
    runs[0]!.update()
    runs[0]!.finished.resolve()
    await Promise.resolve()
    expect(useCanvas.getState().mode).toBe('flow')
    expect(attrs.size).toBe(0)
  })

  it('旧转场迟到结束，不会擦除同方向新转场的标记', async () => {
    const { attrs, runs } = environment()
    const { slideView } = await import('./viewTransition')
    slideView('next', () => {})
    runs[0]!.update()
    slideView('next', () => {})
    expect(runs[0]!.skip).toHaveBeenCalledOnce()
    runs[0]!.finished.resolve()
    await Promise.resolve()
    expect(attrs.get('data-view-slide')).toBe('next')
    runs[1]!.update()
    runs[1]!.ready.resolve()
    runs[1]!.finished.resolve()
    await Promise.resolve()
    expect(attrs.size).toBe(0)
  })

  it('快速反向点击只执行尚未拍快照的最新目标', async () => {
    const { runs } = environment()
    const { slideView } = await import('./viewTransition')
    const first = vi.fn()
    const latest = vi.fn()
    slideView('next', first)
    slideView('prev', latest)
    runs[0]!.update()
    runs[1]!.update()
    expect(first).not.toHaveBeenCalled()
    expect(latest).toHaveBeenCalledOnce()
    runs[0]!.finished.resolve()
    runs[1]!.ready.resolve()
    runs[1]!.finished.resolve()
  })

  it('封面共享元素在两次快照间释放名称，结束后还原原来的内联值', async () => {
    const { runs } = environment()
    const { zoomView } = await import('./viewTransition')
    const from = element()
    const to = element()
    from.style.setProperty('view-transition-name', 'original-cover')
    zoomView('enter', () => {}, { from, to: () => to, shape: 'rect' })
    expect(from.style.getPropertyValue('view-transition-name')).toBe('app-stage')
    runs[0]!.update()
    expect(from.style.getPropertyValue('view-transition-name')).toBe('original-cover')
    expect(to.style.getPropertyValue('view-transition-name')).toBe('app-stage')
    runs[0]!.ready.resolve()
    runs[0]!.finished.resolve()
    await Promise.resolve()
    expect(to.style.getPropertyValue('view-transition-name')).toBe('')
  })

  it('中断共享元素转场立即释放旧名称，旧回调不改写新名称', async () => {
    const { runs } = environment()
    const { morphView } = await import('./viewTransition')
    const cover = element()
    morphView(
      () => {},
      cover,
      () => null,
    )
    morphView(
      () => {},
      cover,
      () => null,
    )
    runs[0]!.finished.resolve()
    await Promise.resolve()
    expect(cover.style.getPropertyValue('view-transition-name')).toBe('app-morph')
    runs[1]!.update()
    runs[1]!.ready.resolve()
    runs[1]!.finished.resolve()
  })

  it.each([true, false])(
    '减少动态效果或不支持时直接更新，保留元素原样（reduce=%s）',
    async (reduce) => {
      const { attrs, start } = environment(reduce)
      if (!reduce) Object.assign(document, { startViewTransition: undefined })
      const { zoomView } = await import('./viewTransition')
      const update = vi.fn()
      const from = element()
      zoomView('enter', update, { from })
      expect(update).toHaveBeenCalledOnce()
      expect(start).not.toHaveBeenCalled()
      expect(attrs.size).toBe(0)
      expect(from.style.getPropertyValue('view-transition-name')).toBe('')
    },
  )
})
