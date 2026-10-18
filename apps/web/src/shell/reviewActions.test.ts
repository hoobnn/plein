import type { Engine } from '@plein/canvas-core'
import { addResults, createDoc, createElement, deleteElements, type NodeResult } from '@plein/doc'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { useCanvas } from '../stores/canvas'
import { currentReviewCandidates, isCurrentReview, runReviewAction } from './reviewActions'

const initial = useCanvas.getState()
const docs: ReturnType<typeof createDoc>[] = []
afterEach(() => {
  useCanvas.setState(initial, true)
  for (const doc of docs.splice(0)) doc.destroy()
})
function setup() {
  const doc = createDoc(undefined, { schedule: () => {} })
  docs.push(doc)
  const id = createElement(doc, {
    kind: 'node',
    nodeType: 'plein/image',
    x: 0,
    y: 0,
    w: 300,
    h: 200,
  })
  const results: NodeResult[] = ['a', 'b'].map((key, i) => ({
    id: key,
    runId: `run-${key}`,
    port: 'image',
    value: { type: 'image', assetId: key.repeat(64) },
    at: i,
  }))
  addResults(doc, id, results)
  const select = vi.fn()
  const zoom = vi.fn()
  const engine = { doc, selection: { set: select }, zoomToFit: zoom } as unknown as Engine
  const viewer = { kind: 'result' as const, nodeId: id, resultId: 'b', name: '审片' }
  useCanvas.setState({ engine, canvasId: 'source', viewer, history: true })
  return {
    doc,
    id,
    results,
    select,
    zoom,
    target: { engine, canvasId: 'source', viewer, result: results[1]! },
  }
}

for (const change of ['engine', 'canvas', 'viewer'] as const) {
  it(`${change} 改变后拒绝旧审片采用与定位，保留新上下文`, () => {
    const { doc, id, target, select, zoom } = setup()
    if (change === 'engine') useCanvas.setState({ engine: {} as Engine })
    if (change === 'canvas') useCanvas.setState({ canvasId: 'other' })
    if (change === 'viewer') useCanvas.setState({ viewer: { ...target.viewer } })
    expect(isCurrentReview(target)).toBe(false)
    expect(currentReviewCandidates(target, 'image')).toEqual([])
    expect(runReviewAction(target, 'adopt')).toContain('上下文已变化')
    expect(runReviewAction(target, 'locate')).toContain('上下文已变化')
    expect(doc.get(id)?.adopted).toBe('a')
    expect(select).not.toHaveBeenCalled()
    expect(zoom).not.toHaveBeenCalled()
    expect(useCanvas.getState().history).toBe(true)
  })
}
for (const change of ['removed', 'asset', 'port', 'run'] as const) {
  it(`候选 ${change} 变化时拒绝采用旧快照`, () => {
    const { doc, id, results, target } = setup()
    const changed =
      change === 'asset'
        ? { ...results[1]!, value: results[0]!.value }
        : change === 'port'
          ? { ...results[1]!, port: 'other' }
          : { ...results[1]!, runId: 'other' }
    doc
      .mutable(id)!
      .set('results', change === 'removed' ? results.slice(0, 1) : [results[0], changed])
    expect(runReviewAction(target, 'adopt')).toContain('候选已变化')
    expect(doc.get(id)?.adopted).toBe('a')
  })
}
it('来源删除后不选择不存在的节点，恢复后可重新定位', () => {
  const { doc, id, target, select, zoom } = setup()
  doc.undo.stopCapturing()
  deleteElements(doc, [id])
  expect(runReviewAction(target, 'locate')).toContain('来源节点已删除')
  expect(select).not.toHaveBeenCalled()
  doc.undo.undo()
  expect(runReviewAction(target, 'locate')).toBeNull()
  expect(select).toHaveBeenCalledWith([id])
  expect(zoom).toHaveBeenCalledWith([id])
  expect(useCanvas.getState().history).toBe(false)
})

it('实时浏览列表只取原端口，移除、恢复与新增立即反映到结果', () => {
  const { doc, id, results, target } = setup()
  expect(currentReviewCandidates(target, 'image').map((result) => result.id)).toEqual(['a', 'b'])
  doc.mutable(id)!.set('results', [{ ...results[0], id: 'foreign', port: 'metadata' }, results[1]])
  expect(currentReviewCandidates(target, 'image').map((result) => result.id)).toEqual(['b'])
  doc.mutable(id)!.set('results', [])
  expect(currentReviewCandidates(target, 'image')).toEqual([])
  doc.mutable(id)!.set('results', [{ ...results[0], id: 'new' }, ...results])
  expect(currentReviewCandidates(target, 'image').map((result) => result.id)).toEqual([
    'new',
    'a',
    'b',
  ])
})
it('实时只读状态拒绝采用，仍允许定位', () => {
  const { doc, id, target } = setup()
  doc.readOnly = true
  expect(runReviewAction(target, 'adopt')).toContain('只读')
  expect(doc.get(id)?.adopted).toBe('a')
  expect(runReviewAction(target, 'locate')).toBeNull()
})
it('采用有效原候选可独立撤销重做，已采用时不再改变撤销栈', () => {
  const { doc, id, target } = setup()
  expect(runReviewAction(target, 'adopt')).toBeNull()
  expect(doc.get(id)?.adopted).toBe('b')
  expect(runReviewAction(target, 'adopt')).toBeNull()
  doc.undo.undo()
  expect(doc.get(id)?.adopted).toBe('a')
  doc.undo.redo()
  expect(doc.get(id)?.adopted).toBe('b')
})
