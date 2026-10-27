import type { LibraryItem } from '@plein/protocol'
import { describe, expect, it } from 'vite-plus/test'
import { assetUrls } from '../../api/client'
import { coverAssetOf, coverOf } from './canvas'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const C = 'c'.repeat(64)
const item: LibraryItem = {
  id: 'lib_cover',
  kind: 'character',
  name: '封面角色',
  projectId: null,
  description: '',
  tags: {},
  voice: null,
  images: [
    { slot: 'full_body', assetId: A },
    { slot: 'portrait', assetId: B },
  ],
  video: null,
  models: [],
  profile: null,
  favorite: false,
  usedAt: null,
  createdAt: 0,
  updatedAt: 0,
}

describe('独立角色封面', () => {
  it('有效 cover 优先于全身定妆图，失效后回退且不偷换槽位', () => {
    const covered = { ...item, coverAssetId: B }
    expect(coverAssetOf(covered)).toBe(B)
    expect(coverOf(covered)).toBe(assetUrls.variant(B, 'thumb-256'))
    expect(covered.images[0]).toEqual({ slot: 'full_body', assetId: A })
    const stale = { ...item, coverAssetId: C }
    expect(coverAssetOf(stale)).toBeNull()
    expect(coverOf(stale)).toBe(assetUrls.variant(A, 'thumb-256'))
  })
})
