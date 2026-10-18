import { describe, expect, it } from 'vite-plus/test'
import type { Scene } from '@plein/canvas-core'
import type { Rect } from '@plein/doc'
import { clipOverlay, visibleRects } from './occlusion'

describe('DOM 内容遮挡', () => {
  const bounds = { x: 10, y: 20, w: 100, h: 80 }
  const area = (parts: ReturnType<typeof visibleRects>) => parts.reduce((n, r) => n + r.w * r.h, 0)
  it('保留无遮挡和仅贴边的内容', () => {
    expect(visibleRects(bounds, [{ x: 110, y: 20, w: 10, h: 80 }])).toEqual([bounds])
  })
  it('局部遮挡只扣除交集，完整遮挡没有可见区域', () => {
    const parts = visibleRects(bounds, [{ x: 30, y: 40, w: 20, h: 20 }])
    expect(parts).toHaveLength(4)
    expect(area(parts)).toBe(7600)
    expect(visibleRects(bounds, [bounds])).toEqual([])
  })
  it('多个遮挡重叠时不重新露出下层文字', () => {
    const covers = [
      { x: 10, y: 20, w: 70, h: 80 },
      { x: 50, y: 20, w: 60, h: 80 },
    ]
    expect(visibleRects(bounds, covers)).toEqual([])
    expect(visibleRects(bounds, [...covers, ...covers])).toEqual([])
  })
})

function fixture() {
  let covers: Rect[] = [{ x: 10, y: 20, w: 60, h: 40 }]
  let fullscreen = false
  let frame = false
  const bounds = { x: 10, y: 20, w: 100, h: 80 }
  const fragment = (left: number) => ({ left, top: 220, width: 40, height: 20 })
  const hidden = { inert: false, getClientRects: () => [fragment(120)] }
  const shown = { inert: false, getClientRects: () => [fragment(240)] }
  const multiline = { inert: false, getClientRects: () => [fragment(120), fragment(240)] }
  const controls = [hidden, shown, multiline]
  const box = { left: 100, top: 200, width: 200, height: 160 }
  const root = {
    inert: false,
    style: { zIndex: '', clipPath: '' },
    matches: () => fullscreen,
    querySelectorAll: () => controls,
    getBoundingClientRect: () => box,
  }
  const scene = {
    drawOrder: (id: string) => (id === 'note' ? 0 : 1),
    query: () => covers.map((_, i) => String(i)),
    get: () => ({ kind: frame ? 'frame' : 'node' }),
    rect: (id: string) => covers[Number(id)],
  } as unknown as Scene
  return {
    root,
    box,
    hidden,
    shown,
    multiline,
    bounds,
    clip: () => clipOverlay(root as unknown as HTMLElement, scene, 'note', bounds),
    covers: (value: Rect[]) => {
      covers = value
    },
    fullscreen: (value: boolean) => {
      fullscreen = value
    },
    frame: () => {
      frame = true
    },
  }
}

describe('遮挡与焦点状态', () => {
  it('换算相机缩放并保留有可见片段的控件，无遮挡时恢复', () => {
    const f = fixture()
    f.clip()
    expect(f.hidden.inert).toBe(true)
    expect(f.shown.inert).toBe(false)
    expect(f.multiline.inert).toBe(false)
    expect(f.root.inert).toBe(false)
    f.covers([])
    f.clip()
    expect(f.hidden.inert).toBe(false)
    expect(f.root.style.clipPath).toBe('')
  })
  it('完整遮挡禁用整层，全屏时恢复，退出后重新遵守遮挡', () => {
    const f = fixture()
    f.covers([f.bounds])
    f.clip()
    expect(f.root.inert).toBe(true)
    f.fullscreen(true)
    f.clip()
    expect(f.root.inert).toBe(false)
    f.fullscreen(false)
    f.clip()
    expect(f.root.inert).toBe(true)
    f.covers([])
    f.clip()
    expect(f.root.inert).toBe(false)
  })
  it('不清除其他原因已有的 inert 状态', () => {
    const f = fixture()
    f.root.inert = true
    f.hidden.inert = true
    f.clip()
    f.covers([])
    f.clip()
    expect(f.root.inert).toBe(true)
    expect(f.hidden.inert).toBe(true)
  })
  it('分组底板不遮挡交互，尚无布局尺寸时不推断子控件位置', () => {
    const f = fixture()
    f.frame()
    f.clip()
    expect(f.hidden.inert).toBe(false)
    const pending = fixture()
    pending.box.width = 0
    pending.clip()
    expect(pending.hidden.inert).toBe(false)
  })
})
