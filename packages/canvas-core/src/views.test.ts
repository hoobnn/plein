import { createElements } from '@plein/doc'
import { box, openDoc } from '@plein/doc/testing'
import { Container } from 'pixi.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { RendererRegistry } from './renderers'
import { Scene } from './scene'
import { ElementViews, OFFSCREEN_BODY_LIMIT, OFFSCREEN_BODY_MS } from './views'

function setup(count = 1) {
  const doc = openDoc()
  const ids = createElements(
    doc,
    Array.from({ length: count }, (_, i) => box({ x: i * 1000 })),
  )
  const scene = new Scene(doc)
  const created: {
    display: Container
    initialDetail: boolean | undefined
    destroy: () => void
    update: () => void
  }[] = []
  const registry = new RendererRegistry(false)
  registry.register('image', (_el, ctx) => {
    const display = new Container()
    const destroy = vi.fn(() => display.destroy({ children: true }))
    const update = vi.fn()
    created.push({ display, initialDetail: ctx.initialDetail, destroy, update })
    return { display, update, setDetail: vi.fn(), destroy }
  })
  const views = new ElementViews(scene, registry, {})
  views.sync(scene.rebuild())
  return { doc, ids, scene, views, created }
}

const near = { x: 0, y: 0, w: 200, h: 200 }
const far = { x: 1e9, y: 1e9, w: 200, h: 200 }

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('ElementViews residency', () => {
  it('passes low detail before creation and reuses a body within the offscreen grace', async () => {
    const { doc, views, created } = setup()
    views.cull(near, 0.1)
    expect(created).toHaveLength(1)
    expect(created[0]!.initialDetail).toBe(false)
    views.cull(far, 0.1)
    expect(views.stats).toMatchObject({ residentBodies: 1, visibleBodies: 0, offscreenBodies: 1 })
    await vi.advanceTimersByTimeAsync(OFFSCREEN_BODY_MS - 1)
    expect(created[0]!.destroy).not.toHaveBeenCalled()
    views.cull(near, 0.1)
    await vi.advanceTimersByTimeAsync(OFFSCREEN_BODY_MS)
    expect(created).toHaveLength(1)
    expect(views.stats).toMatchObject({ residentBodies: 1, visibleBodies: 1, offscreenBodies: 0 })
    views.destroy()
    doc.destroy()
  })

  it('expires bodies while the camera is idle, preserves the scene and recreates them on entry', async () => {
    const { doc, ids, scene, views, created } = setup()
    views.cull(near, 1)
    views.cull(far, 1)
    await vi.advanceTimersByTimeAsync(OFFSCREEN_BODY_MS)
    expect(created[0]!.destroy).toHaveBeenCalledTimes(1)
    expect(views.stats.residentBodies).toBe(0)
    expect(scene.query(near)).toContain(ids[0])
    views.cull(near, 1)
    expect(created).toHaveLength(2)
    expect(views.visibleIds.has(ids[0]!)).toBe(true)
    views.destroy()
    await vi.advanceTimersByTimeAsync(OFFSCREEN_BODY_MS * 2)
    expect(created[1]!.destroy).toHaveBeenCalledTimes(1)
    doc.destroy()
  })

  it('refreshes a retained offscreen body after a theme change', () => {
    const { doc, views, created } = setup()
    views.cull(near, 1)
    views.cull(far, 1)
    views.refreshAll()
    expect(created[0]!.update).not.toHaveBeenCalled()
    views.cull(near, 1)
    expect(created[0]!.update).toHaveBeenCalledTimes(1)
    expect(created).toHaveLength(1)
    views.destroy()
    doc.destroy()
  })

  it('bounds offscreen bodies immediately and tears down the remaining timer', async () => {
    const { doc, views, created } = setup(OFFSCREEN_BODY_LIMIT + 40)
    views.cull({ x: 0, y: 0, w: 1e6, h: 200 }, 1)
    expect(created).toHaveLength(OFFSCREEN_BODY_LIMIT + 40)
    views.cull(far, 1)
    expect(views.stats.offscreenBodies).toBe(OFFSCREEN_BODY_LIMIT)
    expect(created.filter((view) => view.display.destroyed)).toHaveLength(40)
    views.destroy()
    await vi.advanceTimersByTimeAsync(OFFSCREEN_BODY_MS * 2)
    expect(created.every((view) => vi.mocked(view.destroy).mock.calls.length === 1)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    doc.destroy()
  })
})
