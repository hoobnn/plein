import { describe, expect, it } from 'vite-plus/test'
import {
  addResults,
  createDoc,
  createElement,
  fixedResultHolders,
  readResults,
  removeResultsWithReceipt,
  undoResultRemoval,
  relatedOutputIds,
  staleLegacyResults,
  resultsContainer,
  verifiedLocalSelection,
  withVerifiedLocalSelection,
} from './index'
import type { VideoSegment } from './domain/video-segment'

/** 固定片段导入/恢复后的本地定位：完整身份对上才建立联系，孤立片段不猜。 */

const assetId = (c: string) => c.repeat(64).slice(0, 64)

const video = (id: string, runId = 'run-1', asset = assetId('a')) => ({
  id,
  port: 'video',
  runId,
  at: 1,
  value: { type: 'video' as const, assetId: asset },
})

const tail = (id: string, runId = 'run-1', group = 'g1') => ({
  id,
  port: 'lastFrame',
  runId,
  outputGroup: group,
  at: 1,
  value: { type: 'image' as const, assetId: assetId('b') },
})

function fixture(runId = 'run-1') {
  const doc = createDoc(undefined, { schedule: () => {} })
  const source = createElement(doc, {
    kind: 'node',
    nodeType: 'plein/video',
    x: 0,
    y: 0,
    w: 10,
    h: 10,
  })
  addResults(doc, source, [{ ...video('R', runId), outputGroup: 'g1' }, tail('T', runId)])
  doc.flush()
  return { doc, source }
}

function segment(overrides: Partial<VideoSegment> = {}): VideoSegment {
  return {
    version: 1,
    segmentId: 'segment-1',
    asset: { assetId: assetId('a'), kind: 'video' },
    duration: 3,
    selection: {
      canvasId: 'old-canvas',
      nodeId: 'placeholder',
      port: 'video',
      resultId: 'R',
      runId: 'old-run',
    },
    ...overrides,
  }
}

describe('固定片段的本地候选定位', () => {
  it('画布、节点、候选、运行和文件都对上才建立本地位置', () => {
    const { doc, source } = fixture('new-run')
    const s = segment({ selection: { ...segment().selection!, nodeId: source } })
    const map = new Map([
      ['old-canvas', 'new-canvas'],
      ['old-run', 'new-run'],
    ])
    const lookup = (id: string) => doc.elementMaps.get(id)
    expect(verifiedLocalSelection(s, lookup, map)).toEqual({
      canvasId: 'new-canvas',
      nodeId: source,
      port: 'video',
      resultId: 'R',
      runId: 'new-run',
    })
    // 来源画布没有映射：不猜
    expect(verifiedLocalSelection(s, lookup, new Map([['old-run', 'new-run']]))).toBeUndefined()
    // 运行对不上：不建立联系
    const stale = segment({
      selection: { ...segment().selection!, nodeId: source, runId: 'other-run' },
    })
    expect(verifiedLocalSelection(stale, lookup, map)).toBeUndefined()
    // 文件对不上：同候选 id 也不算
    const wrongFile = segment({
      asset: { assetId: assetId('f'), kind: 'video' },
      selection: { ...segment().selection!, nodeId: source },
    })
    expect(verifiedLocalSelection(wrongFile, lookup, map)).toBeUndefined()
    doc.destroy()
  })

  it('历史 selection / origin 不动，只另存核实过的本地位置', () => {
    const { doc, source } = fixture('new-run')
    const s = segment({ selection: { ...segment().selection!, nodeId: source } })
    const verified = withVerifiedLocalSelection(
      s,
      (id) => doc.elementMaps.get(id),
      new Map([
        ['old-canvas', 'new-canvas'],
        ['old-run', 'new-run'],
      ]),
    )
    expect(verified.selection).toEqual(s.selection)
    expect(verified.localSelection?.runId).toBe('new-run')
    doc.destroy()
  })

  it('本地位置也参与固定引用保护', () => {
    const { doc, source } = fixture('new-run')
    const holder = createElement(doc, {
      kind: 'video',
      assetId: assetId('a'),
      x: 0,
      y: 0,
      w: 10,
      h: 10,
    })
    doc.mutable(holder)!.set('videoSegment', {
      version: 1,
      segmentId: 'segment-1',
      asset: { assetId: assetId('a'), kind: 'video' },
      duration: 3,
      selection: {
        canvasId: 'old-canvas',
        nodeId: source,
        port: 'video',
        resultId: 'R',
        runId: 'old-run',
      },
      localSelection: {
        canvasId: 'new-canvas',
        nodeId: source,
        port: 'video',
        resultId: 'R',
        runId: 'new-run',
      },
    })
    doc.flush()
    const holders = fixedResultHolders([...doc.elements()], {
      canvasId: 'new-canvas',
      nodeId: source,
      results: doc.get(source)!.results!,
    })
    expect([...holders.keys()]).toEqual(['R'])
    doc.destroy()
  })
})

describe('删除被固定引用挡下', () => {
  function withHolder() {
    const { doc, source } = fixture()
    const holder = createElement(doc, {
      kind: 'video',
      assetId: assetId('a'),
      x: 0,
      y: 0,
      w: 10,
      h: 10,
    })
    doc.mutable(holder)!.set('videoSegment', {
      version: 1,
      segmentId: 'segment-1',
      asset: { assetId: assetId('a'), kind: 'video' },
      duration: 3,
      selection: {
        canvasId: 'canvas-1',
        nodeId: source,
        port: 'video',
        resultId: 'R',
        runId: 'run-1',
      },
    })
    doc.flush()
    return { doc, source, holder }
  }

  it('固定候选与其关联输出都保留，并报告谁在用', () => {
    const { doc, source, holder } = withHolder()
    const out = removeResultsWithReceipt(
      doc,
      [
        { elementId: source, resultId: 'R' },
        { elementId: source, resultId: 'T' },
      ],
      { canvasId: 'canvas-1' },
    )
    expect(out.removed).toBe(0)
    expect(out.kept.map((k) => k.resultId).sort()).toEqual(['R', 'T'])
    expect(out.kept[0]!.holders[0]!.holderId).toBe(holder)
    // 源记录还在
    const container = resultsContainer(doc.mutable(source)!)!
    expect(readResults(doc.mutable(source)!).map((r) => r.id)).toEqual(['R', 'T'])
    expect(container.length).toBe(2)
    doc.destroy()
  })

  it('只请求删配对尾帧、固定的是视频时也要挡下', () => {
    const { doc, source } = withHolder()
    const out = removeResultsWithReceipt(doc, [{ elementId: source, resultId: 'T' }], {
      canvasId: 'canvas-1',
    })
    expect(out.removed).toBe(0)
    expect(out.kept.map((k) => k.resultId)).toEqual(['T'])
    // 报告的是那位仍在引用它的固定片段
    expect(out.kept[0]!.holders[0]!.segmentId).toBe('segment-1')
    doc.destroy()
  })

  it('同 id / 运行 / 端口的文本记录不算固定引用，可以正常删除', () => {
    const { doc, source } = withHolder()
    addResults(
      doc,
      source,
      [
        {
          id: 'R2',
          port: 'video',
          runId: 'run-r2',
          at: 2,
          value: { type: 'text' as const, text: '说明' },
        },
      ],
      { adopt: false },
    )
    doc.flush()
    // 伪造一个只按 id 就能骗过旧实现的选择
    const holder = createElement(doc, {
      kind: 'video',
      assetId: assetId('a'),
      x: 0,
      y: 0,
      w: 10,
      h: 10,
    })
    doc.mutable(holder)!.set('videoSegment', {
      version: 1,
      segmentId: 'segment-text',
      asset: { assetId: assetId('a'), kind: 'video' },
      duration: 3,
      selection: {
        canvasId: 'canvas-1',
        nodeId: source,
        port: 'video',
        resultId: 'R2',
        runId: 'run-r2',
      },
    })
    doc.flush()
    const holders = fixedResultHolders([...doc.elements()], {
      canvasId: 'canvas-1',
      nodeId: source,
      results: doc.get(source)!.results!,
    })
    expect(holders.has('R2')).toBe(false)
    const out = removeResultsWithReceipt(doc, [{ elementId: source, resultId: 'R2' }], {
      canvasId: 'canvas-1',
    })
    expect(out.removed).toBe(1)
    doc.destroy()
  })

  it('混合批次只删没被引用的，报告实际删除与保留数', () => {
    const { doc, source } = withHolder()
    addResults(
      doc,
      source,
      [
        {
          id: 'U',
          port: 'images',
          runId: 'run-2',
          at: 1,
          value: { type: 'image' as const, assetId: assetId('c') },
        },
      ],
      { adopt: false },
    )
    doc.flush()
    const out = removeResultsWithReceipt(
      doc,
      [
        { elementId: source, resultId: 'R' },
        { elementId: source, resultId: 'U' },
      ],
      { canvasId: 'canvas-1' },
    )
    expect(out.removed).toBe(1)
    expect(out.kept.map((k) => k.resultId)).toEqual(['R'])
    expect(readResults(doc.mutable(source)!).map((r) => r.id)).toEqual(['R', 'T'])
    doc.destroy()
  })

  it('别的画布同名固定片段不挡删除', () => {
    const { doc, source } = withHolder()
    const out = removeResultsWithReceipt(doc, [{ elementId: source, resultId: 'R' }], {
      canvasId: 'other-canvas',
    })
    expect(out.removed).toBe(1)
    expect(out.kept).toEqual([])
    doc.destroy()
  })
})

describe('旧端迟到写入的冲突证据', () => {
  it('新结果不被覆盖，旧记录作为可核对证据列出', async () => {
    const { doc, source } = fixture()
    const legacy = video('L', 'legacy-run', assetId('d'))
    doc.ydoc.transact(() => {
      doc.mutable(source)!.set('results', [legacy])
    })
    doc.flush()
    // 读取仍以新容器为准
    expect(doc.get(source)!.results!.map((r) => r.id)).toEqual(['R', 'T'])
    const { staleLegacyResults } = await import('./index')
    expect(staleLegacyResults(doc.elementMaps)).toEqual([
      { elementId: source, current: ['R', 'T'], stale: ['L'], cleared: false },
    ])
    doc.destroy()
  })
})

describe('关联输出与既有 relatedResult 同规则', () => {
  it('同运行里旧无组视频 + 新组视频 + 旧尾帧：旧视频没有可核对的尾帧', () => {
    const results = [
      { ...video('v', 'run'), outputGroup: undefined },
      { ...video('vf', 'run'), outputGroup: 'g' },
      {
        id: 'f',
        port: 'lastFrame',
        runId: 'run',
        at: 1,
        value: { type: 'image' as const, assetId: assetId('b') },
      },
    ]
    expect([...relatedOutputIds(results, 'v')]).toEqual(['v'])
  })

  it('同一组里两个视频候选时尾帧配不上，不能把同端口的另一条也算进来', () => {
    const results = [
      { ...video('v', 'run'), outputGroup: 'g' },
      { ...video('other', 'run'), outputGroup: 'g' },
      {
        id: 'f',
        port: 'lastFrame',
        runId: 'run',
        outputGroup: 'g',
        at: 1,
        value: { type: 'image' as const, assetId: assetId('b') },
      },
    ]
    expect([...relatedOutputIds(results, 'v')]).toEqual(['v'])
  })
})

describe('旧端清空与坏记录的两条兼容路径', () => {
  it('旧端把结果清空时新结果保留，并报告清空意图', () => {
    const { doc, source } = fixture()
    doc.ydoc.transact(() => {
      doc.mutable(source)!.set('results', [])
    })
    doc.flush()
    expect(doc.get(source)!.results!.map((r) => r.id)).toEqual(['R', 'T'])
    expect(staleLegacyResults(doc.elementMaps)).toEqual([
      { elementId: source, current: ['R', 'T'], stale: [], cleared: true },
    ])
    doc.destroy()
  })

  it('旧键里混着 null 时仍能正常删除有效候选并撤销', () => {
    const doc = createDoc(undefined, { schedule: () => {} })
    // 已升 v12 但还没被新端接管：空容器 + 旧键里的坏记录与有效候选
    const source = createElement(doc, { kind: 'node', x: 0, y: 0, w: 10, h: 10 })
    const m = doc.mutable(source)!
    resultsContainer(m)!.delete(0, resultsContainer(m)!.length)
    m.set('results', [null, video('R')])
    doc.flush()
    expect(doc.get(source)!.results!.map((r) => r.id)).toEqual(['R'])
    const outcome = removeResultsWithReceipt(doc, [{ elementId: source, resultId: 'R' }], {
      canvasId: null,
    })
    expect(outcome.removed).toBe(1)
    expect(doc.get(source)!.results).toEqual([])
    expect(undoResultRemoval(doc, outcome.receipt).undone).toBe(true)
    expect(doc.get(source)!.results!.map((r) => r.id)).toEqual(['R'])
    doc.destroy()
  })
})
