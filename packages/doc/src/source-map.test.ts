import * as Y from 'yjs'
import { describe, expect, it } from 'vite-plus/test'
import {
  connect,
  createElement,
  deleteElements,
  ReadOnlyDocError,
  setParam,
  setText,
} from './commands'
import { openDoc, node } from './testing'
import { createDoc } from './doc'
import {
  addAdaptationProposal,
  addSourceUnit,
  captureSourceSnapshot,
  copySourceMap,
  createSourceMap,
  listSourceInputs,
  markSourceRead,
  readSourceSlice,
  setSourceLink,
  setUnitDisposition,
  sourceLinkState,
  sourceMapContentSnapshot,
  sourceMapOf,
  sourceSnapshotState,
} from './source-map'
import { SCHEMA_VERSION } from './migrate'
import { exportElements, importElements } from './clipboard'
import {
  confirmProductionContent,
  currentProductionConfirmation,
  productionContentSnapshot,
  productionMapOf,
} from './production'

const shots = [
  {
    id: 'one',
    description: '她回头',
    dialogue: [{ id: 'line-a', character: '甲', line: '回来。' }],
  },
  {
    id: 'two',
    description: '他回头',
    dialogue: [{ id: 'line-b', character: '乙', line: '回来。' }],
  },
]
function fixture(text = '甲：回来。\n乙：回来。\n😀她没有回头。') {
  const doc = openDoc()
  const board = createElement(
    doc,
    node({
      nodeType: 'plein/storyboard',
      ports: {
        inputs: [{ id: 'script', label: '剧本', type: 'text', multiple: true }],
        outputs: [],
      },
      params: { shots },
    }),
  )
  const production = doc.elementMaps.get(board)!.get('production') as Y.Map<unknown>
  if (!production.has('sourceMap')) production.set('sourceMap', createSourceMap())
  const source = createElement(doc, {
    kind: 'markdown',
    x: 0,
    y: 0,
    w: 200,
    h: 200,
    text,
    name: '剧本',
  })
  connect(doc, [source, 'text'], [board, 'script'])
  doc.undo.clear()
  return { doc, board, source }
}
const capture = (f: ReturnType<typeof fixture>) => {
  const input = listSourceInputs(f.doc, f.board)[0]!
  return captureSourceSnapshot(f.doc, f.board, {
    canvasId: 'canvas',
    ...input,
    expectedText: input.text!,
    expectedResultId: input.resultId,
  })!
}

describe('固定原文与人工覆盖', () => {
  it('两端首次同时固定同一来源只形成一个active指针，所有版本保留且后续可推进', () => {
    const f = fixture()
    const raw = new Y.Doc()
    Y.applyUpdate(raw, Y.encodeStateAsUpdate(f.doc.ydoc))
    const peer = openDoc(raw)
    const first = capture(f)
    const second = capture({ ...f, doc: peer })
    expect(first).not.toBe(second)
    Y.applyUpdate(f.doc.ydoc, Y.encodeStateAsUpdate(raw))
    Y.applyUpdate(raw, Y.encodeStateAsUpdate(f.doc.ydoc))
    const merged = sourceMapOf(f.doc, f.board)
    expect(merged.sources).toHaveLength(1)
    expect(merged.snapshots).toHaveLength(2)
    expect(sourceMapOf(peer, f.board)).toEqual(merged)
    setText(f.doc, f.source, '修订后的原文')
    const third = capture(f)
    expect(sourceMapOf(f.doc, f.board).sources).toHaveLength(1)
    expect(sourceMapOf(f.doc, f.board).sources[0]!.activeSnapshotId).toBe(third)
    expect(sourceMapOf(f.doc, f.board).snapshots).toHaveLength(3)
    peer.destroy()
    f.doc.destroy()
  })
  it('导入文件中越界或缺版本的标注不被解释成有据映射', () => {
    const f = fixture()
    const snapshotId = capture(f)
    const map = productionMapOf(f.doc, f.board)!.get('sourceMap') as Y.Map<unknown>
    const units = map.get('units') as Y.Map<unknown>
    const links = map.get('links') as Y.Map<unknown>
    units.set('bad', {
      id: 'bad',
      snapshotId,
      start: -2,
      end: 100000,
      kind: 'event',
      disposition: 'in_scope',
      note: '',
    })
    links.set('bad-link', {
      id: 'bad-link',
      unitId: 'bad',
      shotId: 'one',
      treatment: 'retain',
      targetSnapshot: '',
    })
    expect(sourceMapOf(f.doc, f.board).units).toEqual([])
    expect(sourceMapOf(f.doc, f.board).links).toEqual([])
    f.doc.destroy()
  })
  it('固定版本和映射进入精确内容确认；已读不使确认过期；副本不继承原确认', () => {
    const f = fixture()
    const confirm = () =>
      confirmProductionContent(f.doc, {
        scope: { canvasId: 'canvas', boardId: f.board },
        expectedSnapshot: productionContentSnapshot(f.doc.get(f.board))!,
        version: 'v1',
        userId: 'alice',
      })
    confirm()
    const snapshotId = capture(f)
    expect(currentProductionConfirmation(f.doc.get(f.board), 'canvas')).toBeUndefined()
    confirm()
    markSourceRead(f.doc, f.board, snapshotId)
    expect(currentProductionConfirmation(f.doc.get(f.board), 'canvas')).toBeTruthy()
    const unitId = addSourceUnit(f.doc, f.board, { snapshotId, start: 0, end: 5, kind: 'event' })!
    expect(currentProductionConfirmation(f.doc.get(f.board), 'canvas')).toBeUndefined()
    setSourceLink(f.doc, f.board, { unitId, shotId: 'one', treatment: 'retain' })
    setSourceLink(f.doc, f.board, {
      unitId,
      shotId: 'one',
      dialogueId: 'line-a',
      treatment: 'retain',
    })
    addAdaptationProposal(f.doc, f.board, ['one'], '等待动作提案')
    confirm()
    let ids: ReadonlyMap<string, string> = new Map()
    importElements(f.doc, exportElements(f.doc, [f.source, f.board]), {
      dx: 300,
      dy: 300,
      canvasId: 'canvas',
      onImport: (map) => {
        ids = map
      },
    })
    const copied = f.doc.get(ids.get(f.board)!)!
    expect(copied.production!.sourceMap!.sources[0]!.binding!.elementId).toBe(ids.get(f.source))
    expect(copied.production!.sourceMap!.snapshots[0]!.originAtCapture.elementId).toBe(f.source)
    expect(copied.production!.confirmations.every((c) => c.historical)).toBe(true)
    expect(currentProductionConfirmation(copied, 'canvas')).toBeUndefined()
    let partial: ReadonlyMap<string, string> = new Map()
    importElements(f.doc, exportElements(f.doc, [f.board]), {
      dx: 600,
      dy: 600,
      canvasId: 'canvas',
      onImport: (map) => {
        partial = map
      },
    })
    expect(sourceMapOf(f.doc, partial.get(f.board)!).sources[0]!.binding).toBeNull()
    f.doc.destroy()
  })

  it('schema8旧文档只预建空子Map，不猜测原文或历史映射', () => {
    const f = fixture()
    productionMapOf(f.doc, f.board)!.delete('sourceMap')
    f.doc.meta.set('schemaVersion', 8)
    const upgraded = openDoc(f.doc.ydoc)
    expect(upgraded.schemaVersion).toBe(SCHEMA_VERSION)
    expect(productionMapOf(upgraded, f.board)!.get('sourceMap')).toBeInstanceOf(Y.Map)
    expect(sourceMapOf(upgraded, f.board).sources).toEqual([])
    expect(upgraded.get(f.board)!.production!.confirmations).toEqual([])
    upgraded.destroy()
    f.doc.destroy()
  })
  it('重复对白的不同范围拥有不同身份；同一原文可映射多个镜头和稳定对白', () => {
    const f = fixture('回来。\n回来。')
    const snapshotId = capture(f)
    const first = addSourceUnit(f.doc, f.board, { snapshotId, start: 0, end: 3, kind: 'dialogue' })!
    const second = addSourceUnit(f.doc, f.board, {
      snapshotId,
      start: 4,
      end: 7,
      kind: 'dialogue',
    })!
    expect(first).not.toBe(second)
    setSourceLink(f.doc, f.board, {
      unitId: first,
      shotId: 'one',
      dialogueId: 'line-a',
      treatment: 'retain',
    })
    setSourceLink(f.doc, f.board, {
      unitId: second,
      shotId: 'two',
      dialogueId: 'line-b',
      treatment: 'compress',
    })
    setSourceLink(f.doc, f.board, { unitId: first, shotId: 'two', treatment: 'merge' })
    const record = sourceMapOf(f.doc, f.board)
    expect(record.links.map((l) => l.unitId).sort()).toEqual([first, first, second].sort())
    expect(f.doc.get(f.board)!.params).toEqual({ shots })
    expect(record.readSnapshotIds).toEqual([])
    f.doc.destroy()
  })

  it('原文修改、重排、删除和同名重建保留旧版，新版不自动搬运事件', () => {
    const f = fixture('第一段\n第二段')
    const oldId = capture(f)
    addSourceUnit(f.doc, f.board, { snapshotId: oldId, start: 0, end: 3, kind: 'event' })
    const old = sourceMapOf(f.doc, f.board).snapshots[0]!
    setText(f.doc, f.source, '第二段\n第一段修订')
    expect(sourceSnapshotState(f.doc, f.board, old)).toBe('changed')
    const newId = capture(f)
    expect(newId).not.toBe(oldId)
    expect(sourceMapOf(f.doc, f.board).units.every((u) => u.snapshotId === oldId)).toBe(true)
    expect(old.text).toBe('第一段\n第二段')
    deleteElements(f.doc, [f.source])
    createElement(f.doc, { kind: 'markdown', x: 0, y: 0, w: 1, h: 1, name: '剧本', text: old.text })
    expect(sourceSnapshotState(f.doc, f.board, old)).toBe('missing')
    expect(sourceMapOf(f.doc, f.board).snapshots).toHaveLength(2)
    f.doc.destroy()
  })

  it('多源按实际script连线顺序读取全文及采用结果，不选错输出端口或待采用候选', () => {
    const f = fixture('甲'.repeat(50000))
    const generated = createElement(
      f.doc,
      node({
        name: '另一个剧本',
        ports: { inputs: [], outputs: [{ id: 'script-text', label: '剧本', type: 'text' }] },
        results: [
          {
            id: 'image',
            runId: 'r',
            at: 1,
            port: 'image',
            outputGroup: 'g',
            value: { type: 'image', assetId: 'a' },
          },
          {
            id: 'accepted',
            runId: 'r',
            at: 1,
            port: 'script-text',
            outputGroup: 'g',
            value: { type: 'text', text: '采用版' },
          },
          {
            id: 'other',
            runId: 'r',
            at: 1,
            port: 'script-text',
            outputGroup: 'other',
            value: { type: 'text', text: '另一个候选' },
          },
        ],
        adopted: 'image',
      }),
    )
    connect(f.doc, [generated, 'script-text'], [f.board, 'script'])
    const inputs = listSourceInputs(f.doc, f.board)
    expect(inputs.map((i) => i.elementId)).toEqual([f.source, generated])
    expect(inputs[0]!.text).toHaveLength(50000)
    expect(inputs[1]).toMatchObject({ port: 'script-text', text: '采用版', resultId: 'accepted' })
    f.doc.mutable(generated)!.set('adopted', null)
    expect(listSourceInputs(f.doc, f.board)[1]!.text).toBeUndefined()
    expect(
      captureSourceSnapshot(f.doc, f.board, {
        canvasId: 'c',
        elementId: generated,
        port: 'script-text',
        expectedText: '采用版',
        expectedResultId: 'accepted',
      }),
    ).toBeUndefined()
    f.doc.destroy()
  })

  it('纯文本节点读取当前参数，迟到捕获不能固定用户未看到的修改', () => {
    const f = fixture()
    const source = createElement(
      f.doc,
      node({
        nodeType: 'plein/text',
        ports: { inputs: [], outputs: [{ id: 'text', label: '文本', type: 'text' }] },
        params: { text: '当前' },
        results: [
          { id: 'old', runId: 'r', at: 1, port: 'text', value: { type: 'text', text: '陈旧缓存' } },
        ],
      }),
    )
    connect(f.doc, [source, 'text'], [f.board, 'script'])
    expect(listSourceInputs(f.doc, f.board)[1]!.text).toBe('当前')
    setParam(f.doc, source, 'text', '修订')
    expect(
      captureSourceSnapshot(f.doc, f.board, {
        canvasId: 'c',
        elementId: source,
        port: 'text',
        expectedText: '当前',
      }),
    ).toBeUndefined()
    f.doc.destroy()
  })

  it('全文分页保持CRLF与Unicode，不能划定半个emoji；非法偏移不能生成假范围', () => {
    const f = fixture('甲😀\r\n乙'.repeat(10000))
    const snapshotId = capture(f)
    const snapshot = sourceMapOf(f.doc, f.board).snapshots[0]!
    let text = '',
      offset = 0
    while (offset < snapshot.text.length) {
      const page = readSourceSlice(snapshot, offset, 7)
      text += page.text
      offset = page.end
    }
    expect(text).toBe(snapshot.text)
    for (const [start, end] of [
      [2, 3],
      [0, 2],
      [-1, 3],
      [0, Infinity],
      [3, 3],
    ])
      expect(
        addSourceUnit(f.doc, f.board, { snapshotId, start: start!, end: end!, kind: 'event' }),
      ).toBeUndefined()
    expect(
      addSourceUnit(f.doc, f.board, { snapshotId, start: 1, end: 3, kind: 'event' }),
    ).toBeTruthy()
    expect(readSourceSlice(snapshot, 0, 1e9).text.length).toBeLessThanOrEqual(16001)
    f.doc.destroy()
  })

  it('已读需要显式操作，未映射与有意范围外区分；改编提案无需伪造原文', () => {
    const f = fixture()
    const snapshotId = capture(f)
    const unitId = addSourceUnit(f.doc, f.board, {
      snapshotId,
      start: 0,
      end: 5,
      kind: 'dialogue',
    })!
    const before = sourceMapContentSnapshot(sourceMapOf(f.doc, f.board))
    markSourceRead(f.doc, f.board, snapshotId)
    expect(sourceMapContentSnapshot(sourceMapOf(f.doc, f.board))).toEqual(before)
    expect(sourceMapOf(f.doc, f.board).readSnapshotIds).toEqual([snapshotId])
    setUnitDisposition(f.doc, f.board, unitId, 'out_of_scope')
    expect(
      setSourceLink(f.doc, f.board, { unitId, shotId: 'one', treatment: 'retain' }),
    ).toBeUndefined()
    addAdaptationProposal(f.doc, f.board, ['one'], '新增一个等待的动作，尚待人工决定')
    const record = sourceMapOf(f.doc, f.board)
    expect(record.proposals[0]).not.toHaveProperty('start')
    expect(record.proposals[0]).not.toHaveProperty('unitId')
    expect(sourceMapContentSnapshot(record)).not.toEqual(before)
    f.doc.destroy()
  })

  it('镜头重排不影响身份；内容修订待复核，拆并后删除的镜头不按编号重新映射', () => {
    const f = fixture()
    const unitId = addSourceUnit(f.doc, f.board, {
      snapshotId: capture(f),
      start: 0,
      end: 5,
      kind: 'event',
    })!
    setSourceLink(f.doc, f.board, { unitId, shotId: 'one', treatment: 'retain' })
    const link = sourceMapOf(f.doc, f.board).links[0]!
    setParam(f.doc, f.board, 'shots', [shots[1], shots[0]])
    expect(sourceLinkState(f.doc, f.board, link)).toBe('current')
    setParam(f.doc, f.board, 'shots', [{ ...shots[0], description: '现在跑开' }])
    expect(sourceLinkState(f.doc, f.board, link)).toBe('changed')
    setParam(f.doc, f.board, 'shots', [{ ...shots[0], id: 'split-new', no: 1 }])
    expect(sourceLinkState(f.doc, f.board, link)).toBe('missing')
    expect(sourceMapOf(f.doc, f.board).links[0]!.shotId).toBe('one')
    f.doc.destroy()
  })

  it('协作者独立新增事件合并；本地撤销不删除远端事件，重做恢复原ID', () => {
    const f = fixture()
    const snapshotId = capture(f)
    f.doc.undo.clear()
    const peerY = new Y.Doc()
    Y.applyUpdate(peerY, Y.encodeStateAsUpdate(f.doc.ydoc))
    const peer = openDoc(peerY)
    const own = addSourceUnit(f.doc, f.board, { snapshotId, start: 0, end: 5, kind: 'event' })!
    const remote = addSourceUnit(peer, f.board, {
      snapshotId,
      start: 6,
      end: 11,
      kind: 'dialogue',
    })!
    Y.applyUpdate(f.doc.ydoc, Y.encodeStateAsUpdate(peerY))
    Y.applyUpdate(peerY, Y.encodeStateAsUpdate(f.doc.ydoc))
    expect(
      sourceMapOf(f.doc, f.board)
        .units.map((u) => u.id)
        .sort(),
    ).toEqual([own, remote].sort())
    f.doc.undo.undo()
    expect(sourceMapOf(f.doc, f.board).units.map((u) => u.id)).toEqual([remote])
    f.doc.undo.redo()
    expect(
      sourceMapOf(f.doc, f.board)
        .units.map((u) => u.id)
        .sort(),
    ).toEqual([own, remote].sort())
    peer.destroy()
    f.doc.destroy()
  })

  it('内部副本映射新身份与当前绑定，外部副本只留历史；原始出处及原文不被重写', () => {
    const f = fixture()
    const snapshotId = capture(f)
    const unitId = addSourceUnit(f.doc, f.board, { snapshotId, start: 0, end: 5, kind: 'event' })!
    setSourceLink(f.doc, f.board, { unitId, shotId: 'one', treatment: 'retain' })
    setSourceLink(f.doc, f.board, {
      unitId,
      shotId: 'one',
      dialogueId: 'line-a',
      treatment: 'retain',
    })
    addAdaptationProposal(f.doc, f.board, ['one'], '等待动作提案')
    markSourceRead(f.doc, f.board, snapshotId)
    const record = sourceMapOf(f.doc, f.board)
    const copied = copySourceMap(record, new Map([[f.source, 'copied-source']]))
    expect(copied.sources[0]!.binding!.elementId).toBe('copied-source')
    expect(copied.snapshots[0]!.originAtCapture).toEqual(record.snapshots[0]!.originAtCapture)
    expect(copied.snapshots[0]!.text).toBe(record.snapshots[0]!.text)
    expect(copied.snapshots[0]!.id).not.toBe(snapshotId)
    expect(copied.links[0]!.unitId).toBe(copied.units[0]!.id)
    expect(copied.links.find((link) => link.dialogueId === 'line-a')!.shotId).toBe('one')
    expect(copied.proposals[0]!.id).not.toBe(record.proposals[0]!.id)
    expect(copied.proposals[0]!.shotIds).toEqual(['one'])
    expect(copied.readSnapshotIds).toEqual([])
    expect(copySourceMap(record, new Map()).sources[0]!.binding).toBeNull()
    f.doc.destroy()
  })

  it('全文和范围经Yjs checkpoint编码还原；未来版本所有写入口只读', () => {
    const f = fixture()
    const snapshotId = capture(f)
    addSourceUnit(f.doc, f.board, { snapshotId, start: 0, end: 5, kind: 'event' })
    const restoredY = new Y.Doc()
    Y.applyUpdate(restoredY, Y.encodeStateAsUpdate(f.doc.ydoc))
    const restored = createDoc(restoredY)
    expect(sourceMapOf(restored, f.board)).toEqual(sourceMapOf(f.doc, f.board))
    restored.destroy()
    const futureY = new Y.Doc()
    Y.applyUpdate(futureY, Y.encodeStateAsUpdate(f.doc.ydoc))
    futureY.getMap('meta').set('schemaVersion', SCHEMA_VERSION + 1)
    const future = createDoc(futureY)
    expect(() => markSourceRead(future, f.board, snapshotId)).toThrow(ReadOnlyDocError)
    expect(() =>
      addSourceUnit(future, f.board, { snapshotId, start: 0, end: 5, kind: 'event' }),
    ).toThrow(ReadOnlyDocError)
    expect(() =>
      captureSourceSnapshot(future, f.board, {
        canvasId: 'c',
        elementId: f.source,
        port: 'text',
        expectedText: '',
      }),
    ).toThrow(ReadOnlyDocError)
    future.destroy()
    f.doc.destroy()
  })
})
