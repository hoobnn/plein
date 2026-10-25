import * as Y from 'yjs'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { createElement, deleteElements, ReadOnlyDocError, updateElement } from './commands'
import { exportElements, importElements } from './clipboard'
import { createDoc, type PleinDoc } from './doc'
import { SCHEMA_VERSION } from './migrate'
import {
  confirmProductionContent,
  currentProductionConfirmation,
  productionContentSnapshot,
  productionMapOf,
} from './production'
import {
  appendProductionGoal,
  emptyProductionGoal,
  isProductionGoal,
  productionGoalHeads,
  productionGoalSnapshot,
  remapProductionGoalScopes,
} from './production-goal'
import { node } from './testing'

const docs: PleinDoc[] = []
const open = (raw?: Y.Doc) => {
  const doc = createDoc(raw, { schedule: () => {} })
  docs.push(doc)
  return doc
}
afterEach(() => {
  for (const doc of docs.splice(0)) doc.destroy()
})
const seed = () => {
  const doc = open()
  const boardId = createElement(
    doc,
    node({
      nodeType: 'plein/storyboard',
      params: { shots: [{ id: 'shot', description: '画面' }] },
    }),
  )
  const sequenceId = createElement(doc, node({ nodeType: 'plein/sequence', name: '成片' }))
  return { doc, boardId, sequenceId, scope: { canvasId: 'canvas', boardId, sequenceId } }
}
const goal = (requirements = '交接动作可辨认') => ({
  ...emptyProductionGoal(),
  aspectRatio: '9:16' as const,
  duration: { min: 8, max: 12 },
  requirements,
})

describe('制作目标版本', () => {
  it('目标完整不可变，规范快照独立于分镜确认和生成参数；同毫秒与重开均保留身份', () => {
    const { doc, boardId, scope } = seed()
    const params = doc.get(boardId)!.params
    const snapshot = productionContentSnapshot(doc.get(boardId))!
    confirmProductionContent(doc, {
      scope,
      expectedSnapshot: snapshot,
      version: 'v1',
      userId: 'alice',
    })
    const content = goal()
    const first = appendProductionGoal(doc, { scope, content, expectedHeads: [], userId: 'alice' })!
    content.requirements = '外部修改'
    const second = appendProductionGoal(doc, {
      scope,
      content: goal('保留风声'),
      expectedHeads: [first.id],
      userId: 'bob',
    })!
    expect(doc.get(boardId)!.production!.goals![0]!.content.requirements).toBe('交接动作可辨认')
    expect(second.at).toBeGreaterThan(first.at)
    expect(productionGoalHeads(doc.get(boardId), scope)).toEqual([second])
    expect(doc.get(boardId)!.params).toEqual(params)
    expect(productionContentSnapshot(doc.get(boardId))).toBe(snapshot)
    expect(currentProductionConfirmation(doc.get(boardId), 'canvas')).toBeDefined()
    expect(productionGoalSnapshot({ ...goal(), token: 'never' } as never)).not.toContain('never')
    expect(open(doc.ydoc).get(boardId)!.production!.goals).toEqual([first, second])
    first.content.requirements = '返回对象也不能改写历史'
    const read = doc.get(boardId)!.production!.goals!
    expect(() => {
      read[0]!.content.requirements = '读取对象不能改写历史'
    }).toThrow()
    expect(doc.get(boardId)!.production!.goals![0]!.content.requirements).toBe('交接动作可辨认')
  })

  it('范围按画布、分镜、序列精确匹配；不把同名新序列或其他序列的目标借过来', () => {
    const { doc, boardId, sequenceId, scope } = seed()
    const saved = appendProductionGoal(doc, {
      scope,
      content: goal(),
      expectedHeads: [],
      userId: 'alice',
    })!
    expect(productionGoalHeads(doc.get(boardId), { ...scope, canvasId: 'other' })).toEqual([])
    expect(productionGoalHeads(doc.get(boardId), { canvasId: 'canvas', boardId })).toEqual([])
    deleteElements(doc, [sequenceId])
    const replacement = createElement(doc, node({ nodeType: 'plein/sequence', name: '成片' }))
    expect(productionGoalHeads(doc.get(boardId), { ...scope, sequenceId: replacement })).toEqual([])
    expect(
      appendProductionGoal(doc, {
        scope,
        content: goal(),
        expectedHeads: [saved.id],
        userId: 'alice',
      }),
    ).toBeUndefined()
  })

  it('迟到保存和非法输入拒绝；高版本实时只读不能写入', () => {
    const { doc, boardId, scope } = seed()
    const input = { scope, content: goal(), expectedHeads: [], userId: 'alice' }
    expect(isProductionGoal({ ...goal(), duration: { min: 12, max: 2 } })).toBe(false)
    expect(isProductionGoal({ ...goal(), duration: { min: NaN } })).toBe(false)
    expect(isProductionGoal({ ...goal(), requirements: 'x'.repeat(4001) })).toBe(false)
    expect(appendProductionGoal(doc, { ...input, userId: '' })).toBeUndefined()
    expect(appendProductionGoal(doc, input)).toBeDefined()
    expect(appendProductionGoal(doc, input)).toBeUndefined()
    updateElement(doc, boardId, { production: { goals: [] } } as never)
    expect(doc.get(boardId)!.production!.goals).toHaveLength(1)
    doc.meta.set('schemaVersion', SCHEMA_VERSION + 1)
    expect(() => appendProductionGoal(doc, input)).toThrow(ReadOnlyDocError)
    expect(doc.get(boardId)!.production!.goals).toHaveLength(1)
  })

  it('撤销重做一份修订，不覆盖此前版本', () => {
    const { doc, boardId, scope } = seed()
    const first = appendProductionGoal(doc, {
      scope,
      content: goal(),
      expectedHeads: [],
      userId: 'alice',
    })!
    doc.undo.clear()
    const second = appendProductionGoal(doc, {
      scope,
      content: goal('暖色'),
      expectedHeads: [first.id],
      userId: 'alice',
    })!
    expect(doc.undo.undoStack).toHaveLength(1)
    doc.undo.undo()
    expect(productionGoalHeads(doc.get(boardId), scope)).toEqual([first])
    doc.undo.redo()
    expect(productionGoalHeads(doc.get(boardId), scope)).toEqual([second])
  })

  it('离线并发修订不丢失、不混合；显式合并后才产生唯一当前目标', () => {
    const { doc: a, boardId, scope } = seed()
    const first = appendProductionGoal(a, {
      scope,
      content: goal(),
      expectedHeads: [],
      userId: 'alice',
    })!
    const raw = new Y.Doc()
    Y.applyUpdate(raw, Y.encodeStateAsUpdate(a.ydoc))
    const b = open(raw)
    const left = appendProductionGoal(a, {
      scope,
      content: goal('左稿'),
      expectedHeads: [first.id],
      userId: 'alice',
    })!
    const right = appendProductionGoal(b, {
      scope,
      content: goal('右稿'),
      expectedHeads: [first.id],
      userId: 'bob',
    })!
    Y.applyUpdate(a.ydoc, Y.encodeStateAsUpdate(b.ydoc), 'remote')
    Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc), 'remote')
    expect(
      productionGoalHeads(a.get(boardId), scope)
        .map((r) => r.id)
        .sort(),
    ).toEqual([left.id, right.id].sort())
    expect(productionGoalHeads(b.get(boardId), scope)).toEqual(
      productionGoalHeads(a.get(boardId), scope),
    )
    expect(
      appendProductionGoal(a, {
        scope,
        content: goal('迟到'),
        expectedHeads: [left.id],
        userId: 'alice',
      }),
    ).toBeUndefined()
    const merged = appendProductionGoal(a, {
      scope,
      content: goal('人工合并'),
      expectedHeads: [left.id, right.id],
      userId: 'alice',
    })!
    expect([...merged.parents].sort()).toEqual([left.id, right.id].sort())
    expect(productionGoalHeads(a.get(boardId), scope)).toEqual([merged])
  })

  it('复制与模板将内部范围映射到新身份，原始来源保留；外部序列或未知目标画布仅为历史', () => {
    const { doc, boardId, sequenceId, scope } = seed()
    const first = appendProductionGoal(doc, {
      scope,
      content: goal(),
      expectedHeads: [],
      userId: 'alice',
    })!
    const data = exportElements(doc, [boardId, sequenceId])
    const target = open()
    const [copy, copiedSequence] = importElements(target, data, { canvasId: 'destination' })
    const newScope = { canvasId: 'destination', boardId: copy!, sequenceId: copiedSequence }
    const [current] = productionGoalHeads(target.get(copy!), newScope)
    expect(current).toMatchObject({ scope: newScope, origin: { id: first.id, scope } })
    expect(current!.id).not.toBe(first.id)
    expect(current!.snapshot).toBe(first.snapshot)
    const [external] = importElements(target, exportElements(doc, [boardId]), {
      canvasId: 'destination',
    })
    expect(target.get(external!)!.production!.goals![0]!.historical).toBe(true)
    const [unknown] = importElements(target, data)
    expect(target.get(unknown!)!.production!.goals![0]!.historical).toBe(true)
  })

  it('包范围映射只修改类型化身份，内容和历史来源不重写；修订链也映射', () => {
    const { doc, boardId, scope } = seed()
    const a = appendProductionGoal(doc, {
      scope,
      content: goal('canvas'),
      expectedHeads: [],
      userId: 'alice',
    })!
    appendProductionGoal(doc, {
      scope,
      content: goal('第二版'),
      expectedHeads: [a.id],
      userId: 'alice',
    })
    const copied = remapProductionGoalScopes(
      doc.get(boardId)!.production!.goals!,
      new Map([['canvas', 'new-canvas']]),
    )
    expect(copied[1]!.parents).toEqual([copied[0]!.id])
    expect(copied[0]).toMatchObject({
      scope: { ...scope, canvasId: 'new-canvas' },
      content: { requirements: 'canvas' },
      origin: { id: a.id, scope },
    })
  })

  it('v7迁移建立共同空子Map；不制造目标或确认，未来版本不写迁移', () => {
    const { doc, boardId } = seed()
    productionMapOf(doc, boardId)!.delete('goals')
    doc.meta.set('schemaVersion', 7)
    const upgraded = open(doc.ydoc)
    expect(upgraded.schemaVersion).toBe(SCHEMA_VERSION)
    expect(productionMapOf(upgraded, boardId)!.get('goals')).toBeInstanceOf(Y.Map)
    expect(upgraded.get(boardId)!.production!.goals).toBeUndefined()
    upgraded.meta.set('schemaVersion', SCHEMA_VERSION + 1)
    productionMapOf(upgraded, boardId)!.delete('goals')
    const future = open(upgraded.ydoc)
    expect(future.readOnly).toBe(true)
    expect(productionMapOf(future, boardId)!.has('goals')).toBe(false)
  })
})
