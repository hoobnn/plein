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
  it('某条目等待更新不阻塞其他条目', async () => {
    useLibrary.setState({ items: [item('a'), item('b')] })
    let resolve!: (value: LibraryItem) => void
    vi.mocked(api.updateLibraryItem).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    vi.mocked(api.updateLibraryItem).mockResolvedValueOnce(item('b', '新 b'))
    const first = useLibrary.getState().update('a', { name: '新 a' })
    try {
      await expect(useLibrary.getState().update('b', { name: '新 b' })).resolves.toEqual(
        item('b', '新 b'),
      )
      expect(useLibrary.getState().items[0]!.name).toBe('a')
    } finally {
      resolve(item('a', '新 a'))
      await first
    }
  })

  it('失败后继续同条目的后续写入，排队时固定提交内容', async () => {
    useLibrary.setState({ items: [item('a')] })
    const failure = new Error('暂不可用')
    vi.mocked(api.updateLibraryItem).mockRejectedValueOnce(failure)
    vi.mocked(api.updateLibraryItem).mockResolvedValueOnce(item('a', '提交名称'))
    const first = useLibrary.getState().update('a', { favorite: true })
    const body = { name: '提交名称', tags: { era: '现代' } }
    const second = useLibrary.getState().update('a', body)
    body.name = '后来输入'
    body.tags.era = '古代'
    await expect(first).rejects.toBe(failure)
    await second
    expect(api.updateLibraryItem).toHaveBeenNthCalledWith(2, 'a', {
      name: '提交名称',
      tags: { era: '现代' },
    })
    expect(useLibrary.getState().items[0]!.name).toBe('提交名称')
    vi.mocked(api.updateLibraryItem).mockResolvedValueOnce(item('a', '恢复后的下一次'))
    await useLibrary.getState().update('a', { name: '恢复后的下一次' })
    expect(api.updateLibraryItem).toHaveBeenCalledTimes(3)
  })

  it('更新等待期间删除的条目不会被成功响应重新插入', async () => {
    useLibrary.setState({ items: [item('a')] })
    let resolve!: (value: LibraryItem) => void
    vi.mocked(api.updateLibraryItem).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    vi.mocked(api.deleteLibraryItem).mockResolvedValueOnce(undefined)
    const updating = useLibrary.getState().update('a', { name: '新 a' })
    await vi.waitFor(() => expect(api.updateLibraryItem).toHaveBeenCalledTimes(1))
    await useLibrary.getState().remove('a')
    resolve(item('a', '新 a'))
    await updating
    expect(useLibrary.getState().items).toEqual([])
  })
  it('同一条目的收藏和改名按调用顺序发送，旧快照不能撤销新名称', async () => {
    useLibrary.setState({ items: [item('a')] })
    let resolve!: (value: LibraryItem) => void
    vi.mocked(api.updateLibraryItem).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    vi.mocked(api.updateLibraryItem).mockResolvedValueOnce({
      ...item('a', '新名称'),
      favorite: true,
    })
    const favorite = useLibrary.getState().update('a', { favorite: true })
    const rename = useLibrary.getState().update('a', { name: '新名称' })
    try {
      await vi.waitFor(() => expect(api.updateLibraryItem).toHaveBeenCalledTimes(1))
    } finally {
      resolve({ ...item('a'), favorite: true })
      await Promise.all([favorite, rename])
    }
    expect(api.updateLibraryItem).toHaveBeenNthCalledWith(2, 'a', { name: '新名称' })
    expect(useLibrary.getState().items).toEqual([{ ...item('a', '新名称'), favorite: true }])
  })

  it('等待更新响应时记录的最近使用时间不会被旧快照清空', async () => {
    useLibrary.setState({ items: [item('a')] })
    let resolve!: (value: LibraryItem) => void
    vi.mocked(api.updateLibraryItem).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    vi.mocked(api.markLibraryUsed).mockResolvedValueOnce(undefined)
    const update = useLibrary.getState().update('a', { favorite: true })
    await vi.waitFor(() => expect(api.updateLibraryItem).toHaveBeenCalledTimes(1))
    useLibrary.getState().markUsed('a')
    const usedAt = useLibrary.getState().items[0]!.usedAt
    resolve({ ...item('a'), favorite: true })
    await update
    expect(useLibrary.getState().items[0]).toMatchObject({ favorite: true, usedAt })
  })
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
