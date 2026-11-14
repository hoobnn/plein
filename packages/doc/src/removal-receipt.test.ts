import { describe, expect, it } from 'vite-plus/test'
import * as Y from 'yjs'
import {
  createDoc,
  createElement,
  removeResultsWithReceipt,
  resultsContainer,
  undoResultRemoval,
  updateElement,
  setResults,
} from './index'

/**
 * 「撤销本次删除」不能靠全局撤销栈。
 *
 * 远端把节点整个删掉之后，栈里那一步已经失效；Yjs 会跳过它去撤更早的
 * 操作，把别的编辑撤掉。撤销前要核对这一步还撤得回来。
 */

const video = (id: string) => ({
  id,
  port: 'video',
  value: { type: 'video' as const, assetId: `a-${id}` },
  runId: 'run',
  at: 1,
})

const ids = (results: Y.Array<unknown>) => results.toArray().map((r) => (r as { id: string }).id)

describe('删除的撤销凭据', () => {
  it('还原按相对位置，顺序正确，并且能重做', () => {
    const doc = createDoc(undefined, { schedule: () => {} })
    const source = createElement(doc, { kind: 'node', x: 0, y: 0, w: 200, h: 200 })
    const results = resultsContainer(doc.mutable(source)!)!
    results.insert(0, [video('A'), video('B'), video('C'), video('D')])
    doc.flush()

    // 删 A、B
    const { removed, receipt } = removeResultsWithReceipt(doc, [
      { elementId: source, resultId: 'A' },
      { elementId: source, resultId: 'B' },
    ])
    expect(removed).toBe(2)
    doc.undo.stopCapturing()

    // 期间系统加入 S
    results.insert(0, [video('S')])
    expect(ids(results)).toEqual(['S', 'C', 'D'])

    const outcome = undoResultRemoval(doc, receipt)
    expect(outcome.undone).toBe(true)
    // 还原按相对位置：S 仍在最前
    expect(ids(results)).toEqual(['S', 'A', 'B', 'C', 'D'])
    // 撤销之后还能重做
    expect(doc.undo.redoStack.length).toBe(1)
    doc.undo.redo()
    expect(ids(results)).toEqual(['S', 'C', 'D'])
    doc.destroy()
  })

  it('远端删掉来源节点后，撤销本次删除不会撤掉别的编辑', () => {
    const doc = createDoc(undefined, { schedule: () => {} })
    const source = createElement(doc, { kind: 'node', x: 0, y: 0, w: 200, h: 200 })
    const other = createElement(doc, { kind: 'node', x: 0, y: 0, w: 200, h: 200 })
    doc.mutable(other)!.set('name', 'old')
    setResults(doc, source, [video('R')])
    doc.flush()

    // 另一个节点的改名（可撤销的本地命令）
    updateElement(doc, other, { name: 'edited' })
    doc.undo.stopCapturing()

    // 删除 R
    const { removed, receipt } = removeResultsWithReceipt(doc, [
      { elementId: source, resultId: 'R' },
    ])
    expect(removed).toBe(1)
    doc.undo.stopCapturing()

    // 远端把来源节点整个删掉
    const peer = new Y.Doc()
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc.ydoc))
    peer.getMap('elements').delete(source)
    Y.applyUpdate(doc.ydoc, Y.encodeStateAsUpdate(peer))

    const outcome = undoResultRemoval(doc, receipt)
    expect(outcome.undone).toBe(false)
    expect(outcome.reason).toContain('撤不回来')
    // 别的编辑没有被撤掉，也没有动全局撤销栈
    expect(doc.get(other)!.name).toBe('edited')
    expect(doc.undo.undoStack.length).toBe(2)
    doc.destroy()
  })

  it('多个来源部分失效时，只还原还有效的那部分', () => {
    const doc = createDoc(undefined, { schedule: () => {} })
    const alive = createElement(doc, { kind: 'node', x: 0, y: 0, w: 200, h: 200 })
    const gone = createElement(doc, { kind: 'node', x: 0, y: 0, w: 200, h: 200 })
    setResults(doc, alive, [video('A')])
    setResults(doc, gone, [video('B')])
    doc.flush()

    const { receipt } = removeResultsWithReceipt(doc, [
      { elementId: alive, resultId: 'A' },
      { elementId: gone, resultId: 'B' },
    ])
    expect(receipt).toHaveLength(2)
    doc.undo.stopCapturing()

    // 远端删掉其中一个来源
    const peer = new Y.Doc()
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc.ydoc))
    peer.getMap('elements').delete(gone)
    Y.applyUpdate(doc.ydoc, Y.encodeStateAsUpdate(peer))

    const outcome = undoResultRemoval(doc, receipt)
    expect(outcome.undone).toBe(true)
    expect(doc.get(alive)!.results!.map((r) => r.id)).toEqual(['A'])
    doc.destroy()
  })

  it('删除之后有别的本地操作时，不动那一步', () => {
    const doc = createDoc(undefined, { schedule: () => {} })
    const source = createElement(doc, { kind: 'node', x: 0, y: 0, w: 200, h: 200 })
    const other = createElement(doc, { kind: 'node', x: 0, y: 0, w: 200, h: 200 })
    setResults(doc, source, [video('R')])
    doc.flush()

    const { receipt } = removeResultsWithReceipt(doc, [{ elementId: source, resultId: 'R' }])
    doc.undo.stopCapturing()
    // 之后又改了一处（可撤销的本地命令）
    updateElement(doc, other, { name: 'edited' })
    doc.undo.stopCapturing()

    const outcome = undoResultRemoval(doc, receipt)
    expect(outcome.undone).toBe(false)
    expect(outcome.reason).toContain('已有其他操作')
    // 别的编辑没被撤，删除也没被撤
    expect(doc.get(other)!.name).toBe('edited')
    expect(doc.get(source)!.results).toEqual([])
    doc.destroy()
  })

  it('删除后采用状态回到未采用，撤销后恢复', () => {
    const doc = createDoc(undefined, { schedule: () => {} })
    const source = createElement(doc, { kind: 'node', x: 0, y: 0, w: 200, h: 200 })
    setResults(doc, source, [video('R')])
    doc.mutable(source)!.set('adopted', 'R')
    doc.flush()

    const { receipt } = removeResultsWithReceipt(doc, [{ elementId: source, resultId: 'R' }])
    expect(doc.get(source)!.adopted).toBeNull()
    const outcome = undoResultRemoval(doc, receipt)
    expect(outcome.undone).toBe(true)
    expect(doc.get(source)!.adopted).toBe('R')
    doc.destroy()
  })

  it('不存在的记录不留下凭据', () => {
    const doc = createDoc(undefined, { schedule: () => {} })
    const source = createElement(doc, { kind: 'node', x: 0, y: 0, w: 200, h: 200 })
    const outcome = removeResultsWithReceipt(doc, [{ elementId: source, resultId: 'nope' }])
    expect(outcome.removed).toBe(0)
    expect(outcome.receipt).toEqual([])
    doc.destroy()
  })
})
