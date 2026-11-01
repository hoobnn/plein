import { referenceAliases } from '@plein/plugin-sdk'
import type { InputValue, PreparedInput } from '@plein/protocol'
import type { Upstream } from '../../canvas/nodes'

export type SubmittedMedia = InputValue & {
  type: 'image' | 'video' | 'audio'
  port: string
  index: number
  token: string
}

/** 顶部素材、@ 菜单和实际输入预览共用服务端的顺序；各类素材分别从 1 编号。 */
export function submittedMedia(data: PreparedInput): SubmittedMedia[] {
  const counts = { image: 0, video: 0, audio: 0 }
  return Object.entries(data.inputs).flatMap(([port, values]) =>
    values.flatMap((value) => {
      if (value.type !== 'image' && value.type !== 'video' && value.type !== 'audio') return []
      const index = ++counts[value.type]
      return [{ ...value, type: value.type, port, index, token: `${value.type}${index}` }]
    }),
  )
}

export function referenceMedia(
  data: PreparedInput,
  bindings: unknown,
  ups?: Map<string, Upstream[]>,
) {
  return referenceAliases(
    submittedMedia(data)
      .filter((item) => !!item.assetId)
      .map((item) => {
        const candidates =
          ups
            ?.get(item.port)
            ?.filter(
              (up) =>
                up.value &&
                'assetId' in up.value &&
                up.value.assetId === item.assetId &&
                up.value.type === item.type,
            ) ?? []
        return {
          ...item,
          assetId: item.assetId!,
          source: item.source ?? (candidates.length === 1 ? candidates[0]!.source.id : undefined),
        }
      }),
    bindings,
  )
}
