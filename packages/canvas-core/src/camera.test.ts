import { describe, expect, it } from 'vite-plus/test'
import { Camera } from './camera'

const camera = (x = 0, y = 0, zoom = 1) => Object.assign(new Camera(), { x, y, zoom })

describe('Camera', () => {
  it('边距变化单独通知布局，保留位置和普通相机通知语义', () => {
    const cam = camera(5, 6, 2)
    let moved = 0
    const seen: (typeof cam.insets)[] = []
    cam.onChange(() => moved++)
    const off = cam.onInsetsChange(() => seen.push({ ...cam.insets }))
    cam.setInsets({ left: 200 })
    cam.setInsets({ right: 320 })
    expect(seen).toEqual([
      { left: 200, right: 0, top: 0, bottom: 0 },
      { left: 200, right: 320, top: 0, bottom: 0 },
    ])
    expect(cam).toMatchObject({ x: 5, y: 6, zoom: 2 })
    expect(moved).toBe(0)
    off()
    cam.setInsets({ left: 100 })
    expect(seen).toHaveLength(2)
    expect(cam.insets.left).toBe(100)
  })
  it('相同边距不重复发送布局通知', () => {
    const cam = camera()
    let count = 0
    cam.onInsetsChange(() => count++)
    cam.setInsets({})
    cam.setInsets({ left: 20 })
    cam.setInsets({ left: 20, right: 0 })
    expect(count).toBe(1)
  })
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

  it.each([0.2, 0.249, 0.25, 0.5, 0.001, 100])(
    '指定缩放 %s 保留准确边界、中心锚点并只通知一次',
    (zoom) => {
      const cam = camera(13, -7, 0.09)
      cam.setViewport(1440, 900)
      const before = cam.screenToWorld(720, 450)
      const seen: number[] = []
      cam.onChange(() => seen.push(cam.zoom))
      cam.zoomTo(zoom)
      const expected = Math.min(cam.maxZoom, Math.max(cam.minZoom, zoom))
      expect(cam.zoom).toBe(expected)
      expect(seen).toEqual([expected])
      const after = cam.screenToWorld(720, 450)
      expect(after.x).toBeCloseTo(before.x)
      expect(after.y).toBeCloseTo(before.y)
    },
  )

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

  it.each([
    { x: -40000, y: 500, w: 80000, h: 900 },
    { x: 100, y: -60000, w: 800, h: 120000 },
  ])('适配巨大目标 $w × $h 完整避开面板，继续缩放不会跳回 5%', (r) => {
    const cam = camera()
    cam.setViewport(1440, 900)
    cam.setInsets({ left: 280, top: 80, bottom: 64 })
    const target = cam.fitTarget(r)
    expect(target.zoom).toBeLessThan(0.05)
    expect(cam.zoom).toBe(1) // 计算动画目标不改变相机。
    cam.fit(r)
    expect(cam.zoom).toBe(target.zoom)
    expect(cam.worldToScreen(r.x, r.y).x).toBeGreaterThanOrEqual(344)
    expect(cam.worldToScreen(r.x, r.y).y).toBeGreaterThanOrEqual(144)
    expect(cam.worldToScreen(r.x + r.w, r.y + r.h).x).toBeLessThanOrEqual(1376)
    expect(cam.worldToScreen(r.x + r.w, r.y + r.h).y).toBeLessThanOrEqual(772)
    cam.zoomAt(720, 450, 1.1)
    expect(cam.zoom).toBeCloseTo(target.zoom * 1.1)
    cam.zoomAt(720, 450, 0.01)
    expect(cam.zoom).toBe(target.zoom)
    // 定位动画从普通比例逐步走到同一目标，也必须实际到达。
    const animated = camera()
    animated.setViewport(1440, 900)
    animated.setInsets(cam.insets)
    animated.lookAt(target.x, target.y, target.zoom)
    expect(animated.zoom).toBe(target.zoom)
    expect(animated.center.x).toBeCloseTo(target.x)
    expect(animated.center.y).toBeCloseTo(target.y)
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
