import { presetsFor } from '@plein/nodes'
import type { Capability } from '@plein/plugin-sdk'
import type { Catalog } from '@plein/protocol'
import type { MediaTarget } from '../../canvas/media'

/** A small view over installed declarations; entries create drafts, never invoke models. */
export function mediaCreationCatalog(catalog: Catalog | null) {
  const nodes = catalog?.nodes ?? []
  const byCapability = (capability: string) => {
    const matching = nodes.filter(
      (n) => n.capability === capability && n.inputs.some((p) => p.type === 'image'),
    )
    return matching.find((n) => n.type.startsWith('plein/')) ?? matching[0]
  }
  const models = (capability: Capability) =>
    (catalog?.providers ?? [])
      .filter((p) => p.enabled)
      .flatMap((p) => p.models.filter((m) => m.capabilities.includes(capability)))
  const image = byCapability('image.generate')
  return {
    image,
    video: byCapability('video.generate'),
    edit: byCapability('image.edit'),
    process: byCapability('image.process'),
    recipes: image
      ? presetsFor(catalog?.prompts ?? [], image).filter((p) =>
          p.appliesTo?.includes('image.generate'),
        )
      : [],
    hasImageModel: models('image.generate').length > 0,
    hasVideoModel: models('video.generate').length > 0,
    hasEditModel: models('image.edit').length > 0,
    supportsProcess: (operation: 'upscale' | 'outpaint' | 'cutout') =>
      models('image.process').some((m) => m.limits?.imageOperations?.includes(operation)),
  }
}

export function creationScopeReason(
  targets: readonly MediaTarget[],
  readOnly: boolean,
  locked: boolean,
) {
  if (readOnly) return '当前画布只读，不能创建草稿或加工素材。'
  if (locked) return '所选素材已锁定，请先解锁。'
  if (targets.length !== 1)
    return 'AI 能力和提示词配方每次使用一个素材，请先单选；本地批量操作按适用数量处理。'
  return null
}
