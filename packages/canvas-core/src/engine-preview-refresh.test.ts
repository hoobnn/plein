import { createElement, updateElement, type PleinDoc } from '@plein/doc'
import { box, node, openDoc } from '@plein/doc/testing'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import type { ViewChange } from './engine'
import type { Transient } from './scene'
import { initEngine } from './testing'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

async function setup(build: (doc: PleinDoc) => void) {
  const doc = openDoc()
  build(doc)
  doc.flush()
  const fixture = await initEngine(doc)
  cleanups.push(() => doc.destroy(), fixture.cleanup)
  fixture.tick(1000)
  const changes: ViewChange[] = []
  const move = vi.fn()
  fixture.engine.onViewChange((change) => changes.push(change))
  fixture.engine.onMove(move)
  const preview = (patches: Map<string, Transient>) =>
    (fixture.engine as unknown as { preview(p: Map<string, Transient>): void }).preview(patches)
  return { doc, ...fixture, changes, move, preview }
}

describe('预览几何与覆盖层内容失效', () => {
  it('同帧多次预览只通知一次几何更新，后代跟随但不改文档，清除后恢复', async () => {
    let frame = '',
      child = ''
    const { doc, engine, tick, changes, move, preview } = await setup((doc) => {
      frame = createElement(doc, box({ kind: 'frame', w: 500, h: 500 }))
      child = createElement(doc, node({ parentId: frame, x: 100, y: 120 }))
    })
    const before = doc.worldRect(child)
    preview(new Map([[frame, { x: 20, y: 30 }]]))
    preview(new Map([[frame, { x: 60, y: 80 }]]))
    tick(1016)
    expect(changes).toEqual([{ content: false }])
    expect(move).toHaveBeenCalledTimes(1)
    expect(engine.scene.rect(child)).toEqual({ ...before, x: 160, y: 200 })
    expect(doc.worldRect(child)).toEqual(before)

    preview(new Map())
    tick(1032)
    expect(changes).toEqual([{ content: false }, { content: false }])
    expect(engine.scene.rect(child)).toEqual(before)
    tick(1048)
    expect(changes).toHaveLength(2)
    expect(move).toHaveBeenCalledTimes(2)
  })

  it('预览期间文档内容变化仍通知内容失效，之后的纯预览重新复用内容', async () => {
    let id = ''
    const { doc, tick, changes, preview } = await setup((doc) => {
      id = createElement(doc, node({ x: 100, y: 100 }))
    })
    updateElement(doc, id, { name: '新名称' })
    doc.flush()
    preview(new Map([[id, { x: 120, y: 130 }]]))
    tick(1016)
    expect(changes).toEqual([{ content: true }])
    preview(new Map([[id, { x: 150, y: 160, w: 240, h: 180 }]]))
    tick(1032)
    expect(changes.at(-1)).toEqual({ content: false })
  })
})
