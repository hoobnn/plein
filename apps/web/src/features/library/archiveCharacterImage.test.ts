import type { ArchiveCharacterImage, LibraryItem } from '@plein/protocol'
import { beforeEach, expect, it, vi } from 'vite-plus/test'
import { api } from '../../api/client'
import { useLibrary } from './store'

vi.mock('../../api/client', () => ({ api: { archiveCharacterImage: vi.fn() } }))

const A = 'a'.repeat(64)
const item = (id: string): LibraryItem => ({
  id,
  kind: 'character',
  name: id,
  projectId: 'project_original',
  description: '',
  tags: {},
  voice: null,
  images: [],
  video: null,
  models: [],
  profile: null,
  favorite: false,
  usedAt: id === 'a' ? 42 : null,
  createdAt: 1,
  updatedAt: 1,
})

beforeEach(() => {
  vi.resetAllMocks()
  useLibrary.setState({ items: [item('a'), item('b')], loaded: true, open: null })
})

it('归档固定提交快照，只更新同 ID 条目并保留最近使用；409 不自动重试', async () => {
  const body: ArchiveCharacterImage = {
    canvasId: 'canvas_1',
    nodeId: 'node_1',
    resultId: 'result_1',
    assetId: A,
    sourceSlot: 'portrait',
    slot: 'portrait',
    expected: 'revision_1',
    cover: true,
  }
  let finish!: (value: LibraryItem) => void
  vi.mocked(api.archiveCharacterImage).mockImplementationOnce(
    () =>
      new Promise<LibraryItem>((resolve) => {
        finish = resolve
      }),
  )
  const archiving = useLibrary.getState().archiveCharacterImage('a', body)
  body.slot = 'face_grid'
  await vi.waitFor(() => expect(api.archiveCharacterImage).toHaveBeenCalledTimes(1))
  expect(api.archiveCharacterImage).toHaveBeenCalledWith(
    'a',
    expect.objectContaining({ slot: 'portrait', resultId: 'result_1' }),
  )
  finish({
    ...item('a'),
    images: [{ slot: 'portrait', assetId: A }],
    coverAssetId: A,
    usedAt: null,
  })
  await archiving
  expect(useLibrary.getState().items.find((entry) => entry.id === 'a')).toMatchObject({
    coverAssetId: A,
    usedAt: 42,
  })
  expect(useLibrary.getState().items.find((entry) => entry.id === 'b')).toEqual(item('b'))

  vi.mocked(api.archiveCharacterImage).mockRejectedValueOnce(new Error('409 conflict'))
  await expect(
    useLibrary.getState().archiveCharacterImage('a', {
      ...body,
      slot: 'portrait',
      expected: 'stale_revision',
    }),
  ).rejects.toThrow('409 conflict')
  expect(api.archiveCharacterImage).toHaveBeenCalledTimes(2)
})
