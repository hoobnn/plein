import type { LibraryItem } from '@plein/protocol'
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { api } from '../../api/client'
import { useLibrary } from './store'

vi.mock('../../api/client', () => ({
  api: {
    library: vi.fn(),
    createLibraryItem: vi.fn(),
    updateLibraryItem: vi.fn(),
    deleteLibraryItem: vi.fn(),
    markLibraryUsed: vi.fn(),
  },
}))

const item = (id: string, name = id): LibraryItem => ({
  id,
  name,
  kind: 'character',
  projectId: null,
  description: '',
  tags: {},
  voice: null,
  images: [],
  video: null,
  models: [],
  profile: null,
  favorite: false,
  usedAt: null,
  createdAt: 1,
  updatedAt: 1,
})

function pendingList() {
  let resolve!: (items: LibraryItem[]) => void
  vi.mocked(api.library).mockImplementationOnce(
    () =>
      new Promise<LibraryItem[]>((done) => {
        resolve = done
      }),
  )
  return (items: LibraryItem[]) => resolve(items)
}

beforeEach(() => {
  vi.resetAllMocks()
  useLibrary.setState({
    items: [],
    loaded: false,
    loading: false,
    error: null,
    open: null,
    seed: null,
  })
})

describe('资产库列表生命周期', () => {
  it('并发入口共用一次读取，后续显式刷新仍会取最新列表', async () => {
    const resolve = pendingList()
    const first = useLibrary.getState().load()
    expect(useLibrary.getState()).toMatchObject({ loading: true, loaded: false })
    useLibrary.getState().show('character')
    const second = useLibrary.getState().load()
    expect(api.library).toHaveBeenCalledTimes(1)
    resolve([item('a')])
    await Promise.all([first, second])
    expect(useLibrary.getState()).toMatchObject({
      items: [item('a')],
      loaded: true,
      loading: false,
      error: null,
    })
    vi.mocked(api.library).mockResolvedValueOnce([item('b')])
    await useLibrary.getState().load()
    expect(api.library).toHaveBeenCalledTimes(2)
    expect(useLibrary.getState().items).toEqual([item('b')])
  })

  it('旧列表不会撤销已完成的新增、编辑、删除和最近使用，未改条目仍刷新', async () => {
    const original = [item('edit'), item('remove'), item('used'), item('remote')]
    useLibrary.setState({ items: original, loaded: true })
    const resolve = pendingList()
    const load = useLibrary.getState().load()
    const created = item('new')
    const edited = item('edit', '新名字')
    vi.mocked(api.createLibraryItem).mockResolvedValueOnce(created)
    vi.mocked(api.updateLibraryItem).mockResolvedValueOnce(edited)
    vi.mocked(api.deleteLibraryItem).mockResolvedValueOnce(undefined)
    vi.mocked(api.markLibraryUsed).mockResolvedValueOnce(undefined)
    await useLibrary.getState().create({ kind: 'character', name: 'new' })
    await useLibrary.getState().update('edit', { name: '新名字' })
    await useLibrary.getState().remove('remove')
    useLibrary.getState().markUsed('used')
    const usedAt = useLibrary.getState().items.find((i) => i.id === 'used')!.usedAt
    resolve(
      [...original, item('remote-new'), created].map((i) =>
        i.id === 'remote' ? item(i.id, '远端新名字') : i,
      ),
    )
    await load
    expect(useLibrary.getState().items).toEqual([
      edited,
      { ...item('used'), usedAt },
      item('remote', '远端新名字'),
      item('remote-new'),
      created,
    ])
    expect(usedAt).toBeTypeOf('number')
  })

  it('失败不伪装成成功；再次打开能够重试，刷新失败保留已有列表', async () => {
    vi.mocked(api.library).mockRejectedValueOnce(new Error('离线'))
    await useLibrary.getState().load()
    expect(useLibrary.getState()).toMatchObject({ loaded: false, loading: false, error: '离线' })
    const resolve = pendingList()
    useLibrary.getState().show('character')
    const retry = useLibrary.getState().load()
    expect(useLibrary.getState().error).toBeNull()
    expect(useLibrary.getState().loading).toBe(true)
    resolve([item('a')])
    await retry
    vi.mocked(api.library).mockRejectedValueOnce(new Error('暂不可用'))
    await useLibrary.getState().load()
    expect(useLibrary.getState()).toMatchObject({
      items: [item('a')],
      loaded: true,
      loading: false,
      error: '暂不可用',
    })
  })

  it('读取中新增后又删除的条目也不会被响应复活', async () => {
    const resolve = pendingList()
    const load = useLibrary.getState().load()
    vi.mocked(api.createLibraryItem).mockResolvedValueOnce(item('temporary'))
    vi.mocked(api.deleteLibraryItem).mockResolvedValueOnce(undefined)
    await useLibrary.getState().create({ kind: 'character', name: 'temporary' })
    await useLibrary.getState().remove('temporary')
    resolve([item('temporary')])
    await load
    expect(useLibrary.getState().items).toEqual([])
  })

  it('列表先读到已创建的条目时，晚到的创建响应覆盖该条目并置顶，不重复插入', async () => {
    const resolveList = pendingList()
    let resolveCreate!: (item: LibraryItem) => void
    vi.mocked(api.createLibraryItem).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolveCreate = done
        }),
    )
    const loading = useLibrary.getState().load()
    const creating = useLibrary.getState().create({ kind: 'character', name: 'created' })
    resolveList([item('remote'), item('created', '列表里的版本')])
    await loading
    const created = item('created', '创建响应里的版本')
    resolveCreate(created)
    await expect(creating).resolves.toEqual(created)
    expect(useLibrary.getState().items).toEqual([created, item('remote')])
  })
})
