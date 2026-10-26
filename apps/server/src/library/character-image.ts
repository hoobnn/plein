import { existsSync } from 'node:fs'
import { currentResult, type PleinDoc } from '@plein/doc'
import { normalizeLibraryImages, characterAssetTargetOf } from '@plein/nodes'
import { characterImageRevision, type ArchiveCharacterImage } from '@plein/protocol'
import type { AssetStore } from '../assets/store'
import type { LibraryStore } from './store'

export class CharacterImageConflict extends Error {}

/** Validate source and target synchronously before changing only the role's image fields. */
export function archiveCharacterImage(
  doc: PleinDoc,
  assets: AssetStore,
  library: LibraryStore,
  owner: string,
  libraryId: string,
  input: ArchiveCharacterImage,
) {
  const item = library.get(owner, libraryId)
  if (!item || item.kind !== 'character')
    throw new CharacterImageConflict('原角色不存在，请重新选择角色')
  if (characterImageRevision(item) !== input.expected)
    throw new CharacterImageConflict('角色或图片已变化，请重新读取后核对归档目标')
  const node = doc.get(input.nodeId)
  const target = node && characterAssetTargetOf(node)
  const candidate = node && currentResult(node, 'images')
  if (
    doc.readOnly ||
    !node ||
    node.locked ||
    target?.libraryId !== libraryId ||
    target.slot !== input.sourceSlot ||
    candidate?.id !== input.resultId ||
    candidate.value.type !== 'image' ||
    candidate.value.assetId !== input.assetId
  )
    throw new CharacterImageConflict('来源候选、角色关联或编辑权限已变化，请重新核对后归档')
  if (
    assets.get(owner, input.assetId)?.kind !== 'image' ||
    !existsSync(assets.originalPath(input.assetId))
  )
    throw new CharacterImageConflict('候选图片缺失或不属于当前用户，请先恢复素材')

  const original = normalizeLibraryImages('character', item.images)
  // The old slot image stays as an extra reference. A previously stored chosen file moves slots.
  const images = original
    .filter((image) => image.assetId !== input.assetId)
    .map((image) => (image.slot === input.slot ? { ...image, slot: 'extra' } : image))
  images.push({ slot: input.slot, assetId: input.assetId })
  if (images.length > 24)
    throw new CharacterImageConflict(
      '每个角色最多保存 24 张图片；原槽位图会保留，请先移除不需要的参考',
    )
  const coverAssetId = input.cover ? input.assetId : (item.coverAssetId ?? null)
  return library.update(owner, libraryId, { images, coverAssetId })!
}
