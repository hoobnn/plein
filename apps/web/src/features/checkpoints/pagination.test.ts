import type { CanvasCheckpoint, CheckpointPage } from '@plein/protocol'
import { describe, expect, it } from 'vite-plus/test'
import { mergeCheckpointPage } from './pagination'

const checkpoint = (id: string, name = id): CanvasCheckpoint => ({
  id,
  projectId: 'pj_1',
  sourceCanvasId: 'cv_1',
  sourceCanvasTitle: '画布',
  name,
  createdAt: 0,
  assets: 0,
  missingAssets: [],
})

const page = (ids: string[], nextCursor: string | null): CheckpointPage => ({
  items: ids.map((id) => checkpoint(id)),
  nextCursor,
})

const ids = (p: CheckpointPage) => p.items.map((item) => item.id)

describe('检查点分页合并', () => {
  it.each([
    ['相邻页首条与上一页重叠', ['a', 'b', 'c'], ['b', 'd', 'e'], ['a', 'b', 'c', 'd', 'e']],
    ['下一页混入多条已加载条目', ['a', 'b', 'c'], ['c', 'a', 'd'], ['a', 'b', 'c', 'd']],
    ['下一页完全重复', ['a', 'b'], ['a', 'b'], ['a', 'b']],
    ['下一页无重叠', ['a', 'b'], ['c', 'd'], ['a', 'b', 'c', 'd']],
    ['下一页自身含重复条目', ['a'], ['b', 'b', 'c'], ['a', 'b', 'c']],
  ])('%s时按检查点 id 合并、保序且不重复', (_, loaded, next, expected) => {
    const merged = mergeCheckpointPage(page(loaded, 'c1'), 'c1', page(next, 'c2'))
    expect(ids(merged)).toEqual(expected)
    expect(new Set(ids(merged)).size).toBe(merged.items.length)
  })

  it('重叠条目保留原位置但采用新页的数据', () => {
    const merged = mergeCheckpointPage(page(['a', 'b'], 'c1'), 'c1', {
      items: [checkpoint('a', '改名后的版本'), checkpoint('c')],
      nextCursor: null,
    })
    expect(merged.items.map((item) => [item.id, item.name])).toEqual([
      ['a', '改名后的版本'],
      ['b', 'b'],
      ['c', 'c'],
    ])
  })

  it.each([
    ['还有更多', 'c2'],
    ['已到末页', null],
  ])('合并后游标取新页的值（%s）', (_, nextCursor) => {
    const merged = mergeCheckpointPage(page(['a'], 'c1'), 'c1', page(['b'], nextCursor))
    expect(merged.nextCursor).toBe(nextCursor)
  })

  it('列表已刷新、游标不再匹配时，迟到的旧页不追加', () => {
    const refreshed = page(['n', 'a'], 'c9')
    expect(mergeCheckpointPage(refreshed, 'c1', page(['b', 'c'], 'c2'))).toBe(refreshed)
  })
})
