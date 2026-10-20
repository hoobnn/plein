import { connect, createElement, exportElements, type PleinDoc } from '@plein/doc'
import { box, node, openDoc } from '@plein/doc/testing'
import type { Application, Container } from 'pixi.js'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { Engine } from './engine'
import type { HighlightLayer } from './highlight'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function setup() {
  const doc = openDoc()
  const a = createElement(doc, node({ x: 400, y: 300 }))
  const b = createElement(doc, node({ x: 200, y: 600 }))
  connect(doc, [a, 'out'], [b, 'in'])
  const frame = createElement(doc, box({ kind: 'frame', x: 900, y: 100, w: 300, h: 300 }))
  createElement(doc, box({ parentId: frame, x: 20, y: 50 }))
  doc.flush()
  doc.undo.clear()
  // 不 init GPU/DOM 输入；被测公开命令、Scene 和文档写入均使用真实实现。
  const engine = new Engine({ host: {} as HTMLElement, doc })
  const { app, world, highlight } = engine as unknown as {
    app: Application
    world: Container
    highlight: HighlightLayer
  }
  // Application 插件从未 init，不能走已初始化的销毁生命周期；仅隔离该实例的 GPU 清理。
  // Engine.destroy、全部被测命令及 doc 写路径保持真实，本测试不验证 GPU init/destroy。
  const appDestroy = vi.spyOn(app, 'destroy').mockImplementation(() => {})
  cleanups.push(() => {
    engine.destroy()
    app.stage.destroy({ children: true })
    world.destroy({ children: true })
    highlight.destroy()
    appDestroy.mockRestore()
    doc.destroy()
  })
  engine.selection.set([a, b])
  return { doc, engine, a, b, frame, clipboard: exportElements(doc, [a]) }
}

function snapshot(doc: PleinDoc) {
  return {
    document: JSON.parse(JSON.stringify(doc.ydoc.toJSON())),
    elements: JSON.parse(JSON.stringify([...doc.elements()])),
    edges: JSON.parse(JSON.stringify([...doc.edges()])),
    undo: [...doc.undo.undoStack],
    redo: [...doc.undo.redoStack],
  }
}

function expectUnchanged(doc: PleinDoc, before: ReturnType<typeof snapshot>) {
  expect(doc.ydoc.toJSON()).toEqual(before.document)
  expect([...doc.elements()]).toEqual(before.elements)
  expect([...doc.edges()]).toEqual(before.edges)
  expect(doc.undo.undoStack).toEqual(before.undo)
  expect(doc.undo.redoStack).toEqual(before.redo)
}

type Fixture = ReturnType<typeof setup>
const writes: Array<[string, (fixture: Fixture) => unknown]> = [
  ['undo', ({ engine }) => engine.undo()],
  ['redo', ({ engine }) => engine.redo()],
  ['deleteSelection', ({ engine }) => engine.deleteSelection()],
  ['duplicateSelection', ({ engine }) => engine.duplicateSelection()],
  ['nudge', ({ engine }) => engine.nudge(5, -9)],
  ['groupSelection', ({ engine }) => engine.groupSelection()],
  [
    'ungroupSelection',
    ({ engine, frame }) => {
      engine.selection.set([frame])
      engine.ungroupSelection()
    },
  ],
  ['arrange', ({ engine }) => expect(engine.arrange()).toBeNull()],
  ['bringToFront', ({ engine }) => engine.bringToFront()],
  ['sendToBack', ({ engine }) => engine.sendToBack()],
  ['paste', ({ engine, clipboard }) => engine.paste(clipboard)],
]

describe('Engine 公开命令的只读边界', () => {
  it.each(writes)('%s 不写真实 Y.Doc、不消费或清空两侧历史栈', (_name, command) => {
    const fixture = setup()
    const { doc, engine } = fixture
    // 留下一步可撤销、一部可重做，避免把空栈的无操作误判为权限保护。
    engine.nudge(20, 0)
    doc.undo.stopCapturing()
    engine.nudge(0, 30)
    doc.undo.stopCapturing()
    engine.undo()
    doc.flush()
    expect(doc.undo.undoStack).toHaveLength(1)
    expect(doc.undo.redoStack).toHaveLength(1)
    doc.readOnly = true
    engine.refreshState()
    expect(engine.state).toMatchObject({ canUndo: false, canRedo: false })
    const before = snapshot(doc)
    let updates = 0
    doc.ydoc.on('update', () => updates++)
    expect(() => command(fixture)).not.toThrow()
    doc.flush()
    expectUnchanged(doc, before)
    expect(updates).toBe(0)
    expect(doc.undo.canUndo()).toBe(true)
    expect(doc.undo.canRedo()).toBe(true)
  })

  it('恢复可写后沿原历史继续撤销/重做，不丢修改也不破坏 redo', () => {
    const { doc, engine, a, b } = setup()
    engine.nudge(20, 0)
    doc.undo.stopCapturing()
    engine.nudge(0, 30)
    doc.undo.stopCapturing()
    engine.undo()
    expect(doc.get(a)).toMatchObject({ x: 420, y: 300 })
    expect(doc.get(b)).toMatchObject({ x: 220, y: 600 })
    expect(engine.state).toMatchObject({ canUndo: true, canRedo: true })
    const observed: Array<{ canUndo: boolean; canRedo: boolean }> = []
    const off = engine.onStateChange(() => {
      const { canUndo, canRedo } = engine.state
      observed.push({ canUndo, canRedo })
    })
    doc.readOnly = true
    engine.refreshState()
    const before = snapshot(doc)
    engine.undo()
    engine.redo()
    expectUnchanged(doc, before)
    doc.readOnly = false
    engine.refreshState()
    off()
    expect(observed).toEqual([
      { canUndo: false, canRedo: false },
      { canUndo: true, canRedo: true },
    ])
    engine.redo()
    expect(doc.get(a)).toMatchObject({ x: 420, y: 330 })
    expect(doc.get(b)).toMatchObject({ x: 220, y: 630 })
    expect(engine.state).toMatchObject({ canUndo: true, canRedo: false })
    engine.undo()
    engine.undo()
    expect(doc.get(a)).toMatchObject({ x: 400, y: 300 })
    expect(doc.get(b)).toMatchObject({ x: 200, y: 600 })
    expect(engine.state).toMatchObject({ canUndo: false, canRedo: true })
    engine.redo()
    engine.redo()
    expect(doc.get(a)).toMatchObject({ x: 420, y: 330 })
    expect(doc.get(b)).toMatchObject({ x: 220, y: 630 })
  })

  it('整理结果的旧 revert 闭包不能绕过后来生效的只读，可写后仍可恢复原布局', () => {
    const { doc, engine, a, b } = setup()
    const positions = () =>
      [a, b].map((id) => {
        const { x, y, w, h } = doc.get(id)!
        return { x, y, w, h }
      })
    const original = positions()
    const result = engine.arrange([a, b])
    expect(result).not.toBeNull()
    expect(result!.count).toBeGreaterThan(0)
    expect(result!.scope).toBe('selection')
    expect(positions()).not.toEqual(original)
    expect(doc.undo.undoStack).toHaveLength(1)
    expect(result!.stale()).toBe(false)
    const arranged = positions()
    doc.readOnly = true
    const before = snapshot(doc)
    expect(result!.revert()).toBe(false)
    expectUnchanged(doc, before)
    expect(result!.stale()).toBe(false)
    doc.readOnly = false
    expect(result!.revert()).toBe(true)
    expect(positions()).toEqual(original)
    expect(result!.stale()).toBe(true)
    expect(result!.revert()).toBe(false)
    engine.redo()
    expect(positions()).toEqual(arranged)
  })
})
