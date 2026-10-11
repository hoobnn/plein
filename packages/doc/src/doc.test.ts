import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  bringToFront,
  connect,
  createDoc,
  createElement,
  createElements,
  type DocChange,
  deleteElements,
  duplicateElements,
  exportElements,
  importElements,
  moveElements,
  type NewElement,
  pruneDanglingEdges,
  ReadOnlyDocError,
  SCHEMA_VERSION,
  sendToBack,
  setParams,
  setParent,
  setText,
  updateElement,
} from './index'

const manual = { schedule: () => {} }
const open = (ydoc?: Y.Doc) => createDoc(ydoc, manual)

const box = (extra: Partial<NewElement> = {}): NewElement => ({
  kind: 'image',
  x: 0,
  y: 0,
  w: 100,
  h: 80,
  ...extra,
})

const node = (extra: Partial<NewElement> = {}): NewElement =>
  box({
    kind: 'node',
    nodeType: 'llm',
    ports: {
      inputs: [{ id: 'in', label: '输入', type: 'text' }],
      outputs: [{ id: 'out', label: '输出', type: 'text' }],
    },
    ...extra,
  })

/** 两端各自离线修改后互相交换全部状态 */
function exchange(a: Y.Doc, b: Y.Doc) {
  const ua = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b))
  const ub = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a))
  Y.applyUpdate(b, ua)
  Y.applyUpdate(a, ub)
}

describe('元素', () => {
  it('新建元素补齐默认值，后建的叠在上面', () => {
    const doc = open()
    const [a, b] = createElements(doc, [box(), box({ kind: 'markdown', text: '# 标题' })])
    const ea = doc.get(a!)!
    const eb = doc.get(b!)!
    expect(ea).toMatchObject({ kind: 'image', rotation: 0, parentId: null, locked: false })
    expect(eb.text).toBe('# 标题')
    expect(ea.z < eb.z).toBe(true)
    expect(doc.children(null).map((e) => e.id)).toEqual([a, b])
  })

  it('只写变化的字段，尺寸不小于 1', () => {
    const doc = open()
    const id = createElement(doc, box())
    updateElement(doc, id, { w: -5, name: '封面' })
    expect(doc.get(id)).toMatchObject({ w: 1, name: '封面' })
    updateElement(doc, id, { name: undefined })
    expect(doc.get(id)!.name).toBeUndefined()
  })

  it('锁定的元素不随移动', () => {
    const doc = open()
    const a = createElement(doc, box())
    const b = createElement(doc, box({ locked: true }))
    moveElements(doc, [a, b], 10, 20)
    expect(doc.get(a)).toMatchObject({ x: 10, y: 20 })
    expect(doc.get(b)).toMatchObject({ x: 0, y: 0 })
  })

  it('置顶与置底保持选中元素之间的相对顺序', () => {
    const doc = open()
    const [a, b, c, d] = createElements(doc, [box(), box(), box(), box()])
    bringToFront(doc, [a!, b!])
    expect(doc.children(null).map((e) => e.id)).toEqual([c, d, a, b])
    sendToBack(doc, [d!, b!])
    expect(doc.children(null).map((e) => e.id)).toEqual([d, b, c, a])
  })
})

describe('并发', () => {
  it('一端移动、另一端改参数，两边修改都保留', () => {
    const a = open()
    const id = createElement(a, node({ params: { prompt: '旧' } }))
    const b = open(new Y.Doc())
    exchange(a.ydoc, b.ydoc)

    moveElements(a, [id], 50, 0)
    setParams(b, id, { prompt: '新', seed: 7 })
    exchange(a.ydoc, b.ydoc)

    for (const d of [a, b]) {
      expect(d.get(id)).toMatchObject({ x: 50, params: { prompt: '新', seed: 7 } })
    }
  })

  it('同时改 x 和 y 不互相覆盖', () => {
    const a = open()
    const id = createElement(a, box())
    const b = open(new Y.Doc())
    exchange(a.ydoc, b.ydoc)
    updateElement(a, id, { x: 10 })
    updateElement(b, id, { y: 20 })
    exchange(a.ydoc, b.ydoc)
    expect(a.get(id)).toMatchObject({ x: 10, y: 20 })
    expect(b.get(id)).toMatchObject({ x: 10, y: 20 })
  })

  it('一端删除、另一端连线，悬空边在读取时被忽略，可清理', () => {
    const a = open()
    const [n1, n2] = createElements(a, [node(), node()])
    const b = open(new Y.Doc())
    exchange(a.ydoc, b.ydoc)

    deleteElements(a, [n2!])
    expect(connect(b, [n1!, 'out'], [n2!, 'in'])).not.toBeNull()
    exchange(a.ydoc, b.ydoc)

    expect([...a.edges()]).toHaveLength(0)
    expect(a.edgeMap.size).toBe(1)
    pruneDanglingEdges(a)
    expect(a.edgeMap.size).toBe(0)
  })

  it('并发 setParent 成环时，环上的元素按根处理', () => {
    const a = open()
    const [f1, f2] = createElements(a, [box({ kind: 'frame' }), box({ kind: 'frame', x: 200 })])
    const b = open(new Y.Doc())
    exchange(a.ydoc, b.ydoc)

    setParent(a, [f1!], f2!)
    setParent(b, [f2!], f1!)
    exchange(a.ydoc, b.ydoc)

    for (const d of [a, b]) {
      expect(d.effectiveParent(d.get(f1!)!)).toBeNull()
      expect(d.effectiveParent(d.get(f2!)!)).toBeNull()
      expect(d.children(null)).toHaveLength(2)
    }
  })
})

describe('撤销', () => {
  it('撤销本地命令，不撤销远端修改', () => {
    const a = createDoc(undefined, { ...manual, captureTimeout: 0 })
    const id = createElement(a, box())
    a.undo.stopCapturing()
    moveElements(a, [id], 30, 0)

    const b = open(new Y.Doc())
    exchange(a.ydoc, b.ydoc)
    updateElement(b, id, { name: '远端' })
    exchange(a.ydoc, b.ydoc)

    a.undo.undo()
    expect(a.get(id)).toMatchObject({ x: 0, name: '远端' })
    a.undo.redo()
    expect(a.get(id)!.x).toBe(30)
    a.undo.undo()
    a.undo.undo()
    expect(a.has(id)).toBe(false)
  })
})

describe('层级', () => {
  it('setParent 保持世界坐标，父元素移动时子元素随之移动', () => {
    const doc = open()
    const frame = createElement(doc, box({ kind: 'frame', x: 100, y: 100, w: 500, h: 400 }))
    const child = createElement(doc, box({ x: 150, y: 120 }))
    expect(setParent(doc, [child], frame)).toEqual([child])
    expect(doc.get(child)).toMatchObject({ x: 50, y: 20, parentId: frame })
    expect(doc.worldRect(child)).toMatchObject({ x: 150, y: 120 })

    moveElements(doc, [frame, child], 10, 10)
    expect(doc.worldRect(child)).toMatchObject({ x: 160, y: 130 })
    expect(doc.get(child)).toMatchObject({ x: 50, y: 20 })
  })

  it('拒绝成环与非容器父元素', () => {
    const doc = open()
    const [outer, inner, img] = createElements(doc, [
      box({ kind: 'frame' }),
      box({ kind: 'frame' }),
      box(),
    ])
    setParent(doc, [inner!], outer!)
    expect(setParent(doc, [outer!], inner!)).toEqual([])
    expect(setParent(doc, [inner!], img!)).toEqual([])
    expect(doc.get(inner!)!.parentId).toBe(outer)
  })

  it('删除容器连同后代与相关的边', () => {
    const doc = open()
    const frame = createElement(doc, box({ kind: 'frame' }))
    const [n1, n2] = createElements(doc, [node({ parentId: frame }), node()])
    connect(doc, [n1!, 'out'], [n2!, 'in'])
    deleteElements(doc, [frame])
    expect(doc.has(n1!)).toBe(false)
    expect(doc.has(n2!)).toBe(true)
    expect(doc.edgeMap.size).toBe(0)
  })
})

describe('连线', () => {
  it('一个输入端口只接一条边，端口必须存在', () => {
    const doc = open()
    const [a, b, c] = createElements(doc, [node(), node(), node()])
    const e1 = connect(doc, [a!, 'out'], [c!, 'in'])
    expect(e1).not.toBeNull()
    expect(connect(doc, [a!, 'out'], [c!, 'in'])).toBeNull()
    connect(doc, [b!, 'out'], [c!, 'in'])
    expect([...doc.edges()].map((e) => e.from[0])).toEqual([b])
    expect(connect(doc, [a!, 'nope'], [b!, 'in'])).toBeNull()
    expect(connect(doc, [a!, 'out'], [a!, 'in'])).toBeNull()
  })
})

describe('剪贴板', () => {
  it('导入时换新 id，保留层级、顺序与内部连线', () => {
    const doc = open()
    const frame = createElement(doc, box({ kind: 'frame', x: 100, y: 100, w: 400, h: 300 }))
    const [n1, n2] = createElements(doc, [
      node({ parentId: frame, x: 10, y: 10 }),
      node({ parentId: frame, x: 200, y: 10 }),
    ])
    const outside = createElement(doc, node())
    connect(doc, [n1!, 'out'], [n2!, 'in'])
    connect(doc, [n2!, 'out'], [outside, 'in'])

    const data = exportElements(doc, [frame, n1!])
    expect(data.elements.map((e) => e.id)).toEqual([frame, n1, n2])
    expect(data.edges).toHaveLength(1)

    const [copy] = importElements(doc, JSON.parse(JSON.stringify(data)), { dx: 1000 })
    expect(doc.worldRect(copy!)).toMatchObject({ x: 1100, y: 100 })
    const kids = doc.children(copy!)
    expect(kids.map((k) => k.x)).toEqual([10, 200])
    const copied = [...doc.edges()].filter((e) => e.from[0] === kids[0]!.id)
    expect(copied).toHaveLength(1)
    expect(copied[0]!.to[0]).toBe(kids[1]!.id)
  })

  it('复制文本与参数', () => {
    const doc = open()
    const md = createElement(doc, box({ kind: 'markdown', text: '你好' }))
    setText(doc, md, '你好，世界')
    const [copy] = duplicateElements(doc, [md])
    expect(doc.get(copy!)).toMatchObject({ text: '你好，世界', x: 24, y: 24 })
    expect(doc.getText(copy!)).not.toBe(doc.getText(md))
  })
})

describe('变更通知', () => {
  it('按调度归并，嵌套修改归到所属元素', () => {
    const flushes: Array<() => void> = []
    const doc = createDoc(undefined, { schedule: (f) => flushes.push(f) })
    const seen: DocChange[] = []
    doc.subscribe((c) => seen.push(c))

    const id = createElement(doc, node())
    moveElements(doc, [id], 1, 1)
    setParams(doc, id, { prompt: 'x' })
    expect(seen).toHaveLength(0)
    expect(flushes).toHaveLength(1)

    flushes[0]!()
    expect(seen).toHaveLength(1)
    expect([...seen[0]!.elements]).toEqual([id])
  })
})

describe('迁移', () => {
  it('v0 整对象元素升级为嵌套 Y.Map', () => {
    const ydoc = new Y.Doc()
    const legacy = ydoc.getMap<unknown>('elements')
    legacy.set('a', { id: 'a', kind: 'llm', x: 1, y: 2, w: 3, h: 4, params: { model: 'm' } })
    legacy.set('b', { id: 'b', kind: 'group', x: 0, y: 0, w: 10, h: 10 })

    const doc = open(ydoc)
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION)
    expect(doc.get('a')).toMatchObject({ kind: 'node', nodeType: 'llm', params: { model: 'm' } })
    expect(doc.get('b')!.kind).toBe('frame')
    expect(doc.undo.undoStack).toHaveLength(0)
  })

  it('版本高于客户端时只读', () => {
    const ydoc = new Y.Doc()
    ydoc.getMap('meta').set('schemaVersion', SCHEMA_VERSION + 1)
    const doc = open(ydoc)
    expect(doc.readOnly).toBe(true)
    expect(() => createElement(doc, box())).toThrow(ReadOnlyDocError)
  })
})
