import {
  appendProductionGoal,
  createElement,
  emptyProductionGoal,
  selectProductionTarget,
  type PleinDoc,
} from '@plein/doc'
import { openDoc } from '@plein/doc/testing'
import { afterEach, expect, it } from 'vite-plus/test'
import { goalDurationCheck } from './productionGoalScope'

const docs: PleinDoc[] = []
afterEach(() => docs.splice(0).forEach((doc) => doc.destroy()))
function fixture() {
  const doc = openDoc()
  docs.push(doc)
  const board = (name: string) =>
    createElement(doc, {
      kind: 'node',
      nodeType: 'plein/storyboard',
      name,
      params: { shots: [] },
      x: 0,
      y: 0,
      w: 200,
      h: 100,
    })
  const save = (boardId: string, duration: { min?: number; max?: number }) =>
    appendProductionGoal(doc, {
      scope: { canvasId: 'c', boardId },
      expectedHeads: [],
      content: { ...emptyProductionGoal(), duration },
      userId: 'alice',
    })!
  return { doc, a: board('A'), b: board('B'), save }
}

it('只比较本表的唯一当前目标，多分镜表不混算', () => {
  const f = fixture()
  expect(goalDurationCheck(f.doc, 'c', f.a, 30).state).toBe('missing')
  f.save(f.a, { min: 40, max: 60 })
  expect(goalDurationCheck(f.doc, 'c', f.a, 30)).toEqual({ state: 'short', min: 40, max: 60 })
  expect(goalDurationCheck(f.doc, 'c', f.a, 50).state).toBe('within')
  expect(goalDurationCheck(f.doc, 'c', f.a, 61).state).toBe('long')
  expect(goalDurationCheck(f.doc, 'c', f.b, 30).state).toBe('missing')
  expect(goalDurationCheck(f.doc, 'other', f.a, 30).state).toBe('missing')
})

it('目标未限时长或序列选择失效时说明原因而不比较', () => {
  const f = fixture()
  f.save(f.a, {})
  expect(goalDurationCheck(f.doc, 'c', f.a, 30).state).toBe('unbounded')
  selectProductionTarget(f.doc, f.a, { sequenceId: 'removed-sequence' })
  expect(goalDurationCheck(f.doc, 'c', f.a, 30).state).toBe('unscoped')
})
