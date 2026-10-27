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
  // 每种原因单独说清：只回一句"来源已变化"时，用户不知道该解锁、重新选还是关掉重开。
  if (doc.readOnly) throw new CharacterImageConflict('当前画布是只读的，无法归档到角色档案')
  if (!node) throw new CharacterImageConflict('来源节点已不存在，请重新选择要归档的生成结果')
  if (node.locked) throw new CharacterImageConflict('来源节点已锁定，请先解锁再归档')
  if (target?.libraryId !== libraryId)
    throw new CharacterImageConflict('来源节点已经不再关联这个角色，请重新核对归档目标')
  if (target.slot !== input.sourceSlot)
    throw new CharacterImageConflict('来源节点的角色槽位已变化，请重新核对归档目标')
  if (!candidate || candidate.id !== input.resultId)
    throw new CharacterImageConflict('来源候选已更新，请重新选择要归档的生成结果')
  if (candidate.value.type !== 'image')
    throw new CharacterImageConflict('来源候选不是图片，无法归档')
  if (candidate.value.assetId !== input.assetId)
    throw new CharacterImageConflict('来源候选已经换成别的图片，请重新核对归档目标')
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
