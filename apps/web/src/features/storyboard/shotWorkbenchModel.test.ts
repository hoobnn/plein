import { connect, createElement, deleteElements, setParam } from '@plein/doc'
import { node, openDoc } from '@plein/doc/testing'
import { Shot } from '@plein/nodes'
import { describe, expect, it } from 'vite-plus/test'
import { applyWorkbenchDraft, workbenchDownstream, workbenchDraft } from './shotWorkbenchModel'

function seed() {
  const doc = openDoc()
  const rows = ['one', 'two'].map((id, i) => ({
    ...Shot.parse({
      id,
      no: i + 1,
      description: `原镜${id}`,
      motionPrompt: '@角色 原动作',
      dialogue: [{ id: 'line', line: '原台词', character: '角色' }],
    }),
    extra: { exact: [id, '保留'] },
  }))
  const board = createElement(
    doc,
    node({
      nodeType: 'plein/storyboard',
      params: { shots: rows, model: 'keep/model', manualExtra: '保留参数' },
    }),
  )
  return { doc, board, rows }
}

describe('镜头工作台局部修改', () => {
  it('只写目标字段，保留其他镜头/台词/未知字段，单次undo/redo覆盖一次编辑', () => {
    const { doc, board, rows } = seed(),
      before = doc.get(board)!.params
    const draft = workbenchDraft(doc, board, 'one')!
    let updates = 0
    const count = () => updates++
    doc.ydoc.on('update', count)
    expect(applyWorkbenchDraft(doc, board, draft)).toBe(true)
    expect(updates).toBe(0)
    doc.ydoc.off('update', count)
    draft.values.motionPrompt = '@角色 新动作'
    doc.undo.clear()
    expect(applyWorkbenchDraft(doc, board, draft)).toBe(true)
    const after = doc.get(board)!.params!,
      shots = after.shots as typeof rows
    expect(shots[0]).toEqual({ ...rows[0], motionPrompt: '@角色 新动作', edited: true })
    expect(shots[1]).toEqual(rows[1])
    expect(after.model).toBe('keep/model')
    expect(after.manualExtra).toBe('保留参数')
    doc.undo.undo()
    expect(doc.get(board)!.params).toEqual(before)
    doc.undo.redo()
    expect(doc.get(board)!.params).toEqual(after)
  })
  it('协作者更改本镜拒绝覆盖；改其他镜头保持其最新值，同镜号另一分镜不串写', () => {
    const { doc, board, rows } = seed(),
      draft = workbenchDraft(doc, board, 'one')!
    const identical = createElement(
      doc,
      node({ nodeType: 'plein/storyboard', params: { shots: rows } }),
    )
    expect(applyWorkbenchDraft(doc, identical, draft)).toBe(false)
    draft.values.description = '本镜新稿'
    setParam(doc, board, 'shots', [rows[0], { ...rows[1], description: '协作新镜二' }])
    expect(applyWorkbenchDraft(doc, board, draft)).toBe(true)
    expect((doc.get(board)!.params!.shots as typeof rows)[1]!.description).toBe('协作新镜二')
    const stale = workbenchDraft(doc, board, 'one')!
    const latest = doc.get(board)!.params!.shots as typeof rows
    setParam(doc, board, 'shots', [{ ...latest[0], lighting: '协作光影' }, latest[1]])
    const before = doc.get(board)!.params
    expect(applyWorkbenchDraft(doc, board, stale)).toBe(false)
    expect(doc.get(board)!.params).toEqual(before)
    const other = createElement(
      doc,
      node({ nodeType: 'plein/storyboard', params: { shots: rows } }),
    )
    expect(applyWorkbenchDraft(doc, other, workbenchDraft(doc, board, 'one')!)).toBe(false)
    expect(doc.get(other)!.params!.shots).toEqual(rows)
  })
  it('只读、删除和重复镜头身份不写入；旧项目可用缺省字段独立编辑', () => {
    const { doc, board, rows } = seed(),
      draft = workbenchDraft(doc, board, 'one')!
    doc.readOnly = true
    expect(applyWorkbenchDraft(doc, board, draft)).toBe(false)
    doc.readOnly = false
    setParam(doc, board, 'shots', [rows[0], rows[0]])
    expect(workbenchDraft(doc, board, 'one')).toBeUndefined()
    expect(applyWorkbenchDraft(doc, board, draft)).toBe(false)
    setParam(doc, board, 'shots', [{ id: 'one', no: 1, description: '旧项目' }])
    const legacy = workbenchDraft(doc, board, 'one')!
    legacy.values.lighting = '新光影'
    expect(applyWorkbenchDraft(doc, board, legacy)).toBe(true)
    expect((doc.get(board)!.params!.shots as Array<Record<string, unknown>>)[0]).not.toHaveProperty(
      'imagePrompt',
    )
    deleteElements(doc, [board])
    expect(workbenchDraft(doc, board, 'one')).toBeUndefined()
    expect(applyWorkbenchDraft(doc, board, legacy)).toBe(false)
  })
  it('实际连线下游闭包含序列且循环不重复，不把同名或未连节点算影响', () => {
    const { doc } = seed(),
      a = createElement(doc, node()),
      b = createElement(doc, node()),
      sequence = createElement(doc, node({ nodeType: 'plein/sequence' }))
    const external = createElement(doc, node({ name: '同名' }))
    expect(connect(doc, [a, 'out'], [b, 'in'])).toBeTruthy()
    expect(connect(doc, [b, 'out'], [sequence, 'in'])).toBeTruthy()
    expect(connect(doc, [sequence, 'out'], [a, 'in'])).toBeTruthy()
    expect(workbenchDownstream(doc, [a])).toEqual([b, sequence])
    expect(workbenchDownstream(doc, [a])).not.toContain(external)
  })
})
