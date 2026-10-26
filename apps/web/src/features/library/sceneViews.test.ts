import { libraryKind } from '@plein/nodes'
import type { LibraryItem } from '@plein/protocol'
import { expect, it } from 'vite-plus/test'
import { assetUrls } from '../../api/client'
import { coverOf } from './canvas'
import { draftOf } from './editorDraft'

const image = 'a'.repeat(64)
const legacy: LibraryItem = {
  id: 'lib_scene',
  kind: 'scene',
  name: '教室',
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
  createdAt: 0,
  updatedAt: 0,
}

it('旧场景缺省为空视角，只有视角图时库封面不回退为空', () => {
  const kind = libraryKind('scene')!
  expect(draftOf(kind, legacy, undefined, null).sceneViews).toEqual([])
  const item: LibraryItem = {
    ...legacy,
    sceneViews: [{ id: 'door', name: '门口', aliases: [], description: '', images: [image] }],
  }
  expect(coverOf(item)).toBe(assetUrls.variant(image, 'thumb-256'))
})
