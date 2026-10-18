import type { LibraryCardUpdate, LibraryUpdates } from '@plein/protocol'
import { beforeEach, expect, it, vi } from 'vite-plus/test'
import { api } from '../../api/client'
import {
  emptyUpdatesRead,
  pendingUpdatesRead,
  readLibraryUpdates,
  updatesReadReady,
  defaultUpdatesSelection,
  type UpdatesRead,
} from './updatesRead'

vi.mock('../../api/client', () => ({ api: { libraryUpdates: vi.fn() } }))
beforeEach(() => vi.resetAllMocks())
const data: LibraryUpdates = { revision: 'r1', cards: [] }
it('跨画布同节点 ID 分别选择，固定版本不默认勾选，无差异不产生写入字段', () => {
  const card: LibraryCardUpdate = {
    canvasId: 'a',
    canvasTitle: 'A',
    nodeId: 'same',
    name: '角色',
    expected: 'e',
    pinned: false,
    revision: null,
    changes: [
      { field: 'name', before: '旧名称', after: '新名称' },
      { field: 'description', before: '旧设定', after: '新设定' },
    ],
  }
  expect(
    defaultUpdatesSelection({
      revision: 'r',
      cards: [
        card,
        { ...card, canvasId: 'b', pinned: true },
        { ...card, canvasId: 'c', changes: [] },
      ],
    }),
  ).toEqual({ 'a:same': ['name', 'description'], 'b:same': [], 'c:same': [] })
})
function stateOf(initial = emptyUpdatesRead) {
  let state = initial
  return {
    get: () => state,
    set: (next: UpdatesRead | ((old: UpdatesRead) => UpdatesRead)) => {
      state = typeof next === 'function' ? next(state) : next
    },
  }
}
it('读取中和来源变化使旧差异失效，成功后接手新来源和数据', async () => {
  let resolve!: (data: LibraryUpdates) => void
  vi.mocked(api.libraryUpdates).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  const state = stateOf({ ...emptyUpdatesRead, data, source: 'old' })
  const receive = vi.fn()
  readLibraryUpdates('a', 'new', state.set, receive)
  expect(state.get().data).toBe(data)
  expect(updatesReadReady(state.get(), 'old')).toBe(false)
  resolve(data)
  await vi.waitFor(() => expect(receive).toHaveBeenCalledWith(data))
  expect(updatesReadReady(state.get(), 'new')).toBe(true)
  expect(updatesReadReady(state.get(), 'old')).toBe(false)
})
it('刷新失败保留缓存但禁止写入，重试成功才恢复', async () => {
  const state = stateOf({ ...emptyUpdatesRead, data, source: 'a' })
  vi.mocked(api.libraryUpdates).mockRejectedValueOnce(new Error('离线'))
  readLibraryUpdates('a', 'a', state.set, vi.fn())
  await vi.waitFor(() => expect(state.get().error).toBe('离线'))
  expect(state.get().data).toBe(data)
  expect(updatesReadReady(state.get(), 'a')).toBe(false)
  vi.mocked(api.libraryUpdates).mockResolvedValueOnce(data)
  readLibraryUpdates('a', 'a', state.set, vi.fn())
  await vi.waitFor(() => expect(updatesReadReady(state.get(), 'a')).toBe(true))
})
it('取消旧读取后成功或失败都不改写新状态和选择', async () => {
  for (const reject of [false, true]) {
    let settle!: (value: LibraryUpdates) => void
    vi.mocked(api.libraryUpdates).mockImplementationOnce(
      () =>
        new Promise((resolve, fail) => {
          settle = reject ? fail : resolve
        }),
    )
    const state = stateOf()
    const receive = vi.fn()
    const cancel = readLibraryUpdates('old', 'old', state.set, receive)
    cancel()
    state.set({ data, source: 'new', loading: false, error: '' })
    settle(data)
    await Promise.resolve()
    await Promise.resolve()
    expect(state.get().source).toBe('new')
    expect(receive).not.toHaveBeenCalled()
  }
})
it('空初始状态不可同步，开始重读清除旧错误且保留数据', () => {
  expect(updatesReadReady(emptyUpdatesRead, 'a')).toBe(false)
  expect(pendingUpdatesRead({ data, source: 'a', loading: false, error: '旧错误' })).toEqual({
    data,
    source: 'a',
    loading: true,
    error: '',
  })
})
