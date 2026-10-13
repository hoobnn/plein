import { describe, expect, it } from 'vite-plus/test'
import { Camera } from './camera'

const camera = (x = 0, y = 0, zoom = 1) => Object.assign(new Camera(), { x, y, zoom })

describe('Camera', () => {
  it.each([2, 0.5, 1000, 1e-6])('按光标缩放 ×%s：光标下的世界点不动，倍数夹在范围内', (factor) => {
    const cam = camera(10, 20)
    const before = cam.screenToWorld(300, 200)
    cam.zoomAt(300, 200, factor)
    const after = cam.screenToWorld(300, 200)
    expect(after.x).toBeCloseTo(before.x)
    expect(after.y).toBeCloseTo(before.y)
    expect(cam.zoom).toBe(Math.min(cam.maxZoom, Math.max(cam.minZoom, factor)))
  })

  it('屏幕与世界坐标互转', () => {
    const cam = camera(13, -7, 1.5)
    const w = cam.screenToWorld(120, 45)
    const s = cam.worldToScreen(w.x, w.y)
    expect(s.x).toBeCloseTo(120)
    expect(s.y).toBeCloseTo(45)
  })

  it('fit 居中到挡板之外的区域，不超过 maxZoom', () => {
    const cam = camera()
    cam.setViewport(1000, 800)
    cam.setInsets({ left: 200 })
    const r = { x: 0, y: 0, w: 100, h: 100 }
    cam.fit(r, 64)
    // 可见区域 800×800，中心在 (600, 400)
    expect(cam).toMatchObject({ zoom: 1, x: 550, y: 350 })
    cam.fit(r, 64, 4)
    expect(cam.zoom).toBe(4)
    expect(cam.worldToScreen(50, 50)).toEqual({ x: 600, y: 400 })
  })

  it('视口还没有尺寸时 fit 不动', () => {
    const cam = camera(5, 6, 2)
    let changed = 0
    cam.onChange(() => changed++)
    cam.fit({ x: 0, y: 0, w: 100, h: 100 })
    expect(cam).toMatchObject({ x: 5, y: 6, zoom: 2 })
    expect(changed).toBe(0)
  })
})
