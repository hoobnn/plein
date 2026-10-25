import type { ModelInfo } from './provider'

const KINDS = {
  image: 'image',
  video: 'video',
  audio: 'audio',
  图片: 'image',
  视频: 'video',
  音频: 'audio',
} as const
export type ReferenceKind = 'image' | 'video' | 'audio'

/** 三类素材各自从 1 编号；邮件、转义 @ 和普通元素引用不参与。 */
export function videoReferenceTokens(text: string) {
  return [
    ...text.matchAll(/@(image|video|audio|图片|视频|音频)([1-9]\d*)(?![a-zA-Z0-9_])/g),
  ].flatMap((m) => {
    if (/[a-zA-Z0-9._%+@-]/.test(text[m.index - 1] ?? '')) return []
    let slashes = 0
    for (let i = m.index - 1; i >= 0 && text[i] === '\\'; i--) slashes++
    return slashes % 2
      ? []
      : [
          {
            start: m.index,
            end: m.index + m[0].length,
            kind: KINDS[m[1] as keyof typeof KINDS],
            index: Number(m[2]),
          },
        ]
  })
}

export function videoReferenceProblem(prompt: string, counts: Record<ReferenceKind, number>) {
  for (const token of videoReferenceTokens(prompt))
    if (token.index > counts[token.kind])
      return `引用 @${token.kind}${token.index} 超出当前素材数量（${counts[token.kind]}）`
  return null
}

/** 平台仅接收当前实际素材的编号，原提示词仍保留在画布上。 */
export function videoReferencePrompt(prompt: string, platform: 'ark' | 'minimax') {
  const labels = { image: '图片', video: '视频', audio: '音频' }
  let text = prompt
  for (const token of videoReferenceTokens(prompt).reverse())
    text =
      text.slice(0, token.start) +
      (platform === 'ark'
        ? `@${token.kind}${token.index}`
        : `${labels[token.kind]}${token.index}`) +
      text.slice(token.end)
  return text
}

/** 浏览器和服务端预览共用，实际 Provider 仍负责素材字节级校验。 */
export function videoModelProblem(
  model: ModelInfo,
  params: Record<string, unknown>,
  counts: Record<ReferenceKind, number>,
  prompt: string,
  options: { deferReferenceCounts?: boolean } = {},
) {
  const mode = params.mode ?? 'text'
  if (model.limits?.videoModes && !model.limits.videoModes.some((m) => m === mode))
    return '当前模型不支持此视频生成模式，请更换模式或模型'
  const refs = mode === 'reference'
  const total = counts.image + counts.video + counts.audio
  const media = model.limits?.referenceMedia
  if (
    !options.deferReferenceCounts &&
    refs &&
    media?.audioOnly === false &&
    counts.audio &&
    !counts.image &&
    !counts.video
  )
    return '当前模型的音频参考需要搭配图片或视频'
  const problem = videoReferenceProblem(prompt, refs ? counts : { image: 0, video: 0, audio: 0 })
  if (problem && !options.deferReferenceCounts) return problem
  if (
    model.id.startsWith('MiniMax-H3') &&
    params.aspectRatio === 'auto' &&
    (mode === 'text' || (refs && model.id === 'MiniMax-H3-Lite'))
  )
    return '文生视频和 H3-Lite 参考模式需要选择具体画幅'
  if (
    (model.limits?.optionalVideoPrompt !== undefined || model.id.startsWith('MiniMax-H3')) &&
    !prompt.trim() &&
    !(model.limits?.optionalVideoPrompt && total && mode !== 'text')
  )
    return '视频提示词为空'
  const extra = (params.options as Record<string, Record<string, unknown>> | undefined)?.[
    String(params.model)
  ]
  if (extra?.omni_reference_task_type && !refs) return '参考任务类型需要使用多模态参考模式'
  if (['edit', 'extend'].includes(String(extra?.omni_reference_task_type)) && !counts.video)
    return '编辑或延长任务需要参考视频'
  return null
}

/** 自动控制项在执行、输入预览和字段显示中使用同一份取值。 */
export function videoTaskOverrides(params: Record<string, unknown>) {
  const model = String(params.model ?? '')
  if (
    model.startsWith('minimax/api:MiniMax-H3') &&
    ['image', 'lastFrame', 'frames'].includes(String(params.mode))
  )
    return { aspectRatio: 'auto' }
  if (!model.startsWith('volc/ark:doubao-seedance-2-')) return {}
  const extra = (params.options as Record<string, Record<string, unknown>> | undefined)?.[
    String(params.model)
  ]
  const task = extra?.omni_reference_task_type
  return {
    ...(extra?.adaptive_duration === true || task === 'edit' ? { duration: -1 } : {}),
    ...(task === 'edit' ||
    task === 'extend' ||
    (model.startsWith('volc/ark:doubao-seedance-2-5-') &&
      ['image', 'frames'].includes(String(params.mode)))
      ? { aspectRatio: 'auto' }
      : {}),
  }
}
