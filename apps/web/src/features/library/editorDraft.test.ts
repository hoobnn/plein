import { libraryKind, OFFICIAL_LIBRARY } from '@plein/nodes'
import { expect, it } from 'vite-plus/test'
import { createdEditing, draftOf, editorKeyOf, type Editing } from './editorDraft'

it('新建和官方复制接手 ID 时保持编辑实例，之后更新 ID 不再次重挂载', () => {
  for (const previous of [
    { type: 'new' },
    { type: 'official', item: OFFICIAL_LIBRARY[0]! },
  ] satisfies Editing[]) {
    const next = createdEditing(previous, 'lib_1')
    expect(editorKeyOf('style', next)).toBe(editorKeyOf('style', previous))
    expect(createdEditing(next, 'lib_1')).toEqual(next)
    expect(editorKeyOf('scene', next)).not.toBe(editorKeyOf('style', next))
  }
})
it('直接进入不同条目或类别时使用独立实例', () => {
  const first = editorKeyOf('prop', { type: 'item', id: 'a' })
  expect(editorKeyOf('prop', { type: 'item', id: 'b' })).not.toBe(first)
  expect(editorKeyOf('scene', { type: 'item', id: 'a' })).not.toBe(first)
})
it('图片种子初始化保留参考素材并去掉文件扩展名，归属沿用资产类型规则', () => {
  const image = 'a'.repeat(64)
  const seed = { name: '角色.png', images: [image], videos: [] }
  const character = draftOf(libraryKind('character')!, undefined, undefined, 'pj_1', seed)
  expect(character.name).toBe('角色')
  expect(character.images).toContainEqual({ slot: 'full_body', assetId: image })
  expect(character.inProject).toBe(true)
  expect(draftOf(libraryKind('style')!, undefined, undefined, 'pj_1', seed).inProject).toBe(false)
})
it('官方复制按原名称设定和标签初始化，修改草稿标签不改变官方条目', () => {
  const official = OFFICIAL_LIBRARY.find((item) => item.kind === 'style')!
  const draft = draftOf(libraryKind('style')!, undefined, official, 'pj_1')
  expect(draft).toMatchObject({
    name: official.name,
    description: official.description,
    tags: official.tags,
  })
  draft.tags.test = 'draft only'
  expect(official.tags.test).toBeUndefined()
})
