import * as Y from 'yjs'
import { describe, expect, it, vi } from 'vite-plus/test'
import {
  createElement,
  deleteElements,
  ReadOnlyDocError,
  setParam,
  updateElement,
} from './commands'
import { duplicateElements, exportElements, importElements } from './clipboard'
import { createDoc } from './doc'
import { SCHEMA_VERSION } from './migrate'
import {
  appendProductionDecision,
  confirmProductionContent,
  currentProductionConfirmation,
  currentProductionDecisions,
  productionContentSnapshot,
  productionMapOf,
  readProduction,
  selectProductionTarget,
} from './production'
import { node, openDoc } from './testing'

const shots = [{ id: 'shot-one', no: 1, description: '递出红信封', dialogue: [] }]
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const board = (doc = openDoc()) => ({
  doc,
  id: createElement(doc, node({ nodeType: 'plein/storyboard', params: { shots } })),
})
const confirm = (doc: ReturnType<typeof openDoc>, id: string, canvasId = 'canvas') =>
  confirmProductionContent(doc, {
    scope: { canvasId, boardId: id },
    expectedSnapshot: productionContentSnapshot(doc.get(id))!,
    version: 'v1',
    userId: 'alice',
  })

describe('production文档合同', () => {
  it('公开production完整快照与selection、历史记录和未知嵌套值隔离，显式命令仍可撤销重做', () => {
    const { doc, id } = board()
    confirm(doc, id)
    appendProductionDecision(doc, {
      scope: { canvasId: 'canvas', boardId: id },
      userId: 'alice',
      category: 'style',
      subject: '风格',
      value: '黑白',
    })
    selectProductionTarget(doc, id, { trialShotId: 'shot-one' })
    const map = productionMapOf(doc, id)!
    for (const key of ['confirmations', 'decisions']) {
      const records = map.get(key) as Y.Map<Record<string, unknown>>
      for (const [key, record] of records)
        records.set(key, { ...record, historical: true, extra: { values: ['原值', 7] } })
    }
    const emptyId = createElement(doc, node({ nodeType: 'plein/storyboard', params: { shots } }))
    doc.elementMaps.get(emptyId)!.delete('production')
    const empty = doc.get(emptyId)!
    const emptyJson = JSON.stringify(empty)
    const expected = clone(readProduction(map))
    const before = Y.encodeStateAsUpdate(doc.ydoc)
    doc.undo.clear()
    let updates = 0
    doc.ydoc.on('update', () => updates++)
    const cached = doc.get(id)!
    const replacement = clone(cached.production!)
    for (const record of [...replacement.confirmations, ...replacement.decisions])
      record.historical = false
    expect(Reflect.set(cached, 'production', replacement)).toBe(false)
    expect(Reflect.deleteProperty(cached, 'production')).toBe(false)
    expect(Object.getOwnPropertyDescriptor(cached, 'production')).toMatchObject({
      writable: false,
      configurable: false,
      enumerable: true,
    })
    expect(Reflect.set(empty, 'production', replacement)).toBe(false)
    expect(Reflect.deleteProperty(empty, 'production')).toBe(false)
    expect(empty.production).toBeUndefined()
    expect(Object.getOwnPropertyDescriptor(empty, 'production')).toMatchObject({
      writable: false,
      configurable: false,
      enumerable: false,
    })
    expect(JSON.stringify(empty)).toBe(emptyJson)
    for (const read of [readProduction(map)!, doc.get(id)!.production!]) {
      expect(Reflect.set(read, 'selection', { trialShotId: 'forged' })).toBe(false)
      expect(Reflect.set(read.selection!, 'trialShotId', 'forged')).toBe(false)
      expect(() => read.confirmations.pop()).toThrow(TypeError)
      expect(() => read.decisions.pop()).toThrow(TypeError)
      for (const record of [...read.confirmations, ...read.decisions]) {
        expect(Reflect.set(record, 'historical', false)).toBe(false)
        expect(Reflect.set(record, 'at', 999)).toBe(false)
        expect(Reflect.set(record.scope, 'canvasId', 'canvas')).toBe(false)
        expect(Reflect.set(record.actor, 'userId', 'forged')).toBe(false)
        const extra = record as unknown as { extra: { values: unknown[] } }
        expect(() => extra.extra.values.push('forged')).toThrow(TypeError)
      }
    }
    expect(readProduction(map)).toEqual(expected)
    expect(Y.encodeStateAsUpdate(doc.ydoc)).toEqual(before)
    expect(updates).toBe(0)
    expect(doc.undo.undoStack).toHaveLength(0)
    expect(currentProductionConfirmation(doc.get(id), 'canvas')).toBeUndefined()
    expect(currentProductionDecisions(doc.get(id), 'canvas')).toEqual([])
    expect(confirm(doc, id)).toBe(true)
    const current = currentProductionConfirmation(doc.get(id), 'canvas')!
    doc.undo.undo()
    expect(currentProductionConfirmation(doc.get(id), 'canvas')).toBeUndefined()
    doc.undo.redo()
    expect(currentProductionConfirmation(doc.get(id), 'canvas')?.id).toBe(current.id)
    expect(selectProductionTarget(doc, id, { trialShotId: undefined })).toBe(true)
    expect(doc.get(id)!.production!.selection).toEqual({})
    doc.destroy()
  })

  it('production创建和正式追加不保留调用方selection或scope未知嵌套对象的别名', () => {
    const { doc, id } = board()
    confirm(doc, id)
    const record = {
      ...clone(doc.get(id)!.production!),
      selection: { trialShotId: 'shot-one', extra: { values: ['selection-original'] } },
    }
    const created = createElement(
      doc,
      node({ nodeType: 'plein/storyboard', params: { shots }, production: record }),
    )
    const createdMap = productionMapOf(doc, created)!
    const createdBytes = Y.encodeStateAsUpdate(doc.ydoc)
    record.selection.extra.values.push('outside')
    record.confirmations[0]!.actor.userId = 'outside'
    expect((createdMap.get('selection') as Y.Map<unknown>).get('extra')).toEqual({
      values: ['selection-original'],
    })
    expect(doc.get(created)!.production!.confirmations[0]!.actor.userId).toBe('alice')
    expect(Y.encodeStateAsUpdate(doc.ydoc)).toEqual(createdBytes)
    for (const kind of ['confirm', 'decision']) {
      const scope = { canvasId: 'canvas', boardId: id, extra: { values: ['scope-original'] } }
      if (kind === 'confirm')
        expect(
          confirmProductionContent(doc, {
            scope,
            expectedSnapshot: productionContentSnapshot(doc.get(id))!,
            version: 'v2',
            userId: 'alice',
          }),
        ).toBe(true)
      else
        expect(
          appendProductionDecision(doc, {
            scope,
            userId: 'alice',
            category: 'style',
            subject: '风格',
            value: '暖色',
          }),
        ).toBe(true)
      const before = Y.encodeStateAsUpdate(doc.ydoc)
      scope.extra.values.push('outside')
      expect(Y.encodeStateAsUpdate(doc.ydoc)).toEqual(before)
      const state = doc.get(id)!.production!
      const saved = kind === 'confirm' ? state.confirmations.at(-1)! : state.decisions.at(-1)!
      expect(saved.scope).toMatchObject({ extra: { values: ['scope-original'] } })
    }
    doc.destroy()
  })

  it('完整内容与稳定范围绑定；改后恢复原稿可重新核对，不按同名或同镜号继承', () => {
    const { doc, id } = board()
    confirm(doc, id)
    const saved = currentProductionConfirmation(doc.get(id), 'canvas')!
    expect(saved.actor).toEqual({ source: 'ui', userId: 'alice' })
    expect(saved.snapshot).toBe(JSON.stringify(shots, ['description', 'dialogue', 'id', 'no']))
    expect(currentProductionConfirmation(doc.get(id), 'another')).toBeUndefined()
    setParam(doc, id, 'shots', [{ ...shots[0], description: '改为左手' }])
    expect(currentProductionConfirmation(doc.get(id), 'canvas')).toBeUndefined()
    expect(doc.get(id)?.production?.confirmations).toHaveLength(1)
    setParam(doc, id, 'shots', shots)
    expect(currentProductionConfirmation(doc.get(id), 'canvas')?.id).toBe(saved.id)
    deleteElements(doc, [id])
    const same = createElement(
      doc,
      node({ nodeType: 'plein/storyboard', name: '同名', params: { shots } }),
    )
    expect(currentProductionConfirmation(doc.get(same), 'canvas')).toBeUndefined()
    doc.destroy()
  })

  it('迟到确认、空身份、非分镜与异常镜头身份不能产生正式确认', () => {
    const { doc, id } = board()
    const snapshot = productionContentSnapshot(doc.get(id))!
    setParam(doc, id, 'shots', [{ ...shots[0], no: 2 }])
    expect(
      confirmProductionContent(doc, {
        scope: { canvasId: 'canvas', boardId: id },
        expectedSnapshot: snapshot,
        version: 'v1',
        userId: 'alice',
      }),
    ).toBe(false)
    expect(
      confirmProductionContent(doc, {
        scope: { canvasId: 'canvas', boardId: id },
        expectedSnapshot: productionContentSnapshot(doc.get(id))!,
        version: 'v1',
        userId: '',
      }),
    ).toBe(false)
    setParam(doc, id, 'shots', [shots[0], shots[0]])
    expect(productionContentSnapshot(doc.get(id))).toBeUndefined()
    setParam(doc, id, 'shots', [])
    expect(productionContentSnapshot(doc.get(id))).toBeUndefined()
    expect(confirm(doc, createElement(doc, node()))).toBe(false)
    doc.destroy()
  })

  it('生产元数据不进params；通用更新不能伪造正式确认', () => {
    const { doc, id } = board()
    const params = doc.get(id)!.params
    confirm(doc, id)
    appendProductionDecision(doc, {
      scope: { canvasId: 'canvas', boardId: id },
      userId: 'alice',
      category: 'model',
      subject: '视频',
      value: '保留当前模型',
    })
    selectProductionTarget(doc, id, { trialShotId: 'shot-one' })
    expect(doc.get(id)!.params).toEqual(params)
    const records = doc.get(id)!.production
    updateElement(doc, id, { production: { humanApproved: true } } as never)
    expect(doc.get(id)!.production).toEqual(records)
    expect(JSON.stringify(records)).not.toMatch(/token|execution|humanApproved/)
    doc.destroy()
  })

  it('各次决策独立追加，当前值按时间+ID选择；撤销重做只影响本地本次记录', () => {
    const { doc, id } = board()
    const input = {
      scope: { canvasId: 'canvas', boardId: id },
      userId: 'alice',
      category: 'style' as const,
      subject: '整体',
      value: '黑白',
    }
    appendProductionDecision(doc, input)
    const first = doc.get(id)!.production!.decisions[0]!
    doc.undo.clear()
    appendProductionDecision(doc, { ...input, value: '暖色', note: '更贴近剧本' })
    const second = currentProductionDecisions(doc.get(id), 'canvas')[0]!
    expect(second.value).toBe('暖色')
    expect(doc.get(id)!.production!.decisions[0]).toEqual(first)
    expect(doc.undo.undoStack).toHaveLength(1)
    doc.undo.undo()
    expect(currentProductionDecisions(doc.get(id), 'canvas')[0]!.value).toBe('黑白')
    doc.undo.redo()
    expect(currentProductionDecisions(doc.get(id), 'canvas')[0]!.id).toBe(second.id)
    expect(currentProductionDecisions(doc.get(id), 'new-canvas')).toEqual([])
    doc.destroy()
  })

  it('同毫秒追加确认和决策保持本地修订顺序，时间相同时按ID跨端确定', () => {
    const { doc, id } = board()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(100)
    try {
      confirm(doc, id)
      confirmProductionContent(doc, {
        scope: { canvasId: 'canvas', boardId: id },
        expectedSnapshot: productionContentSnapshot(doc.get(id))!,
        version: 'v2',
        userId: 'bob',
      })
      expect(currentProductionConfirmation(doc.get(id), 'canvas')).toMatchObject({
        at: 101,
        version: 'v2',
        actor: { userId: 'bob' },
      })
      const map = productionMapOf(doc, id)!.get('decisions') as Y.Map<unknown>
      const common = {
        scope: { canvasId: 'canvas', boardId: id },
        category: 'style',
        subject: '整体',
        note: '',
        actor: { userId: 'alice', source: 'ui' },
        at: 102,
      }
      map.set('z', { ...common, id: 'z', value: 'z' })
      map.set('a', { ...common, id: 'a', value: 'a' })
      expect(currentProductionDecisions(doc.get(id), 'canvas')[0]!.value).toBe('z')
    } finally {
      clock.mockRestore()
      doc.destroy()
    }
  })

  it('确认和代表镜头选择各自是一步撤销；重开保留相同记录身份', () => {
    const { doc, id } = board()
    doc.undo.clear()
    confirm(doc, id)
    const saved = doc.get(id)!.production!.confirmations[0]!
    selectProductionTarget(doc, id, { trialShotId: 'shot-one', sequenceId: 'sequence' })
    expect(doc.undo.undoStack).toHaveLength(2)
    doc.undo.undo()
    expect(doc.get(id)!.production!.selection).toEqual({})
    doc.undo.undo()
    expect(currentProductionConfirmation(doc.get(id), 'canvas')).toBeUndefined()
    doc.undo.redo()
    doc.undo.redo()
    const reopened = openDoc(doc.ydoc)
    expect(currentProductionConfirmation(reopened.get(id), 'canvas')).toEqual(saved)
    expect(reopened.get(id)!.production!.selection!.trialShotId).toBe('shot-one')
    reopened.destroy()
    doc.destroy()
  })

  it('两个客户端首次并发追加分别保留；确定性顺序且不覆盖其他客户端记录', () => {
    const { doc: a, id } = board()
    const raw = new Y.Doc()
    Y.applyUpdate(raw, Y.encodeStateAsUpdate(a.ydoc))
    const b = openDoc(raw)
    a.undo.clear()
    b.undo.clear()
    confirm(a, id)
    confirm(b, id)
    const input = {
      scope: { canvasId: 'canvas', boardId: id },
      userId: 'alice',
      category: 'style' as const,
      subject: '整体',
      value: 'a',
    }
    appendProductionDecision(a, input)
    appendProductionDecision(b, { ...input, userId: 'bob', value: 'b' })
    Y.applyUpdate(a.ydoc, Y.encodeStateAsUpdate(b.ydoc), 'remote')
    Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc), 'remote')
    expect(a.get(id)!.production!.confirmations).toHaveLength(2)
    expect(a.get(id)!.production!.decisions).toHaveLength(2)
    expect(currentProductionDecisions(a.get(id), 'canvas')).toEqual(
      currentProductionDecisions(b.get(id), 'canvas'),
    )
    a.undo.undo()
    expect(a.get(id)!.production!.decisions).toHaveLength(1)
    expect(a.get(id)!.production!.decisions[0]!.actor.userId).toBe('bob')
    a.destroy()
    b.destroy()
  })

  it('复制和模板导入显式保存历史；仅内部序列ID映射，外部选择不按名字重绑', () => {
    const { doc, id } = board()
    const sequence = createElement(doc, { kind: 'sequence', x: 0, y: 0, w: 100, h: 100 })
    confirm(doc, id)
    appendProductionDecision(doc, {
      scope: { canvasId: 'canvas', boardId: id },
      userId: 'alice',
      category: 'model',
      subject: '画面',
      value: '模型A',
    })
    selectProductionTarget(doc, id, { trialShotId: 'shot-one', sequenceId: sequence })
    const [copy, copiedSequence] = duplicateElements(doc, [id, sequence])
    const production = doc.get(copy!)!.production!
    expect(production.selection).toEqual({ trialShotId: 'shot-one', sequenceId: copiedSequence })
    expect(production.confirmations[0]).toMatchObject({
      historical: true,
      scope: { canvasId: 'canvas', boardId: id },
    })
    expect(production.decisions[0]!.historical).toBe(true)
    expect(currentProductionConfirmation(doc.get(copy!), 'canvas')).toBeUndefined()
    // 即使把历史放回原身份与相同内容，也不重新激活。
    const originalMap = productionMapOf(doc, id)!.get('confirmations') as Y.Map<unknown>
    const old = production.confirmations[0]!
    originalMap.set(old.id, old)
    expect(currentProductionConfirmation(doc.get(id), 'canvas')).toBeUndefined()
    const destination = openDoc()
    const [imported] = importElements(destination, exportElements(doc, [id]))
    expect(destination.get(imported!)!.production!.selection).toEqual({ trialShotId: 'shot-one' })
    expect(currentProductionDecisions(destination.get(imported!), 'canvas')).toEqual([])
    destination.destroy()
    doc.destroy()
  })

  it('v6迁移仅创建空生产结构，未来版本与实时升级阻止写入', () => {
    const { doc, id } = board()
    doc.elementMaps.get(id)!.delete('production')
    doc.meta.set('schemaVersion', 6)
    const upgraded = createDoc(doc.ydoc, { schedule: () => {} })
    expect(upgraded.schemaVersion).toBe(SCHEMA_VERSION)
    expect(upgraded.get(id)!.production).toEqual({
      selection: {},
      confirmations: [],
      decisions: [],
    })
    upgraded.meta.set('schemaVersion', SCHEMA_VERSION + 1)
    expect(() => confirm(upgraded, id)).toThrow(ReadOnlyDocError)
    expect(() => selectProductionTarget(upgraded, id, { trialShotId: 'shot-one' })).toThrow(
      ReadOnlyDocError,
    )
    expect(() =>
      appendProductionDecision(upgraded, {
        scope: { canvasId: 'canvas', boardId: id },
        userId: 'alice',
        category: 'style',
        subject: '整体',
        value: '冷色',
      }),
    ).toThrow(ReadOnlyDocError)
    upgraded.destroy()
    doc.destroy()
  })
})
