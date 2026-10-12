import { bringToFront, createElement, deleteElements, moveElements, setParent } from '@plein/doc'
import { box, openDoc } from '@plein/doc/testing'
import { describe, expect, it } from 'vitest'
import { mapRect, resizeBox, snapMove } from './geometry'
import { Scene } from './scene'

function setup() {
  const doc = openDoc()
  const scene = new Scene(doc)
  const sync = () => {
    let update = null as ReturnType<Scene['apply']> | null
    const off = doc.subscribe((c) => {
      update = scene.apply(c)
    })
    doc.flush()
    off()
    return update
  }
  return { doc, scene, sync }
}

describe('Scene', () => {
  it('子元素世界坐标随父元素移动，R-tree 同步更新', () => {
    const { doc, scene, sync } = setup()
    const frame = createElement(doc, box({ kind: 'frame', w: 500, h: 500 }))
    const child = createElement(doc, box({ x: 50, y: 50 }))
    setParent(doc, [child], frame)
    sync()
    expect(scene.parent(child)).toBe(frame)

    moveElements(doc, [frame], 1000, 0)
    sync()
    expect(scene.rect(child)).toMatchObject({ x: 1050, y: 50 })
    expect(scene.query({ x: 1040, y: 40, w: 20, h: 20 })).toContain(child)
    expect(scene.query({ x: 40, y: 40, w: 20, h: 20 })).toEqual([])
  })

  it('命中测试取最上层，z 序变化后重排', () => {
    const { doc, scene, sync } = setup()
    const a = createElement(doc, box())
    const b = createElement(doc, box({ x: 50 }))
    sync()
    expect(scene.hitTest(75, 50)).toBe(b)
    bringToFront(doc, [a])
    const u = sync()
    expect(u?.structure).toBe(true)
    expect(scene.hitTest(75, 50)).toBe(a)
    expect(scene.children(null)).toEqual([b, a])
  })

  it('父元素被删时子元素一并移除', () => {
    const { doc, scene, sync } = setup()
    const frame = createElement(doc, box({ kind: 'frame', w: 500, h: 500 }))
    const child = createElement(doc, box({ parentId: frame }))
    sync()
    deleteElements(doc, [frame])
    const u = sync()
    expect([...(u?.removed ?? [])].sort()).toEqual([child, frame].sort())
    expect(scene.size).toBe(0)
  })

  it('预览几何覆盖文档几何，并级联到子元素', () => {
    const { doc, scene, sync } = setup()
    const frame = createElement(doc, box({ kind: 'frame', w: 500, h: 500 }))
    const child = createElement(doc, box({ parentId: frame, x: 10, y: 10 }))
    sync()
    scene.setTransient(new Map([[frame, { x: 200 }]]))
    expect(scene.rect(child)).toMatchObject({ x: 210, y: 10 })
    expect(doc.get(frame)!.x).toBe(0)
    scene.clearTransient()
    expect(scene.rect(child)).toMatchObject({ x: 10 })
  })
})

describe('几何', () => {
  it('角手柄缩放与等比', () => {
    const b = { x: 0, y: 0, w: 200, h: 100 }
    expect(resizeBox(b, 'se', 100, 0)).toEqual({ x: 0, y: 0, w: 300, h: 100 })
    expect(resizeBox(b, 'se', 100, 0, true)).toEqual({ x: 0, y: 0, w: 300, h: 150 })
    expect(resizeBox(b, 'nw', 50, 50)).toEqual({ x: 50, y: 50, w: 150, h: 50 })
    // 拖过对边时夹在最小尺寸
    expect(resizeBox(b, 'e', -500, 0).w).toBe(8)
  })

  it('边手柄等比：按该边比例，另一方向居中', () => {
    const b = { x: 0, y: 0, w: 200, h: 100 }
    expect(resizeBox(b, 'e', 100, 0, true)).toEqual({ x: 0, y: -25, w: 300, h: 150 })
    expect(resizeBox(b, 's', 0, 50, true)).toEqual({ x: -50, y: 0, w: 300, h: 150 })
  })

  it('多选缩放按包围盒线性映射', () => {
    const from = { x: 0, y: 0, w: 100, h: 100 }
    const to = { x: 0, y: 0, w: 200, h: 200 }
    expect(mapRect({ x: 50, y: 50, w: 50, h: 50 }, from, to)).toEqual({
      x: 100,
      y: 100,
      w: 100,
      h: 100,
    })
  })

  it('吸附到最近的边或中线并给出参考线', () => {
    const moving = { x: 103, y: 500, w: 50, h: 50 }
    const target = { x: 0, y: 0, w: 100, h: 100 }
    const r = snapMove(moving, [target], 6)
    expect(r.dx).toBe(-3)
    expect(r.dy).toBe(0)
    expect(r.guides).toEqual([{ axis: 'x', at: 100, from: 0, to: 550 }])
  })

  it('纵向吸附取最近的线，超出阈值不吸', () => {
    const near = { x: 0, y: 0, w: 100, h: 100 }
    const nearer = { x: 0, y: 206, w: 100, h: 100 }
    const moving = { x: 500, y: 104, w: 50, h: 100 }
    const r = snapMove(moving, [near, nearer], 6)
    expect(r).toMatchObject({ dx: 0, dy: 2 })
    expect(r.guides).toEqual([{ axis: 'y', at: 206, from: 0, to: 550 }])
    expect(snapMove({ ...moving, y: 107 }, [near], 6)).toEqual({ dx: 0, dy: 0, guides: [] })
  })
})
