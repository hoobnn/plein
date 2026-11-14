import { describe, expect, it } from 'vite-plus/test'
import * as Y from 'yjs'
import { addResults, createDoc, createElement, MAX_RESULTS, removeResults } from './index'
import { LEGACY_RESULTS_KEY, RESULTS_KEY } from './results'

/**
 * 结果数组在文档内部是 Y.Array，逐条插删。
 * 这里守住几条不能退化的行为：
 * - 裁掉旧候选时索引不能算错（新增的候选插在最前）；
 * - 旧格式（普通数组）的数据不能被新键遮掉；
 * - 旧端迟到的写入不能盖掉新生成的候选。
 */

const image = (id: string, runId = `run-${id}`) => ({
  id,
  port: 'images',
  value: { type: 'image' as const, assetId: `a-${id}` },
  runId,
  at: 1,
})

describe('结果容器', () => {
  it('裁掉最旧的候选时按正确位置删除，不误删保留的候选', () => {
    const doc = createDoc(undefined, { schedule: () => {} })
    const id = createElement(doc, { kind: 'node', x: 0, y: 0, w: 200, h: 200 })
    const batch = (from: number, n: number) =>
      Array.from({ length: n }, (_, i) => image(`r${from + i}`, `run${from}`))
    addResults(doc, id, batch(0, MAX_RESULTS))
    addResults(doc, id, batch(MAX_RESULTS, 2))
    const ids = doc.get(id)!.results!.map((r) => r.id)
    expect(ids).toHaveLength(MAX_RESULTS)
    // 新加的两条在最前，最旧的两条被裁掉；其余原样保留。
    expect(ids.slice(0, 3)).toEqual([`r${MAX_RESULTS}`, `r${MAX_RESULTS + 1}`, 'r0'])
    expect(ids).not.toContain(`r${MAX_RESULTS - 1}`)
    expect(ids).not.toContain(`r${MAX_RESULTS - 2}`)
    expect(ids).toContain('r1')
    doc.destroy()
  })

  it('旧格式节点的旧候选不会因新容器建立而消失', () => {
    const doc = createDoc(undefined, { schedule: () => {} })
    const id = createElement(doc, { kind: 'node', x: 0, y: 0, w: 200, h: 200 })
    // 旧客户端写的是普通数组，放在旧键上
    const legacy = doc.mutable(id)!
    legacy.set(LEGACY_RESULTS_KEY, [image('old-a'), image('old-b')])
    doc.flush()
    expect(doc.get(id)!.results!.map((r) => r.id)).toEqual(['old-a', 'old-b'])

    // 新端追加一条候选
    addResults(doc, id, [image('new-c')])
    const ids = doc.get(id)!.results!.map((r) => r.id)
    expect(ids).toEqual(['new-c', 'old-a', 'old-b'])
    doc.destroy()
  })

  it('旧端迟到的写入不会盖掉新生成的候选', () => {
    const doc = createDoc(undefined, { schedule: () => {} })
    const id = createElement(doc, { kind: 'node', x: 0, y: 0, w: 200, h: 200 })
    addResults(doc, id, [image('new-s')])
    doc.flush()
    const bytes = Y.encodeStateAsUpdate(doc.ydoc)

    // 旧端离线期间用旧键写了普通数组，重连后一起同步
    const peer = new Y.Doc()
    Y.applyUpdate(peer, bytes)
    peer
      .getMap<Y.Map<unknown>>('elements')
      .get(id)!
      .set(LEGACY_RESULTS_KEY, [image('old-q')])
    Y.applyUpdate(doc.ydoc, Y.encodeStateAsUpdate(peer))

    // 新端读到的是新键的内容：新候选没丢
    expect(doc.get(id)!.results!.map((r) => r.id)).toEqual(['new-s'])
    // 旧端的写入仍在文档里，可核对
    const m = doc.mutable(id)!
    expect(m.get(LEGACY_RESULTS_KEY)).toEqual([image('old-q')])
    expect(m.get(RESULTS_KEY)).toBeInstanceOf(Y.Array)
    doc.destroy()
  })
  it('旧格式节点上的删除可撤销，且容器创建不进撤销栈', () => {
    const doc = createDoc(undefined, { schedule: () => {} })
    const id = createElement(doc, { kind: 'node', x: 0, y: 0, w: 200, h: 200 })
    doc.mutable(id)!.set(LEGACY_RESULTS_KEY, [image('old-a'), image('old-b')])
    doc.flush()
    doc.undo.clear()
    expect(removeResults(doc, [{ elementId: id, resultId: 'old-a' }])).toBe(1)
    expect(doc.get(id)!.results!.map((r) => r.id)).toEqual(['old-b'])
    doc.undo.undo()
    expect(doc.get(id)!.results!.map((r) => r.id)).toEqual(['old-a', 'old-b'])
    doc.destroy()
  })

  it('删除不存在的记录返回 0，也不留下容器痕迹', () => {
    const doc = createDoc(undefined, { schedule: () => {} })
    const id = createElement(doc, { kind: 'node', x: 0, y: 0, w: 200, h: 200 })
    expect(removeResults(doc, [{ elementId: id, resultId: 'nope' }])).toBe(0)
    // 节点本来就没有候选，快照里也不该出现 results
    expect(doc.get(id)!.results).toBeUndefined()
    doc.destroy()
  })

  it('用户删空后旧端迟到的写入不会让候选复活', () => {
    const doc = createDoc(undefined, { schedule: () => {} })
    const id = createElement(doc, { kind: 'node', x: 0, y: 0, w: 200, h: 200 })
    // 旧端（v11）留下的候选
    doc.mutable(id)!.set(LEGACY_RESULTS_KEY, [image('R'), image('Q')])
    doc.flush()
    // 新端接管并明确删光
    expect(
      removeResults(doc, [
        { elementId: id, resultId: 'R' },
        { elementId: id, resultId: 'Q' },
      ]),
    ).toBe(2)
    expect(doc.get(id)!.results).toEqual([])

    // 旧离线端仍按 v11 从 [R,Q] 只删 Q，同步过来
    const peer = new Y.Doc()
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc.ydoc))
    const peerEl = peer.getMap<Y.Map<unknown>>('elements').get(id)!
    peerEl.set(LEGACY_RESULTS_KEY, [image('R')])
    Y.applyUpdate(doc.ydoc, Y.encodeStateAsUpdate(peer))

    // 用户删掉的 R 没有复活
    expect(doc.get(id)!.results).toEqual([])
    // 旧端那一份仍在文档里，可核对
    expect(doc.mutable(id)!.get(LEGACY_RESULTS_KEY)).toEqual([image('R')])
    doc.destroy()
  })

  it('两个客户端各自给同一节点加候选，两条都留着', () => {
    const a = createDoc(undefined, { schedule: () => {} })
    const id = createElement(a, { kind: 'node', x: 0, y: 0, w: 200, h: 200 })
    a.flush()
    // B 是 A 的副本
    const b = createDoc(undefined, { schedule: () => {} })
    Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc))

    // 两边各自加一条候选
    addResults(a, id, [image('snap-a')])
    addResults(b, id, [image('snap-b')])
    // 交换增量
    Y.applyUpdate(a.ydoc, Y.encodeStateAsUpdate(b.ydoc))
    Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc))

    const idsA = a.get(id)!.results!.map((r) => r.id)
    const idsB = b.get(id)!.results!.map((r) => r.id)
    expect(idsA.sort()).toEqual(['snap-a', 'snap-b'])
    expect(idsB.sort()).toEqual(['snap-a', 'snap-b'])
    a.destroy()
    b.destroy()
  })

  it('已有候选的节点并发追加，两条都留着', () => {
    const a = createDoc(undefined, { schedule: () => {} })
    const id = createElement(a, { kind: 'node', x: 0, y: 0, w: 200, h: 200 })
    addResults(a, id, [image('existing')])
    a.flush()
    const b = createDoc(undefined, { schedule: () => {} })
    Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc))

    addResults(a, id, [image('snap-a')])
    addResults(b, id, [image('snap-b')])
    Y.applyUpdate(a.ydoc, Y.encodeStateAsUpdate(b.ydoc))
    Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc))

    const idsA = a.get(id)!.results!.map((r) => r.id)
    const idsB = b.get(id)!.results!.map((r) => r.id)
    expect(idsA.sort()).toEqual(['existing', 'snap-a', 'snap-b'])
    expect(idsB.sort()).toEqual(['existing', 'snap-a', 'snap-b'])
    a.destroy()
    b.destroy()
  })
})
