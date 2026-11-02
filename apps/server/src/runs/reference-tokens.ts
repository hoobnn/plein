import {
  referenceBindings,
  sameReference,
  type PortValue,
  type ReferenceIdentity,
} from '@plein/plugin-sdk'

/** 只有媒体（图片 / 视频 / 音频）能当参考素材。 */
export type ReferenceMedia = Extract<PortValue, { type: 'image' | 'video' | 'audio' }>
/** 只有图片参与平台编号。 */
export type ReferenceImage = ReferenceMedia & { type: 'image' }

/** 正文里一处绑定引用（名称绑定、旧 @imageN）的解析结果。 */
export interface BoundReference {
  /** 正文里替换成什么 */
  text: string
  /** 绑定已失效（元素被删、或既没连线也没被 @）：忽略，不阻断，也不参与编号 */
  stale?: true
  /** 素材还在但对不上：阻断，提醒重新选择 */
  error?: string
}

/**
 * 解析正文里的一处绑定引用。
 *
 * 名称绑定、旧 @imageN 与 @ 引用共用同一份编号；解析不到时先判断这条绑定是不是
 * 已经失效的残留：失效就忽略（正文只留名字、不阻断、不编号），素材还在但换了图
 * 才阻断，提醒用户重新选择。
 *
 * @param media 本次真正送入模型的媒体；图片只放最终送入的那几张，
 *              这样「连着但没送入」和「素材被换掉」一样都会阻断。
 */
export function resolveBoundReference({
  name,
  params,
  media,
  imageLabel,
  isStale,
  mediaSupported,
}: {
  /** 提示词里写下的名字（不含 @） */
  name: string
  /** 节点参数，绑定都存在这里 */
  params: Record<string, unknown>
  /** 本次真正送入模型的媒体 */
  media: ReferenceMedia[]
  /** 图片的平台编号（图片节点「图N」、MiniMax 视频「图片N」、其余「@imageN」） */
  imageLabel(assetId: string): string | undefined
  /** 判断这条绑定是不是已经失效的残留 */
  isStale(binding: ReferenceIdentity): boolean
  /** 当前模型是否接收这类媒体；缺省兼容既有调用。 */
  mediaSupported?(kind: ReferenceIdentity['type']): boolean
}): BoundReference {
  const bindings = referenceBindings(params)
  const binding = bindings[name]
  if (!binding) {
    // 没有持久绑定的旧编号按同类媒体的实际送入顺序解析；越界时不能猜身份。
    const legacy = /^(image|video|audio)([1-9]\d*)$/.exec(name)
    if (legacy) {
      const kind = legacy[1] as ReferenceIdentity['type']
      const saved = params.referenceBindings
      // 断连清理会留下空的绑定表；这种旧编号是失效的持久引用，不能改指到别的素材。
      if (
        saved &&
        typeof saved === 'object' &&
        !Array.isArray(saved) &&
        Object.keys(saved).length === 0
      )
        return { text: `@${name}`, stale: true }
      if (mediaSupported && !mediaSupported(kind)) return { text: name }
      const current = media.filter((item) => item.type === kind)[Number(legacy[2]) - 1]
      if (current) {
        if (kind === 'image') {
          const label = imageLabel(current.assetId)
          if (label) return { text: label }
        } else return { text: `@${kind}${mediaIndex(media, current)}` }
      }
      return {
        text: `@${name}`,
        error: `引用 @${name} 尚未确认素材身份，请从参考素材重新选择`,
      }
    }
    return { text: name, error: `引用 @${name} 尚未确认素材身份，请从参考素材重新选择` }
  }
  if (mediaSupported && !mediaSupported(binding.type)) return { text: name }
  const named = Object.keys(params).some((key) =>
    key.startsWith(`referenceNameBinding:${encodeURIComponent(name)}:`),
  )
  const legacy = !named && /^(image|video|audio)[1-9]\d*$/.test(name)
  const current = media.find((item) =>
    legacy || !binding.source
      ? sameReference(binding, item)
      : binding.source === ('source' in item ? item.source : undefined) &&
        binding.type === item.type,
  )
  if (current) {
    if (current.type === 'image') {
      const label = imageLabel(current.assetId)
      if (label) return { text: label }
    } else {
      return { text: `@${current.type}${mediaIndex(media, current)}` }
    }
  }
  if (isStale(binding)) return { text: `@${name}`, stale: true }
  return { text: name, error: `引用 @${name} 的素材已删除、替换或未送入，请重新选择` }
}

/** 同类媒体里的第几个，从 1 开始。 */
function mediaIndex(media: ReferenceMedia[], value: ReferenceMedia) {
  let count = 0
  for (const item of media) {
    if (item.type !== value.type) continue
    count++
    if (item === value) return count
  }
  return count
}
