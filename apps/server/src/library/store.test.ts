import { CreateLibraryItem, LibraryProfile, UpdateLibraryItem } from '@plein/protocol'
import { describe, expect, it } from 'vite-plus/test'
import { bootServer } from '../testing'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const legacyImages = [
  { slot: 'main', assetId: A },
  { slot: 'half', assetId: A },
  { slot: 'sheet', assetId: B },
  { slot: 'emotions', assetId: B },
  { slot: 'full_body', assetId: B },
  { slot: 'head_3view', assetId: A },
]
const canonicalImages = [
  { slot: 'full_body', assetId: A },
  { slot: 'portrait', assetId: A },
  { slot: 'character_3view', assetId: B },
  { slot: 'face_grid', assetId: B },
  { slot: 'extra', assetId: B },
  { slot: 'head_3view', assetId: A },
]

describe('角色资产图片兼容存储', () => {
  it('新建与更新规范化核心槽位，并保留重复图片、扩展槽位和原角色档案', async () => {
    const { server } = await bootServer()
    const profile = LibraryProfile.parse({
      periods: [
        { id: 'teen', name: '少年', images: [A], outfits: [{ id: 'uniform', name: '校服' }] },
      ],
      expressions: [{ id: 'happy', name: '开心', images: [B] }],
    })
    const item = server.library.create(
      'local',
      CreateLibraryItem.parse({ kind: 'character', name: '林夏', images: legacyImages, profile }),
    )
    expect(item.images).toEqual(canonicalImages)
    expect(item.profile).toEqual(profile)
    const persisted = () =>
      JSON.parse(
        (
          server.db.$client.prepare('SELECT data FROM library_items WHERE id=?').get(item.id) as {
            data: string
          }
        ).data,
      ) as { images: typeof legacyImages; profile: typeof profile }
    expect(persisted().images).toEqual(canonicalImages)
    const updated = server.library.update(
      'local',
      item.id,
      UpdateLibraryItem.parse({ images: legacyImages }),
    )!
    expect(updated.images).toEqual(canonicalImages)
    expect(persisted().images).toEqual(canonicalImages)
    expect(persisted().profile).toEqual(profile)
  })

  it('已有数据库在读取时兼容旧图片，随后保存其他字段也将图片无损写回新结构', async () => {
    const { server } = await bootServer()
    const item = server.library.create(
      'local',
      CreateLibraryItem.parse({ kind: 'character', name: '林夏' }),
    )
    server.db.$client
      .prepare('UPDATE library_items SET data=? WHERE id=?')
      .run(JSON.stringify({ images: legacyImages }), item.id)
    expect(server.library.get('local', item.id)?.images).toEqual(canonicalImages)
    expect(server.library.list('local')[0]?.images).toEqual(canonicalImages)
    expect(server.library.update('local', item.id, { description: '新的设定' })?.images).toEqual(
      canonicalImages,
    )
    const row = server.db.$client
      .prepare('SELECT data FROM library_items WHERE id=?')
      .get(item.id) as { data: string }
    expect(JSON.parse(row.data).images).toEqual(canonicalImages)
  })

  it('场景等其他资产继续使用原槽位，协议继续接收旧槽位和未知用途', async () => {
    const { server } = await bootServer()
    const body = CreateLibraryItem.parse({ kind: 'scene', name: '天台', images: legacyImages })
    expect(server.library.create('local', body).images).toEqual(legacyImages)
    expect(UpdateLibraryItem.parse({ images: legacyImages }).images).toEqual(legacyImages)
  })
})
