import { createElement } from '@plein/doc'
import { node, openDoc } from '@plein/doc/testing'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { initEngine, pointerEvent } from './testing'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

async function setup() {
  const doc = openDoc()
  const first = createElement(doc, node({ x: 400, y: 200 }))
  const other = createElement(doc, node({ x: 700, y: 200 }))
  doc.flush()
  doc.undo.clear()
  const { engine, host, cleanup } = await initEngine(doc)
  cleanups.push(() => doc.destroy(), cleanup)
  engine.zoomToFit([first, other])
  engine.selection.set([first])
  return { doc, engine, host, first }
}

describe('拖动松手前的外部修改校验', () => {
  it.each([
    ['x', 777],
    ['locked', true],
  ] as const)('同一事件中外部修改 %s 后松手，不等待下一帧也不能写回旧预览', async (key, value) => {
    const { doc, engine, host, first } = await setup()
    const before = doc.worldRect(first)!
    const at = engine.camera.worldToScreen(before.x + before.w / 2, before.y + before.h / 2)
    host.dispatchEvent(pointerEvent('pointerdown', { clientX: at.x, clientY: at.y }))
    for (const step of [1, 2, 3, 4])
      host.dispatchEvent(
        pointerEvent('pointermove', { clientX: at.x + 17.5 * step, clientY: at.y - 15 * step }),
      )
    // 预览已移动，文档仍在原位
    expect(engine.scene.rect(first)).not.toEqual(before)
    expect(doc.worldRect(first)).toEqual(before)
    const undoDepth = doc.undo.undoStack.length
    // 外部写入与松手在同一个任务里，期间没有帧去派发变更
    doc.ydoc.transact(() => doc.mutable(first)!.set(key, value), 'external-race')
    host.dispatchEvent(pointerEvent('pointerup', { clientX: 900, clientY: 400 }))
    expect(doc.worldRect(first)).toEqual(key === 'x' ? { ...before, x: 777 } : before)
    expect(doc.get(first)!.locked).toBe(key === 'locked')
    expect(doc.undo.undoStack).toHaveLength(undoDepth)
    expect(engine.scene.rect(first)).toEqual(doc.worldRect(first))
  })
})
