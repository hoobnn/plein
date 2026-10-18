import { cardSnapshot } from '@plein/capabilities'
import { setParam, type PleinDoc } from '@plein/doc'
import { preserveLibraryImageSlots } from '@plein/nodes'
import { CreateLibraryItem } from '@plein/protocol'
import type { LibraryStore } from './store'

export class LibraryArchiveConflict extends Error {}

/** 同步执行归档与来源绑定，不在创建条目和写回节点之间等待客户端。 */
export function archiveLibraryCard(
  doc: PleinDoc,
  nodeId: string,
  owner: string,
  projectId: string | null,
  library: LibraryStore,
  snapshot?: CreateLibraryItem,
  expectedLibraryId?: string | null,
) {
  const node = doc.get(nodeId)
  const currentId = typeof node?.params?.libraryId === 'string' ? node.params.libraryId : null
  if (!node || doc.readOnly || (expectedLibraryId !== undefined && currentId !== expectedLibraryId))
    throw new LibraryArchiveConflict('来源卡片已变化或不可写，请重新查看后存入')
  const captured = cardSnapshot(doc, node, projectId)
  if (!captured) throw new LibraryArchiveConflict('这个节点不是资产卡')
  const body = CreateLibraryItem.parse({ ...(snapshot ?? captured.body), projectId })
  if (body.kind !== captured.kind.id)
    throw new LibraryArchiveConflict('来源卡片类型已变化，请重新查看后存入')
  const linked = currentId ? library.get(owner, currentId) : null
  if (linked && linked.kind === body.kind) {
    const item = library.update(owner, linked.id, {
      name: body.name,
      description: body.description,
      tags: {
        ...body.tags,
        ...Object.fromEntries(Object.entries(linked.tags).filter(([, value]) => value)),
      },
      images: preserveLibraryImageSlots(linked.kind, body.images, linked.images),
      video: body.video,
      voice: body.voice,
      profile: body.profile,
    })!
    return { item, created: false }
  }
  const item = library.create(owner, body)
  setParam(doc, nodeId, 'libraryId', item.id)
  return { item, created: true }
}
