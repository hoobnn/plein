import { Shot } from '@plein/nodes'
import { expect, it } from 'vite-plus/test'
import { restoreStoryboardRow, storyboardDataProblem } from './dataRecovery'

it('只恢复坏行的无效字段，不过滤行、不注入其他默认值或丢扩展字段', () => {
  const good = { id: 'one', no: 1, description: '保留' }
  const bad = { id: 'two', no: 2, duration: -1, lighting: '晨光', custom: { keep: 1 } }
  const raw = [good, bad]
  expect(storyboardDataProblem(raw)).toMatchObject({
    kind: 'rows',
    count: 2,
    rows: [{ index: 1, fields: ['duration'], labels: ['时长'] }],
  })
  const fixed = restoreStoryboardRow(raw, 1)!
  expect(fixed).toEqual([good, { ...bad, duration: 5 }])
  expect(fixed[0]).toBe(good)
  expect(raw).toEqual([good, bad])
  expect(restoreStoryboardRow(fixed, 1)).toBeUndefined()
})

it('有效或缺省列表不在读取时填默认值，坏容器必须显式整体重置', () => {
  expect(storyboardDataProblem(undefined)).toBeNull()
  expect(storyboardDataProblem([])).toBeNull()
  expect(storyboardDataProblem([{ id: 'one', no: 1 }])).toBeNull()
  for (const raw of [null, 'broken', {}]) {
    expect(storyboardDataProblem(raw)).toEqual({ kind: 'list' })
    expect(restoreStoryboardRow(raw, 0)).toBeUndefined()
  }
})

it('列表中的稀疏空行也会报告，不能被当作不存在的镜头', () => {
  const raw: unknown[] = []
  raw.length = 2
  raw[0] = { id: 'one', no: 1 }
  expect(storyboardDataProblem(raw)).toMatchObject({
    kind: 'rows',
    rows: [{ index: 1, replace: true }],
  })
  const fixed = restoreStoryboardRow(raw, 1)!
  expect(fixed).toHaveLength(2)
  expect(Shot.safeParse(fixed[1]).success).toBe(true)
  expect(Object.hasOwn(raw, 1)).toBe(false)
})

it('重复和空标识只修复后续冲突行，保留原镜头及其旧标识', () => {
  const raw = [
    { id: 'same', no: 1 },
    { id: 'same', no: 2, description: '保留重复行正文' },
    { id: '', no: 3 },
  ]
  expect(storyboardDataProblem(raw)).toMatchObject({
    kind: 'rows',
    rows: [
      { index: 1, fields: ['id'] },
      { index: 2, fields: ['id'] },
    ],
  })
  const second = restoreStoryboardRow(raw, 1)!
  expect(second[0]).toEqual(raw[0])
  expect(second[1]).toMatchObject({ no: 2, description: '保留重复行正文' })
  const fixed = restoreStoryboardRow(second, 2)! as Array<{ id: string }>
  expect(new Set(fixed.map((s) => s.id)).size).toBe(3)
  expect(storyboardDataProblem(fixed)).toBeNull()
  expect(raw[1]!.id).toBe('same')
})

it('无效嵌套列表和可选绑定仅重置对应顶层字段，其余台词及内容保留', () => {
  const good = { id: 'one', no: 1, dialogue: [{ character: '甲', line: '原台词' }] }
  const bad = {
    id: 'two',
    no: 2,
    dialogue: [{ character: '乙', line: 7 }],
    assetBindings: { 甲: { elementId: 0 } },
    description: '保留画面',
  }
  const fixed = restoreStoryboardRow([good, bad], 1)!
  expect(fixed).toEqual([good, { id: 'two', no: 2, dialogue: [], description: '保留画面' }])
  expect(Shot.safeParse(fixed[1]).success).toBe(true)
})

it('整行损坏可以恢复为空镜头，不复用其他镜头的编号或标识', () => {
  const raw = [{ id: 'one', no: 2 }, null]
  const fixed = restoreStoryboardRow(raw, 1)! as Array<Record<string, unknown>>
  expect(fixed[0]).toEqual(raw[0])
  expect(fixed[1]).toMatchObject({ no: 3, description: '', dialogue: [] })
  expect(fixed[1]!.id).not.toBe('one')
  expect(Shot.safeParse(fixed[1]).success).toBe(true)
  expect(raw[1]).toBeNull()
})
