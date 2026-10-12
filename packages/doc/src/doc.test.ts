import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  addResults,
  adoptResult,
  fitAspect,
  MAX_RESULTS,
  currentResult,
  elementPorts,
  groupElements,
  resultHistory,
  writeRun,
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
  ReadOnlyDocError,
  SCHEMA_VERSION,
  sendToBack,
  setParams,
  setParent,
  setText,
  ungroupElements,
  updateElement,
  videoAssetOf,
  elementMedia,
} from './index'
import { box, node, openDoc } from './testing'

const open = openDoc

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
  it('一端改 x、另一端改 y 和参数，两边修改都保留', () => {
    const a = open()
    const id = createElement(a, node({ params: { prompt: '旧' } }))
    const b = open(new Y.Doc())
    exchange(a.ydoc, b.ydoc)

    moveElements(a, [id], 50, 0)
    updateElement(b, id, { y: 20 })
    setParams(b, id, { prompt: '新', seed: 7 })
    exchange(a.ydoc, b.ydoc)

    for (const d of [a, b]) {
      expect(d.get(id)).toMatchObject({ x: 50, y: 20, params: { prompt: '新', seed: 7 } })
    }
  })

  it('一端删除、另一端连线，悬空边在读取时被忽略', () => {
    const a = open()
    const [n1, n2] = createElements(a, [node(), node()])
    const b = open(new Y.Doc())
    exchange(a.ydoc, b.ydoc)

    deleteElements(a, [n2!])
    expect(connect(b, [n1!, 'out'], [n2!, 'in'])).not.toBeNull()
    exchange(a.ydoc, b.ydoc)

    expect([...a.edges()]).toHaveLength(0)
    expect(a.edgeMap.size).toBe(1)
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
    const a = createDoc(undefined, { schedule: () => {}, captureTimeout: 0 })
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

  it('只能从输出连到输入', () => {
    const doc = open()
    const [a, b] = createElements(doc, [node(), node()])
    expect(connect(doc, [a!, 'in'], [b!, 'in'])).toBeNull()
    expect(connect(doc, [a!, 'out'], [b!, 'out'])).toBeNull()
  })

  it('端口类型不兼容时拒绝，any 通配', () => {
    const doc = open()
    const image = node({
      ports: { inputs: [{ id: 'in', label: '图', type: 'image' }], outputs: [] },
    })
    const anyIn = node({
      ports: { inputs: [{ id: 'in', label: '任意', type: 'any' }], outputs: [] },
    })
    const anyOut = node({
      ports: { inputs: [], outputs: [{ id: 'out', label: '任意', type: 'any' }] },
    })
    const [t, i, x, y] = createElements(doc, [node(), image, anyIn, anyOut])
    expect(connect(doc, [t!, 'out'], [i!, 'in'])).toBeNull()
    expect(connect(doc, [t!, 'out'], [x!, 'in'])).not.toBeNull()
    expect(connect(doc, [y!, 'out'], [i!, 'in'])).not.toBeNull()
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

  /** schemaVersion 1 的文档，带若干旧版生成视频节点 */
  function v1Doc(videos: string[], nodeVersion = 1) {
    const ydoc = new Y.Doc()
    ydoc.getMap('meta').set('schemaVersion', 1)
    const elements = ydoc.getMap<unknown>('elements')
    for (const id of videos) {
      const m = new Y.Map<unknown>()
      for (const [k, v] of Object.entries({ kind: 'node', x: 0, y: 0, w: 10, h: 10, z: id }))
        m.set(k, v)
      m.set('nodeType', 'plein/video')
      m.set('nodeVersion', nodeVersion)
      m.set('params', new Y.Map(Object.entries({ prompt: 'p' })))
      m.set('ports', {
        inputs: [
          { id: 'prompt', label: '提示词', type: 'text', multiple: true },
          { id: 'firstFrame', label: '首帧', type: 'image' },
          { id: 'lastFrame', label: '尾帧', type: 'image' },
          { id: 'references', label: '参考图', type: 'image', multiple: true },
        ],
        outputs: [{ id: 'video', label: '视频', type: 'video' }],
      })
      elements.set(id, m)
    }
    const edges = ydoc.getMap<{ to: string[] }>('edges')
    const wire = (id: string, from: string, to: [string, string]) =>
      edges.set(id, { id, from: [from, 'image'], to } as never)
    return { ydoc, edges, wire }
  }

  it('v1 生成视频节点的首帧 / 尾帧并成一个图片输入，模式按原连线推断', () => {
    const { ydoc, wire } = v1Doc(['v1', 'v2'])
    wire('e1', 'a', ['v1', 'firstFrame'])
    wire('e2', 'b', ['v1', 'lastFrame'])

    const doc = open(ydoc)
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION)
    expect(doc.get('v1')).toMatchObject({ nodeVersion: 2, params: { prompt: 'p', mode: 'frames' } })
    expect(doc.get('v1')!.ports!.inputs.map((p) => p.id)).toEqual(['prompt', 'images'])
    expect([...ydoc.getMap<{ to: string[] }>('edges').values()].map((e) => e.to)).toEqual([
      ['v1', 'images'],
      ['v1', 'images'],
    ])
    expect(doc.get('v2')!.params).toMatchObject({ mode: 'text' })
  })

  it.each([
    ['firstFrame', 'image'],
    ['references', 'reference'],
  ])('v1 视频节点只连了 %s 时模式为 %s', (port, mode) => {
    const { ydoc, wire } = v1Doc(['v'])
    wire('e', 'a', ['v', port])
    expect(open(ydoc).get('v')!.params).toMatchObject({ mode })
  })

  it('v1 同一来源同时连首帧和尾帧时只留一条边', () => {
    const { ydoc, edges, wire } = v1Doc(['v'])
    wire('e1', 'a', ['v', 'firstFrame'])
    wire('e2', 'a', ['v', 'lastFrame'])
    open(ydoc)
    expect([...edges.values()].map((e) => e.to)).toEqual([['v', 'images']])
  })

  it('已是 2 版的视频节点不动', () => {
    const { ydoc, edges, wire } = v1Doc(['v'], 2)
    wire('e', 'a', ['v', 'firstFrame'])
    const doc = open(ydoc)
    expect(doc.get('v')!.params).toEqual({ prompt: 'p' })
    expect(doc.get('v')!.ports!.inputs).toHaveLength(4)
    expect(edges.get('e')!.to).toEqual(['v', 'firstFrame'])
  })

  it('v0 未知的旧类型变成同名 nodeType 的节点', () => {
    const ydoc = new Y.Doc()
    ydoc.getMap<unknown>('elements').set('a', { id: 'a', kind: 'acme/x', x: 0, y: 0, w: 1, h: 1 })
    expect(open(ydoc).get('a')).toMatchObject({ kind: 'node', nodeType: 'acme/x', nodeVersion: 1 })
  })

  it('没有版本号的空文档直接标为当前版本', () => {
    const ydoc = new Y.Doc()
    const doc = open(ydoc)
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION)
    expect(ydoc.getMap('meta').get('schemaVersion')).toBe(SCHEMA_VERSION)
  })

  it('版本高于客户端时只读', () => {
    const ydoc = new Y.Doc()
    ydoc.getMap('meta').set('schemaVersion', SCHEMA_VERSION + 1)
    const doc = open(ydoc)
    expect(doc.readOnly).toBe(true)
    expect(() => createElement(doc, box())).toThrow(ReadOnlyDocError)
  })
})

describe('节点结果与端口', () => {
  const nodePorts = {
    inputs: [
      { id: 'prompt', label: '提示词', type: 'text' as const },
      { id: 'refs', label: '参考图', type: 'image' as const, multiple: true },
    ],
    outputs: [{ id: 'images', label: '图片', type: 'image' as const }],
  }

  it('结果追加后自动采用，采用可撤销，系统写入不进撤销栈', () => {
    const doc = open()
    const id = createElement(doc, { kind: 'node', x: 0, y: 0, w: 200, h: 200, ports: nodePorts })
    doc.undo.stopCapturing()
    const r = (n: number) => ({
      id: `r${n}`,
      port: 'images',
      value: { type: 'image' as const, assetId: `a${n}` },
      runId: 'run1',
      at: n,
    })
    addResults(doc, id, [r(1), r(2)])
    writeRun(doc, id, { id: 'run1', status: 'succeeded', at: 1 })
    expect(doc.get(id)!.results!.map((x) => x.id)).toEqual(['r1', 'r2'])
    expect(currentResult(doc.get(id)!)?.id).toBe('r1')
    expect(doc.get(id)!.run?.status).toBe('succeeded')
    adoptResult(doc, id, 'r2')
    expect(currentResult(doc.get(id)!)?.id).toBe('r2')
    doc.undo.undo()
    expect(currentResult(doc.get(id)!)?.id).toBe('r1')
    // 结果本身仍在
    expect(doc.get(id)!.results).toHaveLength(2)
    // 按端口取时跟着采用的那次运行：那次没有尾帧就是没有，不拿更早的凑数
    addResults(doc, id, [{ ...r(3), port: 'lastFrame', runId: 'run0' }])
    addResults(doc, id, [{ ...r(4), runId: 'run2' }])
    expect(currentResult(doc.get(id)!, 'lastFrame')).toBeUndefined()
    adoptResult(doc, id, 'r3')
    expect(currentResult(doc.get(id)!, 'lastFrame')?.id).toBe('r3')
    // 取消采用回到最新结果
    adoptResult(doc, id, null)
    expect(currentResult(doc.get(id)!)?.id).toBe('r4')
  })

  it('结果最多保留 MAX_RESULTS 个，丢最旧的', () => {
    const doc = open()
    const id = createElement(doc, { kind: 'node', x: 0, y: 0, w: 200, h: 200, ports: nodePorts })
    const batch = (from: number, n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `r${from + i}`,
        port: 'images',
        value: { type: 'image' as const, assetId: 'a' },
        runId: `run${from}`,
        at: from,
      }))
    addResults(doc, id, batch(0, MAX_RESULTS))
    addResults(doc, id, batch(MAX_RESULTS, 2))
    const ids = doc.get(id)!.results!.map((r) => r.id)
    expect(ids).toHaveLength(MAX_RESULTS)
    expect(ids.slice(0, 3)).toEqual([`r${MAX_RESULTS}`, `r${MAX_RESULTS + 1}`, 'r0'])
    expect(ids).not.toContain(`r${MAX_RESULTS - 1}`)
  })

  it('videoAssetOf：视频元素或当前结果是视频的节点', () => {
    const doc = open()
    const [video, image, n] = createElements(doc, [
      box({ kind: 'video', assetId: 'v' }),
      box({ assetId: 'i' }),
      { kind: 'node', x: 0, y: 0, w: 200, h: 200, ports: nodePorts },
    ])
    expect(videoAssetOf(doc.get(video!))).toBe('v')
    expect(videoAssetOf(doc.get(image!))).toBeUndefined()
    expect(videoAssetOf(undefined)).toBeUndefined()
    expect(videoAssetOf(doc.get(n!))).toBeUndefined()
    const result = (id: string, type: 'image' | 'video') => ({
      id,
      port: 'out',
      value: { type, assetId: id },
      runId: id,
      at: 0,
    })
    addResults(doc, n!, [result('img', 'image')])
    expect(videoAssetOf(doc.get(n!))).toBeUndefined()
    addResults(doc, n!, [result('vid', 'video')])
    expect(videoAssetOf(doc.get(n!))).toBe('vid')
  })

  it('elementMedia：素材取自身资产，节点取当前媒体结果，文本和空素材没有', () => {
    const doc = open()
    const [audio, empty, md, n] = createElements(doc, [
      box({ kind: 'audio', assetId: 'a' }),
      box({ kind: 'video' }),
      box({ kind: 'markdown', text: 'x' }),
      { kind: 'node', x: 0, y: 0, w: 200, h: 200, ports: nodePorts },
    ])
    expect(elementMedia(doc.get(audio!)!)).toEqual({ assetId: 'a', kind: 'audio' })
    expect(elementMedia(doc.get(empty!)!)).toBeNull()
    expect(elementMedia(doc.get(md!)!)).toBeNull()
    addResults(doc, n!, [
      { id: 't', port: 'out', value: { type: 'text', text: 'hi' }, runId: 't', at: 0 },
    ])
    expect(elementMedia(doc.get(n!)!)).toBeNull()
    addResults(doc, n!, [
      { id: 's', port: 'out', value: { type: 'audio', assetId: 's' }, runId: 's', at: 1 },
    ])
    expect(elementMedia(doc.get(n!)!)).toEqual({ assetId: 's', kind: 'audio' })
  })

  it('多连端口保留已有连线，素材元素有隐式输出端口', () => {
    const doc = open()
    const node = createElement(doc, { kind: 'node', x: 0, y: 0, w: 200, h: 200, ports: nodePorts })
    const a = createElement(doc, { kind: 'image', assetId: 'x', x: 0, y: 0, w: 10, h: 10 })
    const b = createElement(doc, { kind: 'image', assetId: 'y', x: 0, y: 0, w: 10, h: 10 })
    const md = createElement(doc, { kind: 'markdown', text: 'hi', x: 0, y: 0, w: 10, h: 10 })
    expect(elementPorts(doc.get(a)!)?.outputs[0]?.type).toBe('image')
    expect(connect(doc, [a, 'image'], [node, 'refs'])).not.toBeNull()
    expect(connect(doc, [b, 'image'], [node, 'refs'])).not.toBeNull()
    // 多连端口上重复连同一个来源
    expect(connect(doc, [b, 'image'], [node, 'refs'])).toBeNull()
    expect(connect(doc, [md, 'text'], [node, 'prompt'])).not.toBeNull()
    expect(doc.edgesOf(node)).toHaveLength(3)
    const md2 = createElement(doc, { kind: 'markdown', text: 'yo', x: 0, y: 0, w: 10, h: 10 })
    connect(doc, [md2, 'text'], [node, 'prompt'])
    expect(doc.edgesOf(node).filter((e) => e.to[1] === 'prompt')).toHaveLength(1)
  })

  it('打组：用 Frame 包住元素并保持世界坐标', () => {
    const doc = open()
    const a = createElement(doc, { kind: 'image', x: 100, y: 100, w: 50, h: 50 })
    const b = createElement(doc, { kind: 'image', x: 300, y: 200, w: 50, h: 50 })
    const f = groupElements(doc, [a, b], { padding: 10 })!
    expect(doc.get(f)).toMatchObject({ kind: 'frame', x: 90, y: 90, w: 270, h: 170 })
    expect(doc.get(a)!.parentId).toBe(f)
    expect(doc.worldRect(b)).toEqual({ x: 300, y: 200, w: 50, h: 50 })
  })

  it('解组：子元素回到父元素、世界坐标不变，Frame 被删除', () => {
    const doc = open()
    const a = createElement(doc, node({ x: 100, y: 100 }))
    const frame = groupElements(doc, [a])!
    expect(doc.get(a)!.parentId).toBe(frame)
    expect(ungroupElements(doc, frame)).toEqual([a])
    expect(doc.has(frame)).toBe(false)
    expect(doc.get(a)).toMatchObject({ parentId: null, x: 100, y: 100 })
  })

  it('生成历史：只收节点的媒体结果，新到旧，标出采用的那个', () => {
    const doc = open()
    const a = createElement(doc, { kind: 'node', x: 0, y: 0, w: 200, h: 200, ports: nodePorts })
    const b = createElement(doc, { kind: 'node', x: 0, y: 0, w: 200, h: 200, ports: nodePorts })
    createElement(doc, { kind: 'image', assetId: 'm', x: 0, y: 0, w: 10, h: 10 })
    addResults(doc, a, [
      { id: 'a1', port: 'images', value: { type: 'image', assetId: 'x1' }, runId: 'r', at: 10 },
      { id: 'a2', port: 'images', value: { type: 'image', assetId: 'x2' }, runId: 'r', at: 10 },
    ])
    addResults(doc, b, [
      { id: 't', port: 'text', value: { type: 'text', text: 'hi' }, runId: 's', at: 30 },
    ])
    addResults(doc, b, [
      { id: 'v', port: 'video', value: { type: 'video', assetId: 'y' }, runId: 'u', at: 20 },
    ])
    adoptResult(doc, a, 'a2')
    const h = resultHistory(doc)
    expect(h.map((e) => e.result.id)).toEqual(['v', 'a1', 'a2'])
    expect(h.find((e) => e.result.id === 'a2')).toMatchObject({ elementId: a, adopted: true })
    expect(h.find((e) => e.result.id === 'a1')!.adopted).toBe(false)
    expect(h[0]).toMatchObject({ elementId: b, adopted: true })
  })
})

describe('fitAspect', () => {
  it('长边和中心不动，系统写入不进撤销栈', () => {
    const doc = open()
    const id = createElement(doc, box({ x: 0, y: 0, w: 200, h: 100 }))
    doc.undo.stopCapturing()
    const before = doc.undo.undoStack.length
    expect(fitAspect(doc, id, 0.5)).toBe(true)
    expect(doc.get(id)).toMatchObject({ x: 50, y: -50, w: 100, h: 200 })
    expect(doc.undo.undoStack.length).toBe(before)
  })

  it('差 1px 以内不写', () => {
    const doc = open()
    const id = createElement(doc, box({ w: 200, h: 100 }))
    expect(fitAspect(doc, id, 200 / 101)).toBe(false)
    expect(doc.get(id)).toMatchObject({ w: 200, h: 100 })
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('比例 %s 无效', (ratio) => {
    const doc = open()
    const id = createElement(doc, box())
    expect(fitAspect(doc, id, ratio)).toBe(false)
  })
})
