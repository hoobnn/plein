// @vitest-environment happy-dom
import type { Engine } from '@plein/canvas-core'
import { createDoc, createElement, deleteElements } from '@plein/doc'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { CanvasOverlays } from './overlays'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function setup() {
  const doc = createDoc(undefined, { schedule: () => {} })
  const visibleIds = new Set<string>()
  const listeners = new Set<() => void>()
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  const root = document.createElement('div')
  const host = document.createElement('div')
  const fitContent = vi.fn()
  const engine = {
    doc,
    highDetail: true,
    visibleIds,
    scene: {
      get: (id: string) => doc.get(id),
      rect: (id: string) => doc.worldRect(id),
      drawOrder: () => 0,
      query: () => [...visibleIds],
    },
    camera: { viewRect: { x: 0, y: 0, w: 1000, h: 1000 }, onInsetsChange: subscribe },
    onStateChange: subscribe,
    onViewChange: subscribe,
    onMove: subscribe,
    onActivate: subscribe,
    selection: { onChange: subscribe, has: () => false },
    fitContent,
  } as unknown as Engine
  const overlays = new CanvasOverlays(engine, root, host, { originalUrl: () => '' })
  cleanups.push(() => {
    overlays.destroy()
    doc.destroy()
    doc.ydoc.destroy()
  })
  const add = (text: string) => {
    const id = createElement(doc, { kind: 'markdown', x: 0, y: 0, w: 200, h: 100, text })
    visibleIds.add(id)
    overlays.sync()
    return id
  }
  return { doc, visibleIds, overlays, fitContent, add, root, listeners, engine }
}

describe('Markdown 预览量高缓存', () => {
  it('反复创建删除正文后释放全部量高文本和预览节点', () => {
    const { doc, visibleIds, overlays, add, root } = setup()
    for (let i = 0; i < 100; i++) {
      const id = add(`${i}: ${'正文'.repeat(16_384)}`)
      expect(overlays.stats.fittedEntries).toBe(1)
      expect(overlays.stats.fittedCharacters).toBeGreaterThan(32_768)
      deleteElements(doc, [id])
      visibleIds.delete(id)
      doc.undo.clear()
      overlays.sync()
    }
    expect(overlays.stats).toEqual({ fittedEntries: 0, fittedCharacters: 0 })
    expect(root.querySelectorAll('[data-markdown-id]')).toHaveLength(0)
  })

  it('同一预览复用量高，出视口释放，重新进入重新测量', () => {
    const { visibleIds, overlays, fitContent, add } = setup()
    const id = add('正文')
    expect(fitContent).toHaveBeenCalledTimes(1)
    overlays.sync(false)
    expect(fitContent).toHaveBeenCalledTimes(1)
    visibleIds.clear()
    overlays.sync(false)
    expect(overlays.stats.fittedEntries).toBe(0)
    visibleIds.add(id)
    overlays.sync(false)
    expect(fitContent).toHaveBeenCalledTimes(2)
    expect(overlays.stats.fittedEntries).toBe(1)
  })

  it('低细节与销毁会释放正文缓存，销毁注销所有引擎订阅', () => {
    const { overlays, add, engine, listeners } = setup()
    add('正文')
    Object.defineProperty(engine, 'highDetail', { value: false, configurable: true })
    overlays.sync(false)
    expect(overlays.stats.fittedEntries).toBe(0)
    Object.defineProperty(engine, 'highDetail', { value: true })
    overlays.sync(false)
    expect(overlays.stats.fittedEntries).toBe(1)
    overlays.destroy()
    expect(overlays.stats).toEqual({ fittedEntries: 0, fittedCharacters: 0 })
    expect(listeners.size).toBe(0)
  })
})
