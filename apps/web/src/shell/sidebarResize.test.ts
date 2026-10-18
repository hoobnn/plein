import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { useSidebar } from '../stores/sidebar'
import { startSidebarResize } from './sidebarResize'

function event(type: string, fields = {}) {
  return Object.assign(new Event(type, { cancelable: true }), fields)
}

class Handle extends EventTarget {
  captured = new Set<number>()
  setPointerCapture(id: number) {
    this.captured.add(id)
  }
  hasPointerCapture(id: number) {
    return this.captured.has(id)
  }
  releasePointerCapture(id: number) {
    this.captured.delete(id)
    this.dispatchEvent(event('lostpointercapture', { pointerId: id }))
  }
}

let handle: Handle
let globalEvents: EventTarget
let classes: Set<string>
let write: ReturnType<typeof vi.fn>

beforeEach(() => {
  handle = new Handle()
  globalEvents = new EventTarget()
  classes = new Set()
  write = vi.fn()
  vi.stubGlobal('window', globalEvents)
  vi.stubGlobal('document', {
    documentElement: {
      classList: {
        add: (name: string) => classes.add(name),
        remove: (name: string) => classes.delete(name),
      },
    },
  })
  vi.stubGlobal('localStorage', { setItem: write })
  useSidebar.setState({ width: 300 })
})
afterEach(() => vi.unstubAllGlobals())

function begin() {
  const done = vi.fn()
  const cancel = startSidebarResize(
    handle as unknown as HTMLElement,
    { pointerId: 7, clientX: 300 },
    done,
  )
  handle.dispatchEvent(event('pointermove', { pointerId: 7, clientX: 360 }))
  expect(useSidebar.getState().width).toBe(360)
  expect(write).not.toHaveBeenCalled()
  return { done, cancel }
}

function cleaned(done: ReturnType<typeof vi.fn>) {
  expect(classes.has('plein-resizing')).toBe(false)
  expect(handle.hasPointerCapture(7)).toBe(false)
  expect(done).toHaveBeenCalledTimes(1)
  handle.dispatchEvent(event('pointermove', { pointerId: 7, clientX: 480 }))
  handle.dispatchEvent(event('pointerup', { pointerId: 7, clientX: 480 }))
  globalEvents.dispatchEvent(new Event('blur'))
}

describe('侧栏调整生命周期', () => {
  it('只在启动指针抬起时提交最终坐标，完成后清理全部监听', () => {
    const { done, cancel } = begin()
    for (const type of ['pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) {
      handle.dispatchEvent(event(type, { pointerId: 8, clientX: 100 }))
    }
    expect(useSidebar.getState().width).toBe(360)
    expect(done).not.toHaveBeenCalled()
    handle.dispatchEvent(event('pointerup', { pointerId: 7, clientX: 390 }))
    cleaned(done)
    cancel()
    expect(useSidebar.getState().width).toBe(390)
    expect(write.mock.calls).toEqual([['plein:sidebar-width', '390']])
    expect(done).toHaveBeenCalledTimes(1)
  })

  it.each(['pointercancel', 'lostpointercapture', 'blur', 'dispose', 'Escape'])(
    '%s 恢复原宽度且不改写已有偏好，清理可重复调用',
    (reason) => {
      const { done, cancel } = begin()
      if (reason === 'dispose') cancel()
      else if (reason === 'blur') globalEvents.dispatchEvent(new Event('blur'))
      else if (reason === 'Escape') {
        const key = event('keydown', { key: 'Escape' })
        globalEvents.dispatchEvent(key)
        expect(key.defaultPrevented).toBe(true)
      } else handle.dispatchEvent(event(reason, { pointerId: 7, clientX: 0 }))
      cancel()
      cleaned(done)
      expect(useSidebar.getState().width).toBe(300)
      expect(write).not.toHaveBeenCalled()
    },
  )

  it('输入法组合中的 Escape 不取消拖动；后续正常 Escape 仍可取消', () => {
    const { done } = begin()
    for (const fields of [
      { key: 'Enter' },
      { key: 'Escape', isComposing: true },
      { key: 'Escape', keyCode: 229 },
    ]) {
      const key = event('keydown', fields)
      globalEvents.dispatchEvent(key)
      expect(key.defaultPrevented).toBe(false)
    }
    expect(done).not.toHaveBeenCalled()
    globalEvents.dispatchEvent(event('keydown', { key: 'Escape' }))
    cleaned(done)
    expect(useSidebar.getState().width).toBe(300)
  })
})
