import type { Engine } from '@plein/canvas-core'
import { type CanvasElement, primaryResult } from '@plein/doc'
import { CHARACTER_IMAGE_SLOTS, sortMentionTargets } from '@plein/nodes'
import {
  CharacterImageSlot,
  type ArchiveCharacterImage,
  type Catalog,
  type CharacterImageSlot as CharacterImageSlotValue,
  type LibraryItem,
  characterImageRevision,
} from '@plein/protocol'
import { deriveNode } from '../../canvas/presets'
import { mentionTargets } from '../../canvas/nodes'

export interface CharacterAssetTarget {
  libraryId: string
  slot: CharacterImageSlotValue
}

export interface CharacterArchiveSource extends CharacterAssetTarget {
  canvasId: string
  nodeId: string
  resultId: string
  assetId: string
}

const RECIPES: Record<CharacterImageSlotValue, { aspectRatio: string; instruction: string }> = {
  full_body: {
    aspectRatio: '9:16',
    instruction:
      '制作同一角色的全身定妆图，完整展示头到脚、服装、鞋履与体型，正面站立，简洁纯色背景，人物比例准确，不添加其他人物。',
  },
  portrait: {
    aspectRatio: '3:4',
    instruction:
      '制作同一角色的肖像／半身图，清晰呈现脸型、五官、发型与上身服装，正面略带自然角度，简洁背景，不添加其他人物。',
  },
  face_grid: {
    aspectRatio: '1:1',
    instruction:
      '制作同一角色的情绪九宫格：严格 3×3 等分九格，九格均为同一人物、同一服装与同一画风，分别展示喜、怒、哀、惊、疑、笑、哭、平静、害羞，头部朝向一致，不添加文字。',
  },
  character_3view: {
    aspectRatio: '16:9',
    instruction:
      '制作同一角色的基础设定三视图：同一行并排展示正面、侧面、背面全身，人物比例、服装、发型、配色与细节严格一致，等高对齐，简洁纯色背景，不添加文字。',
  },
}

export const CHARACTER_STARTERS = [
  {
    id: 'courier',
    name: '阿岚',
    description:
      '二十岁出头的山城信使，短黑发，琥珀色眼睛，穿防风的靛蓝短外套和耐磨长靴；机灵、安静，随身带着旧皮质地图包。',
  },
  {
    id: 'detective',
    name: '周衡',
    description:
      '四十岁的老城区侦探，略长的灰黑发，深眼窝，常穿深灰风衣与软呢帽；观察细致，说话克制，左手总拿着一本磨损的笔记本。',
  },
] as const

/** 只建独立草稿并选中，绝不在这里提交生成。 */
export function createCharacterImageDraft(
  engine: Engine,
  catalog: Catalog | null,
  cardId: string,
  item: LibraryItem,
  slot: CharacterImageSlotValue,
) {
  const card = engine.doc.get(cardId)
  if (
    engine.doc.readOnly ||
    card?.nodeType !== 'plein/character' ||
    item.kind !== 'character' ||
    card.params?.libraryId !== item.id
  )
    return null
  const targets = sortMentionTargets(mentionTargets(engine))
  const target = targets.find((entry) => entry.id === cardId)
  if (!target) return null
  const peers = targets.filter((entry) => entry.name === target.name)
  const reference = `@${target.name}${peers.length > 1 ? `#${peers.findIndex((entry) => entry.id === cardId) + 1}` : ''}`
  const recipe = RECIPES[slot]
  const label = CHARACTER_IMAGE_SLOTS.find((entry) => entry.id === slot)?.label ?? slot
  return deriveNode(engine, catalog, cardId, 'plein/image', {
    // @ 引用统一注入角色设定与参考；无图角色不能成为要求已有图像结果的上游。
    inputPort: 'prompt',
    name: `${item.name} · ${label}`,
    params: {
      prompt: `${reference}\n${recipe.instruction}`,
      aspectRatio: recipe.aspectRatio,
      count: 1,
      characterAssetTarget: { libraryId: item.id, slot },
    },
  })
}

/** 只有当前明确采用的图片候选才能成为归档来源。 */
export function characterArchiveSource(
  el: CanvasElement | undefined,
  canvasId: string | null,
): CharacterArchiveSource | null {
  if (!el || !canvasId || el.nodeType !== 'plein/image') return null
  const raw = el.params?.characterAssetTarget as { libraryId?: unknown; slot?: unknown } | undefined
  const slot = CharacterImageSlot.safeParse(raw?.slot)
  if (typeof raw?.libraryId !== 'string' || !raw.libraryId || !slot.success) return null
  const result = primaryResult(el)
  if (result?.value.type !== 'image') return null
  return {
    canvasId,
    nodeId: el.id,
    resultId: result.id,
    assetId: result.value.assetId,
    libraryId: raw.libraryId,
    slot: slot.data,
  }
}

export function sameCharacterArchiveSource(
  el: CanvasElement | undefined,
  source: CharacterArchiveSource,
) {
  const current = characterArchiveSource(el, source.canvasId)
  return (
    current?.nodeId === source.nodeId &&
    current.resultId === source.resultId &&
    current.assetId === source.assetId &&
    current.libraryId === source.libraryId &&
    current.slot === source.slot
  )
}

export function characterArchiveBody(
  source: CharacterArchiveSource,
  item: LibraryItem,
  slot: CharacterImageSlotValue,
  cover: boolean,
): ArchiveCharacterImage {
  return {
    canvasId: source.canvasId,
    nodeId: source.nodeId,
    resultId: source.resultId,
    assetId: source.assetId,
    sourceSlot: source.slot,
    slot,
    expected: characterImageRevision(item),
    cover,
  }
}
