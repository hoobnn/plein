import { describe, expect, it } from 'vite-plus/test'
import * as Y from 'yjs'
import { createDoc, createElement, removeResultsWithReceipt, restoreRemovedResults } from './index'

/**
 * 「撤销本次删除」不能靠全局撤销栈。
 *
 * 远端把节点整个删掉之后，栈里那一步已经失效；Yjs 会跳过它去撤更早的
 * 操作，把别的编辑撤掉。凭据让撤销只动这次删掉的那几条。
 */

const video = (id: string) => ({
  id,
  port: 'video',
  value: { type: 'video' as const, assetId: `a-${id}` },
  runId: 'run',
  at: 1,
})

describe('删除的撤销凭据', () => {
  it('远端删掉来源节点后，撤销本次删除不会撤掉别的编辑', () => {
    const doc = createDoc(undefined, { schedule: () => {} })
    const source = createElement(doc, { kind: 'node', x: 0, y: 0, w: 200, h: 200 })
    const other = createElement(doc, { kind: 'node', x: 0, y: 0, w: 200, h: 200 })
    doc.mutable(other)!.set('name', 'old')
    doc.mutable(source)!.set('results', [video('R')])
    doc.flush()

    // 另一个节点的改名
    doc.mutable(other)!.set('name', 'edited')
    doc.undo.stopCapturing()

    // 删除 R
    const { removed, receipt } = removeResultsWithReceipt(doc, [
      { elementId: source, resultId: 'R' },
    ])
    expect(removed).toBe(1)
    expect(receipt).toHaveLength(1)
    doc.undo.stopCapturing()

    // 远端把来源节点整个删掉
    const peer = new Y.Doc()
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc.ydoc))
    peer.getMap('elements').delete(source)
    Y.applyUpdate(doc.ydoc, Y.encodeStateAsUpdate(peer))

    // 撤销本次删除：来源节点没了，这一步无处可放
    const outcome = restoreRemovedResults(doc, receipt)
    expect(outcome.restored).toBe(0)
    expect(outcome.skipped).toEqual([source])
    // 别的编辑没有被撤掉
    expect(doc.get(other)!.name).toBe('edited')
    doc.destroy()
  })

  it('来源仍在时，撤销本次删除只还原删掉的候选', () => {
    const doc = createDoc(undefined, { schedule: () => {} })
    const source = createElement(doc, { kind: 'node', x: 0, y: 0, w: 200, h: 200 })
    const other = createElement(doc, { kind: 'node', x: 0, y: 0, w: 200, h: 200 })
    doc.mutable(other)!.set('name', 'old')
    doc.mutable(source)!.set('results', [video('R'), video('Q')])
    doc.flush()

    doc.mutable(other)!.set('name', 'edited')
    doc.undo.stopCapturing()

    const { removed, receipt } = removeResultsWithReceipt(doc, [
      { elementId: source, resultId: 'R' },
    ])
    expect(removed).toBe(1)
    expect(doc.get(source)!.results!.map((r) => r.id)).toEqual(['Q'])

    const outcome = restoreRemovedResults(doc, receipt)
    expect(outcome.restored).toBe(1)
    expect(outcome.skipped).toEqual([])
    expect(doc.get(source)!.results!.map((r) => r.id)).toEqual(['R', 'Q'])
    // 别的编辑没有被撤掉
    expect(doc.get(other)!.name).toBe('edited')
    doc.destroy()
  })

  it('多个来源部分失效时，只还原还有效的那部分', () => {
    const doc = createDoc(undefined, { schedule: () => {} })
    const alive = createElement(doc, { kind: 'node', x: 0, y: 0, w: 200, h: 200 })
    const gone = createElement(doc, { kind: 'node', x: 0, y: 0, w: 200, h: 200 })
    doc.mutable(alive)!.set('results', [video('A')])
    doc.mutable(gone)!.set('results', [video('B')])
    doc.flush()

    const { receipt } = removeResultsWithReceipt(doc, [
      { elementId: alive, resultId: 'A' },
      { elementId: gone, resultId: 'B' },
    ])
    expect(receipt).toHaveLength(2)

    // 远端删掉其中一个来源
    const peer = new Y.Doc()
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc.ydoc))
    peer.getMap('elements').delete(gone)
    Y.applyUpdate(doc.ydoc, Y.encodeStateAsUpdate(peer))

    const outcome = restoreRemovedResults(doc, receipt)
    expect(outcome.restored).toBe(1)
    expect(outcome.skipped).toEqual([gone])
    expect(doc.get(alive)!.results!.map((r) => r.id)).toEqual(['A'])
    doc.destroy()
  })

  it('删除后采用状态回到未采用，撤销后恢复', () => {
    const doc = createDoc(undefined, { schedule: () => {} })
    const source = createElement(doc, { kind: 'node', x: 0, y: 0, w: 200, h: 200 })
    doc.mutable(source)!.set('results', [video('R')])
    doc.mutable(source)!.set('adopted', 'R')
    doc.flush()

    const { receipt } = removeResultsWithReceipt(doc, [{ elementId: source, resultId: 'R' }])
    expect(doc.get(source)!.adopted).toBeNull()
    restoreRemovedResults(doc, receipt)
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
