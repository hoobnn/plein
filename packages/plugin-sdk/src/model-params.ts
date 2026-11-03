import { mediaRequirementProblems, type MediaSample } from './media-requirements'
import type { Capability, ModelInfo } from './provider'
import { videoTaskOverrides } from './video-input'

/**
 * 模型对通用参数的约束检查：时长、画幅、张数、语速。
 * 前端提交前按模型的 limits 收窄表单，服务端按同一份声明再挡一次——
 * 走 Agent / MCP / 批量或分镜展开时参数没经过前端，越界值会直达平台。
 * 只看模型声明与节点参数，不读素材、不联网；返回第一条问题。
 */

/** 有时长范围的能力：视频、配乐、音效 */
const DURATION_CAPS: Capability[] = ['video.generate', 'audio.music', 'audio.sfx']

export function modelParamsProblem(
  model: ModelInfo,
  capability: Capability,
  params: Record<string, unknown>,
): string | null {
  const limits = model.limits
  if (!limits) return null
  const title = model.title
  // 平台自己在这些模式下接管时长 / 画幅（自适应时长、跟随画幅），此时不按用户取值判
  const overrides = (capability === 'video.generate' ? videoTaskOverrides(params) : {}) as {
    duration?: number
    aspectRatio?: string
  }

  if (DURATION_CAPS.includes(capability)) {
    const range = limits.duration
    const value = params.duration
    if (
      range &&
      typeof range === 'object' &&
      typeof value === 'number' &&
      value !== -1 &&
      overrides.duration === undefined &&
      (value < range.min || value > range.max)
    )
      return `${title} 的时长须为 ${range.min}–${range.max} 秒，现在是 ${value} 秒`
  }

  if (capability === 'video.generate') {
    const ratios = limits.aspectRatios
    const ratio = params.aspectRatio
    if (
      ratios &&
      typeof ratio === 'string' &&
      ratio !== '' &&
      !ratios.includes(ratio) &&
      overrides.aspectRatio === undefined
    )
      return `${title} 不支持画幅 ${ratio}`
    if (limits.count && typeof params.count === 'number' && params.count > limits.count.max)
      return `${title} 一次最多生成 ${limits.count.max} 条`
  }

  if (capability === 'audio.speech') {
    const speed = limits.speed
    if (speed && typeof speed === 'object') {
      const value = params.speed
      if (typeof value === 'number' && (value < speed.min || value > speed.max))
        return `${title} 的语速须为 ${speed.min}–${speed.max} 倍`
    } else if (speed === false) {
      const value = params.speed
      if (typeof value === 'number' && value !== 1)
        return `${title} 不支持调节语速，请把语速恢复为 1`
    }
  }

  if (
    capability === 'image.edit' &&
    limits.count &&
    typeof params.count === 'number' &&
    params.count > limits.count.max
  )
    return `${title} 一次最多生成 ${limits.count.max} 张`

  return null
}

/** 字节换算成 MB，最多留两位小数 */
const mbText = (bytes: number) => String(Math.round((bytes / 1024 / 1024) * 100) / 100)

/**
 * 语音识别素材的预检：按模型声明的音频要求（格式、大小、时长），
 * 用资产记录里的信息就能判断，不用等平台报错。返回第一条问题，null 表示满足。
 * 宿主在运行前拿到资产记录后调用（见 apps/server/src/runs/media-requirements.ts 的 audio 分支）。
 */
export function transcribeAudioProblem(
  model: ModelInfo,
  sample: MediaSample,
  name?: string,
): string | null {
  const requirement = model.limits?.media?.audio
  if (!requirement) return null
  if (typeof sample.size === 'number' && requirement.maxMB !== undefined) {
    const mb = sample.size / 1024 / 1024
    const over = requirement.maxMBExclusive ? mb >= requirement.maxMB : mb > requirement.maxMB
    if (over)
      return `${model.title} 要求音频不超过 ${requirement.maxMB} MB，${name ? `「${name}」` : '当前音频'}是 ${mbText(sample.size)} MB，请压缩后再运行`
  }
  return (
    mediaRequirementProblems(requirement, sample, {
      title: model.title,
      label: '识别音频',
      ...(name ? { name } : {}),
    })[0] ?? null
  )
}
