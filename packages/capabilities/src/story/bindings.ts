import type { CanvasElement, PleinDoc } from '@plein/doc'
import { mentionName, normalizeDialogue, type Shot, type ShotAssetBinding } from '@plein/nodes'
import { mentionElements } from './nodes'

/** 显式绑定失效时不退回名字，避免换成另一张同名卡。 */
export function resolveShotAsset(doc: PleinDoc, name: string, binding?: ShotAssetBinding) {
  const eligible = (el: CanvasElement | undefined) => (el && mentionName(el) ? el : undefined)
  if (binding?.elementId) {
    const exact = eligible(doc.get(binding.elementId))
    if (exact) return exact
  }
  if (binding?.libraryId) {
    const cards = [...doc.elements()].filter(
      (el) => el.params?.libraryId === binding.libraryId && eligible(el),
    )
    return cards.length === 1 ? cards[0] : undefined
  }
  if (binding?.elementId) return undefined
  const named = mentionElements(doc).get(name)
  return named?.length === 1 ? named[0] : undefined
}

export const shotAssetBinding = (el: CanvasElement): ShotAssetBinding => ({
  elementId: el.id,
  ...(typeof el.params?.libraryId === 'string' ? { libraryId: el.params.libraryId } : {}),
})

/** 迁移只锁定能唯一确认的旧名称；重名留给表格明确选择。 */
export function bindShotAssets(doc: PleinDoc, shot: Shot): Shot {
  const assetBindings = { ...shot.assetBindings }
  for (const name of shot.characters) {
    if (assetBindings[name]) continue
    const el = resolveShotAsset(doc, name)
    if (el) assetBindings[name] = shotAssetBinding(el)
  }
  return {
    ...shot,
    ...(Object.keys(assetBindings).length ? { assetBindings } : {}),
    dialogue: normalizeDialogue(shot.id, shot.dialogue).map((line) => {
      if (line.speaker || !line.character) return line
      const el = resolveShotAsset(doc, line.character, assetBindings[line.character])
      return el ? { ...line, speaker: shotAssetBinding(el) } : line
    }),
  }
}

/** 绑定 id 翻译成当前提示词可读的消歧名称，名称变动由已有计划差异流程确认。 */
export function shotAssetMention(doc: PleinDoc, el: CanvasElement) {
  const name = mentionName(el)!
  const same = (mentionElements(doc).get(name) ?? []).sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  )
  return `@${name}${same.length > 1 ? `#${same.findIndex((x) => x.id === el.id) + 1}` : ''}`
}
