import { createDoc, createElement, setParam, setText } from '@plein/doc'
import { defaultStageScene, STAGE_TYPE } from '@plein/nodes'
import { describe, expect, it } from 'vite-plus/test'
import { applyStageHistory, canStageHistory, watchStageHistory, writeStageEdit } from './history'

function setup() {
  const doc = createDoc(undefined, { schedule: () => {} })
  const off = watchStageHistory(doc)
  const scene = defaultStageScene()
  const id = createElement(doc, {
    kind: 'node',
    nodeType: STAGE_TYPE,
    x: 0,
    y: 0,
    w: 480,
    h: 270,
    params: { scene },
  })
  const edit = (pose: 'sit' | 'point' | 'run') =>
    writeStageEdit(doc, id, () =>
      setParam(doc, id, 'scene', { ...scene, figures: [{ ...scene.figures[0]!, pose }] }),
    )
  const pose = () => (doc.get(id)!.params!.scene as typeof scene).figures[0]!.pose
  return { doc, id, scene, off, edit, pose }
}

describe('构图撤销范围', () => {
  it('离散编辑分别撤销，不能跨过节点创建，重做和画布级撤销仍共享历史', () => {
    const { doc, id, off, edit, pose } = setup()
    edit('sit')
    edit('point')
    applyStageHistory(doc, id, 'undo')
    expect(pose()).toBe('sit')
    applyStageHistory(doc, id, 'undo')
    expect(pose()).toBe('stand')
    expect(canStageHistory(doc, id, 'undo')).toBe(false)
    applyStageHistory(doc, id, 'undo')
    expect(doc.get(id)).toBeDefined()
    applyStageHistory(doc, id, 'redo')
    expect(pose()).toBe('sit')
    doc.undo.redo()
    expect(pose()).toBe('point')
    doc.undo.undo()
    expect(canStageHistory(doc, id, 'redo')).toBe(true)
    applyStageHistory(doc, id, 'redo')
    expect(pose()).toBe('point')
    off()
    doc.destroy()
  })

  it('同字段连续编辑归并，其他画布操作不混入构图项', () => {
    const { doc, id, off, edit } = setup()
    const name = (value: string) =>
      writeStageEdit(doc, id, () => setParam(doc, id, 'label', value), 'name')
    name('A')
    name('AB')
    const count = doc.undo.undoStack.length
    const other = createElement(doc, {
      kind: 'markdown',
      x: 600,
      y: 0,
      w: 100,
      h: 100,
      text: 'other',
    })
    expect(doc.undo.undoStack.length).toBe(count + 1)
    expect(canStageHistory(doc, id, 'undo')).toBe(false)
    applyStageHistory(doc, id, 'undo')
    expect(doc.get(other)).toBeDefined()
    doc.undo.undo()
    applyStageHistory(doc, id, 'undo')
    expect(doc.get(id)!.params!.label).toBeUndefined()
    edit('sit')
    const text = createElement(doc, { kind: 'markdown', x: 0, y: 400, w: 100, h: 100 })
    setText(doc, text, 'new')
    expect(canStageHistory(doc, id, 'undo')).toBe(false)
    off()
    doc.destroy()
  })

  it('协作覆盖使当前操作失效时，不能继续跳过它而撤销其他操作', () => {
    const { doc, id, scene, off, edit, pose } = setup()
    edit('sit')
    doc.ydoc.transact(
      () =>
        setParam(doc, id, 'scene', { ...scene, figures: [{ ...scene.figures[0]!, pose: 'run' }] }),
      'remote',
    )
    applyStageHistory(doc, id, 'undo')
    expect(doc.get(id)).toBeDefined()
    expect(pose()).toBe('run')
    expect(canStageHistory(doc, id, 'undo')).toBe(false)
    off()
    doc.destroy()
  })

  it('另一个构图的历史不能在当前编辑器里撤销', () => {
    const { doc, id, off, edit, pose } = setup()
    edit('sit')
    expect(canStageHistory(doc, 'different-stage', 'undo')).toBe(false)
    applyStageHistory(doc, 'different-stage', 'undo')
    expect(pose()).toBe('sit')
    doc.readOnly = true
    expect(canStageHistory(doc, id, 'undo')).toBe(false)
    applyStageHistory(doc, id, 'undo')
    expect(pose()).toBe('sit')
    off()
    doc.destroy()
  })

  it('同一指针手势跨过时间窗仍归并，手势结束后恢复普通输入窗口', () => {
    const { doc, id, off } = setup()
    const name = (value: string, gesture: boolean) =>
      writeStageEdit(doc, id, () => setParam(doc, id, 'label', value), 'name', gesture)
    const timeout = doc.undo.captureTimeout
    name('A', true)
    doc.undo.lastChange = 1 // 模拟归并窗口已经过去。
    name('AB', true)
    expect(doc.undo.captureTimeout).toBe(timeout)
    applyStageHistory(doc, id, 'undo')
    expect(doc.get(id)!.params!.label).toBeUndefined()
    applyStageHistory(doc, id, 'redo')
    doc.undo.lastChange = 1
    name('ABC', false)
    applyStageHistory(doc, id, 'undo')
    expect(doc.get(id)!.params!.label).toBe('AB')
    off()
    doc.destroy()
  })

  it('手势不能跨越其他画布操作归并', () => {
    const { doc, id, off } = setup()
    const name = (value: string) =>
      writeStageEdit(doc, id, () => setParam(doc, id, 'label', value), 'name', true)
    name('A')
    const other = createElement(doc, {
      kind: 'markdown',
      x: 600,
      y: 0,
      w: 100,
      h: 100,
      text: 'other',
    })
    name('AB')
    applyStageHistory(doc, id, 'undo')
    expect(doc.get(id)!.params!.label).toBe('A')
    applyStageHistory(doc, id, 'undo')
    expect(doc.get(other)).toBeDefined()
    off()
    doc.destroy()
  })

  it('手势写入失败也恢复全局归并窗口', () => {
    const { doc, id, off } = setup()
    writeStageEdit(doc, id, () => setParam(doc, id, 'label', 'A'), 'name', true)
    const timeout = doc.undo.captureTimeout
    expect(() =>
      writeStageEdit(
        doc,
        id,
        () => {
          throw new Error('failed edit')
        },
        'name',
        true,
      ),
    ).toThrow('failed edit')
    expect(doc.undo.captureTimeout).toBe(timeout)
    doc.undo.lastChange = 1
    writeStageEdit(doc, id, () => setParam(doc, id, 'label', 'AB'), 'name')
    applyStageHistory(doc, id, 'undo')
    expect(doc.get(id)!.params!.label).toBe('A')
    off()
    doc.destroy()
  })
})
