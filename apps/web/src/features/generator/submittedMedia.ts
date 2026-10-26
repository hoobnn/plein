import type { InputValue, PreparedInput } from '@plein/protocol'

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
