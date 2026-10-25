import * as Y from 'yjs'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { adoptResult, connect, createElement, ReadOnlyDocError, setParam } from './commands'
import { openDoc, node } from './testing'
import { createDoc, type PleinDoc } from './doc'
import { exportElements, importElements } from './clipboard'
import {
  confirmProductionContent,
  currentProductionConfirmation,
  productionContentSnapshot,
  productionMapOf,
} from './production'
import { SCHEMA_VERSION } from './migrate'
import { captureSourceSnapshot } from './source-map'
import {
  appendShotPlan,
  continuityAssets,
  continuityContentSnapshot,
  continuityDependencies,
  continuityDependents,
  continuityOf,
  copyContinuity,
  currentContinuityObservations,
  currentShotPlan,
  emptyShotPlan,
  recordContinuityObservation,
  registerContinuitySubject,
  resolvedShotState,
  shotPlanHeads,
  updateShotIntent,
  type ContinuityObservation,
  type ShotPlanContent,
} from './continuity'

const docs: PleinDoc[] = []
const open = (raw?: Y.Doc) => {
  const doc = openDoc(raw)
  docs.push(doc)
  return doc
}
afterEach(() => {
  for (const doc of docs.splice(0)) doc.destroy()
})
function setup() {
  const doc = open()
  const shots = [
    { id: 'action-continuity-1', no: 1, description: '桌前右手拿起红信封' },
    { id: 'action-continuity-2', no: 2, description: '右手持信封朝门口走' },
  ]
  const boardId = createElement(
    doc,
    node({
      nodeType: 'plein/storyboard',
      ports: { inputs: [{ id: 'script', label: '剧本', type: 'text' }], outputs: [] },
      params: { shots },
    }),
  )
  const scope = { canvasId: 'canvas', boardId }
  const courier = registerContinuitySubject(doc, { scope, kind: 'character', label: '快递员' })!
  const envelope = registerContinuitySubject(doc, { scope, kind: 'prop', label: '红信封' })!
  const video = createElement(
    doc,
    node({
      nodeType: 'plein/video',
      ports: { inputs: [], outputs: [{ id: 'video', label: '视频', type: 'video' }] },
      params: { source: { storyboard: boardId, shot: shots[0]!.id, role: 'video' } },
      results: [
        {
          id: 'result-one',
          runId: 'run',
          port: 'video',
          value: { type: 'video', assetId: 'a'.repeat(64) },
          at: 1,
        },
      ],
    }),
  )
  return { doc, shots, boardId, scope, courier, envelope, video }
}
type Fixture = ReturnType<typeof setup>
const plan = (
  f: Fixture,
  shotId = f.shots[0]!.id,
  content: ShotPlanContent = {
    ...emptyShotPlan(),
    intent: '拿起红信封建立交接',
    end: {
      [f.courier]: { worldPosition: '桌边', screenPosition: '画面右侧', pose: '起身' },
      [f.envelope]: { holder: { subjectId: f.courier, hand: 'right' }, condition: '红色、完整' },
    },
  },
) =>
  appendShotPlan(f.doc, {
    scope: f.scope,
    shotId,
    expectedHeads: shotPlanHeads(continuityOf(f.doc, f.boardId), shotId).map((p) => p.id),
    content,
    userId: 'alice',
  })!
const observe = (f: Fixture, patch: Partial<Omit<ContinuityObservation, 'id' | 'at'>> = {}) =>
  recordContinuityObservation(f.doc, {
    scope: f.scope,
    shotId: f.shots[0]!.id,
    phase: 'end',
    nodeId: f.video,
    target: { kind: 'video', assetId: 'a'.repeat(64), resultId: 'result-one' },
    evidence: { kind: 'frame', position: 'end', frameAssetId: 'f'.repeat(64), aspects: ['visual'] },
    states: { [f.envelope]: { condition: { certainty: 'unknown', note: '末帧无法判断是否破损' } } },
    origin: { kind: 'manual', userId: 'alice' },
    ...patch,
  })

describe('可选计划与独立候选观察', () => {
  it('所引主体被撤销后保持缺失，不借同名角色补上holder身份', () => {
    const f = setup(),
      first = plan(f)
    const second = plan(f, f.shots[1]!.id, {
      ...emptyShotPlan(),
      inherits: [
        {
          fromShotId: first.shotId,
          planRevisionId: first.id,
          subjectId: f.envelope,
          fields: ['holder'],
        },
      ],
    })
    registerContinuitySubject(f.doc, { scope: f.scope, kind: 'character', label: '快递员' })
    const map = productionMapOf(f.doc, f.boardId)!.get('continuity') as Y.Map<unknown>
    ;(map.get('subjects') as Y.Map<unknown>).delete(f.courier)
    expect(resolvedShotState(continuityOf(f.doc, f.boardId), second).missing).toHaveLength(1)
    expect(continuityDependencies(continuityOf(f.doc, f.boardId), second.shotId)[0]!.status).toBe(
      'missing',
    )
    expect(
      observe(f, {
        states: {
          [f.envelope]: {
            holder: { certainty: 'observed', value: { subjectId: f.courier, hand: 'right' } },
          },
        },
      }),
    ).toBeUndefined()
  })
  it('非空P05来源快照的schema9确认在空continuity迁移后逐字不变', () => {
    const f = setup()
    const source = createElement(
      f.doc,
      node({
        nodeType: 'plein/text',
        params: { text: '递出红信封' },
        ports: { inputs: [], outputs: [{ id: 'text', label: '文本', type: 'text' }] },
      }),
    )
    connect(f.doc, [source, 'text'], [f.boardId, 'script'])
    expect(
      captureSourceSnapshot(f.doc, f.boardId, {
        canvasId: 'canvas',
        elementId: source,
        port: 'text',
        expectedText: '递出红信封',
      }),
    ).toBeTruthy()
    const snapshot = productionContentSnapshot(f.doc.get(f.boardId))!
    expect(JSON.parse(snapshot)).toHaveProperty('sourceMap')
    confirmProductionContent(f.doc, {
      scope: f.scope,
      expectedSnapshot: snapshot,
      version: 'v1',
      userId: 'alice',
    })
    productionMapOf(f.doc, f.boardId)!.delete('continuity')
    f.doc.meta.set('schemaVersion', 9)
    const migrated = open(f.doc.ydoc)
    expect(productionContentSnapshot(migrated.get(f.boardId))).toBe(snapshot)
    expect(currentProductionConfirmation(migrated.get(f.boardId), 'canvas')).toBeTruthy()
  })

  it('源计划分支只改未引用字段时不向后镜扩散冲突', () => {
    const f = setup(),
      first = plan(f)
    const second = plan(f, f.shots[1]!.id, {
      ...emptyShotPlan(),
      inherits: [
        {
          fromShotId: first.shotId,
          planRevisionId: first.id,
          subjectId: f.envelope,
          fields: ['holder'],
        },
      ],
    })
    const raw = new Y.Doc()
    Y.applyUpdate(raw, Y.encodeStateAsUpdate(f.doc.ydoc))
    const peer = open(raw)
    plan(f, first.shotId, { ...first.content, intent: '修订镜头目的' })
    appendShotPlan(peer, {
      scope: f.scope,
      shotId: first.shotId,
      expectedHeads: [first.id],
      content: {
        ...first.content,
        end: {
          ...first.content.end,
          [f.envelope]: { ...first.content.end[f.envelope], condition: '破损' },
        },
      },
      userId: 'bob',
    })
    Y.applyUpdate(f.doc.ydoc, Y.encodeStateAsUpdate(raw))
    expect(currentShotPlan(continuityOf(f.doc, f.boardId), first.shotId).state).toBe('conflict')
    expect(continuityDependencies(continuityOf(f.doc, f.boardId), second.shotId)[0]!.status).toBe(
      'current',
    )
  })
  it('空schema10迁移保留旧内容确认；未使用主体和观察不改变内容，intent实际参与确认且不改description', () => {
    const f = setup()
    const before = productionContentSnapshot(f.doc.get(f.boardId))!
    confirmProductionContent(f.doc, {
      scope: f.scope,
      expectedSnapshot: before,
      version: 'v1',
      userId: 'alice',
    })
    productionMapOf(f.doc, f.boardId)!.delete('continuity')
    f.doc.meta.set('schemaVersion', 9)
    const upgraded = createDoc(f.doc.ydoc, { schedule: () => {} })
    docs.push(upgraded)
    expect(upgraded.schemaVersion).toBe(SCHEMA_VERSION)
    expect(productionContentSnapshot(upgraded.get(f.boardId))).toBe(before)
    expect(currentProductionConfirmation(upgraded.get(f.boardId), 'canvas')).toBeTruthy()
    const subject = registerContinuitySubject(upgraded, {
      scope: f.scope,
      kind: 'scene',
      label: '门口',
    })!
    expect(subject).toBeTruthy()
    expect(productionContentSnapshot(upgraded.get(f.boardId))).toBe(before)
    const empty = appendShotPlan(upgraded, {
      scope: f.scope,
      shotId: f.shots[0]!.id,
      expectedHeads: [],
      content: emptyShotPlan(),
      userId: 'alice',
    })!
    expect(productionContentSnapshot(upgraded.get(f.boardId))).toBe(before)
    expect(
      updateShotIntent(upgraded, {
        scope: f.scope,
        shotId: f.shots[0]!.id,
        expectedHeads: [empty.id],
        intent: '建立信封的持有者',
        userId: 'alice',
      }),
    ).toBeTruthy()
    expect(currentProductionConfirmation(upgraded.get(f.boardId), 'canvas')).toBeUndefined()
    expect(upgraded.get(f.boardId)!.params!.shots).toEqual(f.shots)
    expect(continuityContentSnapshot(continuityOf(upgraded, f.boardId))).toBeTruthy()
  })

  it('精确引用冻结版本，反打画面左右变化和未引用字段不误报，换手才提示真实依赖', () => {
    const f = setup(),
      first = plan(f)
    const second = plan(f, f.shots[1]!.id, {
      ...emptyShotPlan(),
      start: { [f.courier]: { screenPosition: '画面左侧' } },
      inherits: [
        {
          fromShotId: first.shotId,
          planRevisionId: first.id,
          subjectId: f.envelope,
          fields: ['holder'],
        },
        {
          fromShotId: first.shotId,
          planRevisionId: first.id,
          subjectId: f.courier,
          fields: ['worldPosition'],
        },
      ],
    })
    expect(
      resolvedShotState(continuityOf(f.doc, f.boardId), second).start[f.envelope]!.holder!.hand,
    ).toBe('right')
    plan(f, first.shotId, {
      ...first.content,
      intent: '目的修订',
      end: {
        ...first.content.end,
        [f.courier]: { ...first.content.end[f.courier], screenPosition: '画面左侧' },
        [f.envelope]: { ...first.content.end[f.envelope], condition: '局部破损' },
      },
    })
    expect(
      continuityDependencies(continuityOf(f.doc, f.boardId), second.shotId).every(
        (r) => r.status === 'current',
      ),
    ).toBe(true)
    plan(f, first.shotId, {
      ...first.content,
      end: {
        ...first.content.end,
        [f.envelope]: { holder: { subjectId: f.courier, hand: 'left' } },
      },
    })
    const issues = continuityDependents(continuityOf(f.doc, f.boardId), first.shotId)
    expect(issues.filter((r) => r.status === 'changed')).toHaveLength(1)
    expect(issues.find((r) => r.status === 'changed')!.changedFields).toEqual(['holder'])
    expect(issues.every((r) => r.toShotId === second.shotId)).toBe(true)
    expect(
      resolvedShotState(continuityOf(f.doc, f.boardId), second).start[f.envelope]!.holder!.hand,
    ).toBe('right')
  })

  it('reset移除当前继承但不偷带旧值；镜头删除显示引用缺失，历史计划保留', () => {
    const f = setup(),
      first = plan(f)
    const linked = plan(f, f.shots[1]!.id, {
      ...emptyShotPlan(),
      inherits: [
        {
          fromShotId: first.shotId,
          planRevisionId: first.id,
          subjectId: f.envelope,
          fields: ['holder'],
        },
      ],
    })
    expect(
      continuityDependencies(
        continuityOf(f.doc, f.boardId),
        linked.shotId,
        new Set([linked.shotId]),
      )[0]!.status,
    ).toBe('missing')
    const reset = plan(f, linked.shotId, {
      ...emptyShotPlan(),
      reset: { kind: 'time_jump', reason: '次日的独立场景' },
    })
    expect(resolvedShotState(continuityOf(f.doc, f.boardId), reset).start).toEqual({})
    expect(continuityDependents(continuityOf(f.doc, f.boardId), first.shotId)).toEqual([])
    expect(continuityOf(f.doc, f.boardId).plans.some((p) => p.id === linked.id)).toBe(true)
  })

  it('intent修改保留状态和引用，迟到heads不能覆盖新修订', () => {
    const f = setup(),
      first = plan(f)
    const intent = updateShotIntent(f.doc, {
      scope: f.scope,
      shotId: first.shotId,
      expectedHeads: [first.id],
      intent: '强调交接道具',
      userId: 'alice',
    })!
    expect(intent.content.end).toEqual(first.content.end)
    expect(intent.content.intent).toBe('强调交接道具')
    expect(
      updateShotIntent(f.doc, {
        scope: f.scope,
        shotId: first.shotId,
        expectedHeads: [first.id],
        intent: '迟到',
        userId: 'bob',
      }),
    ).toBeUndefined()
  })

  it('两端首次修订保留冲突heads，明确合并后唯一；本地撤销不删除远端记录', () => {
    const f = setup()
    const raw = new Y.Doc()
    Y.applyUpdate(raw, Y.encodeStateAsUpdate(f.doc.ydoc))
    const peer = open(raw)
    f.doc.undo.clear()
    peer.undo.clear()
    const a = plan(f)
    const b = appendShotPlan(peer, {
      scope: f.scope,
      shotId: a.shotId,
      expectedHeads: [],
      content: { ...a.content, intent: '另一个修订' },
      userId: 'bob',
    })!
    Y.applyUpdate(f.doc.ydoc, Y.encodeStateAsUpdate(raw))
    Y.applyUpdate(raw, Y.encodeStateAsUpdate(f.doc.ydoc))
    expect(currentShotPlan(continuityOf(f.doc, f.boardId), a.shotId).state).toBe('conflict')
    expect(currentShotPlan(continuityOf(f.doc, f.boardId), a.shotId).plan).toBeUndefined()
    expect(
      updateShotIntent(f.doc, {
        scope: f.scope,
        shotId: a.shotId,
        expectedHeads: [a.id, b.id],
        intent: '不允许隐式覆盖状态',
        userId: 'alice',
      }),
    ).toBeUndefined()
    const merged = plan(f, a.shotId, { ...a.content, intent: '人工选定的合并内容' })
    expect(new Set(merged.parents)).toEqual(new Set([a.id, b.id]))
    f.doc.undo.undo()
    expect(currentShotPlan(continuityOf(f.doc, f.boardId), a.shotId).state).toBe('conflict')
    f.doc.undo.undo()
    expect(currentShotPlan(continuityOf(f.doc, f.boardId), a.shotId).plan!.id).toBe(b.id)
    f.doc.undo.redo()
    f.doc.undo.redo()
    expect(currentShotPlan(continuityOf(f.doc, f.boardId), a.shotId).plan!.id).toBe(merged.id)
  })

  it('观察不参与内容签名，不替代creativeReview；换resultId即使同asset也不继承', () => {
    const f = setup()
    plan(f)
    const before = productionContentSnapshot(f.doc.get(f.boardId))
    const id = observe(f)!
    expect(id).toBeTruthy()
    expect(productionContentSnapshot(f.doc.get(f.boardId))).toBe(before)
    expect(f.doc.get(f.video)!.reviews).toBeUndefined()
    expect(currentContinuityObservations(f.doc, f.scope, f.shots[0]!.id)).toHaveLength(1)
    const map = f.doc.mutable(f.video)!
    const prior = f.doc.get(f.video)!.results![0]!
    map.set('results', [{ ...prior, id: 'new-result' }, prior])
    adoptResult(f.doc, f.video, 'new-result')
    expect(currentContinuityObservations(f.doc, f.scope, f.shots[0]!.id)).toEqual([])
    expect(continuityOf(f.doc, f.boardId).observations[0]!.id).toBe(id)
    expect(observe(f)).toBeUndefined()
    adoptResult(f.doc, f.video, 'result-one')
    expect(currentContinuityObservations(f.doc, f.scope, f.shots[0]!.id)).toHaveLength(1)
    setParam(f.doc, f.video, 'source', {
      storyboard: f.boardId,
      shot: f.shots[1]!.id,
      role: 'video',
    })
    expect(currentContinuityObservations(f.doc, f.scope, f.shots[0]!.id)).toEqual([])
  })

  it('静帧只允许visual，unknown不能夹带事实；区间要求真实播放声明，静音不确认声音', () => {
    const f = setup()
    expect(
      observe(f, {
        evidence: {
          kind: 'frame',
          position: 'end',
          frameAssetId: 'f',
          aspects: ['visual', 'motion'],
        } as never,
      }),
    ).toBeUndefined()
    expect(
      observe(f, {
        states: {
          [f.envelope]: { condition: { certainty: 'unknown', value: '完整', note: '' } as never },
        },
      }),
    ).toBeUndefined()
    const interval = {
      kind: 'interval' as const,
      start: 4,
      end: 5,
      duration: 5,
      aspects: ['motion'] as ['motion'],
      playback: { completed: true as const, audible: false },
      declared: true as const,
    }
    expect(observe(f, { evidence: interval })).toBeTruthy()
    expect(observe(f, { evidence: { ...interval, end: 6 } })).toBeUndefined()
    expect(
      observe(f, {
        evidence: { ...interval, playback: { completed: false, audible: true } } as never,
      }),
    ).toBeUndefined()
    expect(observe(f, { evidence: { ...interval, aspects: ['sound'] } })).toBeUndefined()
    expect(
      observe(f, {
        evidence: { kind: 'frame', position: 'end', frameAssetId: 'invalid', aspects: ['visual'] },
      }),
    ).toBeUndefined()
    for (const holderId of ['missing', f.envelope])
      expect(
        observe(f, {
          states: {
            [f.envelope]: {
              holder: { certainty: 'observed', value: { subjectId: holderId, hand: 'right' } },
            },
          },
        }),
      ).toBeUndefined()
    expect(
      observe(f, {
        states: {
          [f.courier]: {
            holder: { certainty: 'inferred', value: { subjectId: f.courier, hand: 'right' } },
          },
        },
      }),
    ).toBeUndefined()
    expect(
      observe(f, {
        states: {
          [f.envelope]: {
            holder: { certainty: 'observed', value: { subjectId: f.courier, hand: 'right' } },
          },
        },
      }),
    ).toBeTruthy()
  })

  it('同名主体不串身份；holder仅引用确切角色，外部来源不按名字重连', () => {
    const f = setup()
    const another = registerContinuitySubject(f.doc, {
      scope: f.scope,
      kind: 'character',
      label: '快递员',
    })!
    expect(another).not.toBe(f.courier)
    expect(
      appendShotPlan(f.doc, {
        scope: f.scope,
        shotId: f.shots[0]!.id,
        expectedHeads: [],
        userId: 'alice',
        content: {
          ...emptyShotPlan(),
          end: { [f.envelope]: { holder: { subjectId: 'missing', hand: 'right' } } },
        },
      }),
    ).toBeUndefined()
    expect(
      continuityOf(f.doc, f.boardId).subjects.filter((s) => s.label === '快递员'),
    ).toHaveLength(2)
  })

  it('复制映射主体、holder、版本引用；相同canvasId与候选也显式historical，资产证据保留', () => {
    const f = setup(),
      first = plan(f)
    plan(f, f.shots[1]!.id, {
      ...emptyShotPlan(),
      inherits: [
        {
          fromShotId: first.shotId,
          planRevisionId: first.id,
          subjectId: f.envelope,
          fields: ['holder'],
        },
      ],
    })
    observe(f)
    const original = continuityOf(f.doc, f.boardId)
    const copied = copyContinuity(original, new Map([[f.video, f.video]]))
    expect(copied.subjects[0]!.id).not.toBe(original.subjects[0]!.id)
    const next = copied.plans.find((p) => p.shotId === f.shots[1]!.id)!
    const prev = copied.plans.find((p) => p.shotId === f.shots[0]!.id)!
    expect(next.content.inherits[0]!.planRevisionId).toBe(prev.id)
    expect(
      resolvedShotState(copied, next).start[next.content.inherits[0]!.subjectId]!.holder!.subjectId,
    ).toBe(copied.subjects.find((s) => s.kind === 'character')!.id)
    expect(copied.observations[0]!.historical).toBe(true)
    expect(copied.observations[0]!.scope).toEqual(f.scope)
    expect(continuityAssets(copied).sort()).toEqual(['a'.repeat(64), 'f'.repeat(64)].sort())
    let ids: ReadonlyMap<string, string> = new Map()
    importElements(f.doc, exportElements(f.doc, [f.boardId, f.video]), {
      canvasId: 'canvas',
      onImport: (map) => {
        ids = map
      },
    })
    expect(continuityOf(f.doc, ids.get(f.boardId)!).observations[0]!.historical).toBe(true)
    expect(
      currentContinuityObservations(
        f.doc,
        { canvasId: 'canvas', boardId: ids.get(f.boardId)! },
        first.shotId,
      ),
    ).toEqual([])
  })

  it('未来schema与实时只读阻止计划、intent、主体和观察写入', () => {
    const f = setup()
    f.doc.meta.set('schemaVersion', SCHEMA_VERSION + 1)
    expect(() => plan(f)).toThrow(ReadOnlyDocError)
    expect(() =>
      updateShotIntent(f.doc, {
        scope: f.scope,
        shotId: f.shots[0]!.id,
        expectedHeads: [],
        intent: '',
        userId: 'alice',
      }),
    ).toThrow(ReadOnlyDocError)
    expect(() => observe(f)).toThrow(ReadOnlyDocError)
    expect(() =>
      registerContinuitySubject(f.doc, { scope: f.scope, kind: 'scene', label: '门口' }),
    ).toThrow(ReadOnlyDocError)
  })
})
