import { z } from 'zod'

/** Only these built-in image tools can carry a role's explicitly chosen archive target. */
export const CHARACTER_IMAGE_NODE_TYPES: ReadonlySet<string> = new Set([
  'plein/image',
  'plein/image-edit',
  'plein/image-process',
])
export const isCharacterImageNodeType = (type: string | undefined) =>
  typeof type === 'string' && CHARACTER_IMAGE_NODE_TYPES.has(type)

export const CharacterAssetTarget = z.object({
  libraryId: z.string().min(1).max(200),
  slot: z.enum(['full_body', 'portrait', 'face_grid', 'character_3view']),
})
export type CharacterAssetTarget = z.infer<typeof CharacterAssetTarget>

export function characterAssetTargetField() {
  return CharacterAssetTarget.optional().meta({ title: '角色图片归档目标', widget: 'hidden' })
}

export function characterAssetTargetOf(node: {
  kind?: string
  nodeType?: string
  params?: Record<string, unknown>
}): CharacterAssetTarget | null {
  if ((node.kind !== undefined && node.kind !== 'node') || !isCharacterImageNodeType(node.nodeType))
    return null
  const parsed = CharacterAssetTarget.safeParse(node.params?.characterAssetTarget)
  return parsed.success ? parsed.data : null
}
