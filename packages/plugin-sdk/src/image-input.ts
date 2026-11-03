import type { ModelInfo, ModelLimits } from './provider'

export interface ImageParams {
  count?: unknown
  resolution?: unknown
  aspectRatio?: unknown
  /** 自定义宽高；成对出现，适配器会换算成平台尺寸 */
  width?: unknown
  height?: unknown
  negativePrompt?: unknown
  seed?: unknown
  options?: Record<string, unknown>
}

/** 节点按模型隔离保存的参数；不修改任何历史值。 */
export function selectedImageOptions(params: Record<string, unknown>): Record<string, unknown> {
  const options = params.options
  const value =
    options && typeof options === 'object' && !Array.isArray(options)
      ? (options as Record<string, unknown>)[String(params.model)]
      : undefined
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function imageLimits(
  limits: ModelLimits = {},
  params: ImageParams = {},
  references = 0,
): ModelLimits {
  const image = limits.image
  if (!image) return limits
  let resolutions = limits.resolutions
  const narrow = (allowed: string[] | undefined) => {
    if (allowed) resolutions = resolutions?.filter((r) => allowed.includes(r))
  }
  narrow(image.resolutionsByAspectRatio?.[String(params.aspectRatio)])
  if (references) narrow(image.referenceResolutions)
  const sequential = image.sequential && params.options?.[image.sequential.option] === true
  if (sequential) narrow(image.sequential?.resolutions)
  return {
    ...limits,
    resolutions,
    aspectRatios:
      image.resolutionRequiresAspectRatio && params.resolution && !params.options?.size
        ? limits.aspectRatios?.filter((ratio) => ratio !== 'auto')
        : limits.aspectRatios,
    ...(image.maxTotalImages
      ? {
          count: {
            max: Math.min(
              limits.count?.max ?? image.maxTotalImages,
              image.maxTotalImages - references,
            ),
          },
        }
      : {}),
    ...(sequential ? { count: { max: image.sequential!.maxCount } } : {}),
  }
}

/** 只检查参数，不读取素材、不联网；软引用在服务端展开后用最终数量再检查。 */
function resolutionProblem(
  model: ModelInfo,
  params: ImageParams,
  references: number,
  limits: ModelLimits,
  value: string,
) {
  const image = model.limits?.image
  const conditions: string[] = []
  // 只有基础档位支持、组合限制把它排除时，才把原因归于当前画幅或素材模式。
  if (model.limits?.resolutions?.includes(value)) {
    const byAspect = image?.resolutionsByAspectRatio?.[String(params.aspectRatio)]
    if (byAspect && !byAspect.includes(value))
      conditions.push(`当前画幅为 ${String(params.aspectRatio)}`)
    if (references && image?.referenceResolutions && !image.referenceResolutions.includes(value))
      conditions.push('当前使用参考图')
    const sequential = image?.sequential
    if (
      sequential &&
      params.options?.[sequential.option] === true &&
      sequential.resolutions &&
      !sequential.resolutions.includes(value)
    )
      conditions.push('当前开启组图模式')
  }
  const condition = conditions.length ? `（${conditions.join('，')}）` : ''
  const choices = limits.resolutions?.length ? limits.resolutions.join('、') : '模型支持的分辨率'
  return `${model.title} 不支持分辨率 ${value}${condition}；请选择 ${choices}，或使用默认分辨率`
}

function ratioLabel(value: number) {
  return value < 1 ? `1:${1 / value}` : `${value}:1`
}

export function imageModelProblem(model: ModelInfo, params: ImageParams, references: number) {
  const limits = imageLimits(model.limits, params, references)
  const count = params.count ?? 1
  if (!Number.isInteger(count) || Number(count) < 1) return '图片张数须为正整数'
  if (limits.references && references > limits.references.max)
    return `${model.title} 最多支持 ${limits.references.max} 张参考图，现在连了 ${references} 张`
  if (limits.image?.maxTotalImages && references + Number(count) > limits.image.maxTotalImages)
    return `${model.title} 参考图与生成图片合计最多 ${limits.image.maxTotalImages} 张`
  if (limits.count && Number(count) > limits.count.max)
    return `${model.title} 一次最多生成 ${limits.count.max} 张`
  const negative = negativePromptValue(params)
  if (limits.negativePrompt === false && negative)
    return `${model.title} 不支持反向提示词，请把内容合并到提示词里`
  // 种子和适配器一样：顶层取值优先，没填才看专属参数里的 seed
  const seedProblem = seedRangeProblem(
    limits.seed,
    params.seed ?? params.options?.seed,
    model.title,
  )
  if (seedProblem) return seedProblem
  const custom = customSizeProblem(model, params)
  if (custom) return custom
  const explicitSize = limits.image?.size && params.options?.size
  if (
    !explicitSize &&
    params.resolution &&
    !limits.resolutions?.includes(String(params.resolution))
  )
    return resolutionProblem(model, params, references, limits, String(params.resolution))
  if (
    !explicitSize &&
    params.aspectRatio &&
    limits.aspectRatios &&
    !limits.aspectRatios.includes(String(params.aspectRatio))
  )
    return `${model.title} 不支持画幅 ${String(params.aspectRatio)}`
  if (references) {
    for (const [key, values] of Object.entries(limits.image?.referenceForbiddenOptions ?? {}))
      if (values.includes(params.options?.[key]))
        return `${model.title} 有参考图时不支持 ${key}=${String(params.options?.[key])}`
  }
  const size = params.options?.size
  const rules = limits.image?.size
  if (size && rules) {
    if (size === 'auto' && rules.auto) return null
    if (rules.tiers?.includes(String(size)))
      return limits.resolutions?.includes(String(size))
        ? null
        : resolutionProblem(model, params, references, limits, String(size))
    const match = typeof size === 'string' ? /^([1-9]\d*)[x*]([1-9]\d*)$/.exec(size) : null
    if (!match) return '自定义尺寸须为正整数宽*高'
    const width = Number(match[1]),
      height = Number(match[2])
    const sequential = limits.image?.sequential
    const maxPixels = Math.min(
      rules.maxPixels,
      references ? (rules.maxPixelsWithReferences ?? rules.maxPixels) : rules.maxPixels,
      sequential && params.options?.[sequential.option] === true
        ? (rules.maxPixelsSequential ?? rules.maxPixels)
        : rules.maxPixels,
    )
    if (
      !Number.isSafeInteger(width * height) ||
      width * height < rules.minPixels ||
      width * height > maxPixels ||
      width / height < rules.minRatio ||
      width / height > rules.maxRatio
    )
      return `${model.title} 自定义尺寸须在 ${rules.minPixels}–${maxPixels} 像素（宽×高）之间、宽高比 ${ratioLabel(rules.minRatio)}–${ratioLabel(rules.maxRatio)}，现在是 ${width}*${height}`
  }
  return null
}

/** 反向提示词的取值：模型参数本身，或专属参数里的同名项 */
function negativePromptValue(params: ImageParams) {
  for (const value of [
    params.negativePrompt,
    params.options?.negative_prompt,
    params.options?.negativePrompt,
  ])
    if (typeof value === 'string' && value.trim()) return value
  return undefined
}

/** 种子范围：声明范围时只接受范围内的整数 */
function seedRangeProblem(
  range: boolean | { min: number; max: number } | undefined,
  value: unknown,
  title: string,
) {
  if (!range || typeof range === 'boolean' || typeof value !== 'number') return null
  if (Number.isInteger(value) && value >= range.min && value <= range.max) return null
  return `${title} 的种子须为 ${range.min}–${range.max} 的整数，现在是 ${value}`
}

/** 自定义宽高：声明了范围或明确不支持时，运行前就能说清有没有问题 */
function customSizeProblem(model: ModelInfo, params: ImageParams) {
  const rules = model.limits?.customSize
  if (rules === undefined) return null
  const { width, height } = params
  if (width === undefined && height === undefined) return null
  if ((width === undefined) !== (height === undefined))
    return `${model.title} 的自定义宽高须一起填写`
  const w = Number(width)
  const h = Number(height)
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1)
    return `${model.title} 的自定义宽高须为正整数，现在是 ${String(width)}×${String(height)}`
  if (rules === false) return `${model.title} 不支持自定义宽高，请改用画幅和分辨率`
  const multiple = rules.multiple
  const step = multiple ? `且为 ${multiple} 的倍数` : ''
  if (
    w < rules.min ||
    w > rules.max ||
    h < rules.min ||
    h > rules.max ||
    (multiple !== undefined && (w % multiple !== 0 || h % multiple !== 0))
  )
    return `${model.title} 的自定义宽高须为 ${rules.min}–${rules.max} 像素${step}，现在是 ${w}×${h}`
  return null
}

/** 精修各边的说法 */
const EXPANSION_LABELS = { top: '向上', bottom: '向下', left: '向左', right: '向右' } as const

/**
 * 图片精修（image.process）的范围预检：放大倍数、扩图各边比例。
 * 只看模型声明与节点参数，不读素材；返回第一条问题。
 */
export function imageProcessProblem(
  model: ModelInfo,
  params: Record<string, unknown>,
): string | null {
  const limits = model.limits
  if (!limits) return null
  const operation = params.operation
  if (limits.imageOperations && !limits.imageOperations.includes(operation as never))
    return `${model.title} 不支持这项精修操作，请更换模型`
  const rules = limits.process
  if (!rules) return null
  if (operation === 'upscale') {
    if (rules.scale === false) return `${model.title} 不支持 AI 高清放大，请更换操作或模型`
    const scale = rules.scale
    const value = params.scale
    if (scale && typeof value === 'number' && (value < scale.min || value > scale.max))
      return `${model.title} 放大倍数须为 ${scale.min}–${scale.max}，现在是 ${value}`
  }
  if (operation === 'outpaint') {
    if (rules.expansion === false) return `${model.title} 不支持扩图，请更换操作或模型`
    const expansion = rules.expansion
    if (expansion)
      for (const side of ['top', 'bottom', 'left', 'right'] as const) {
        const value = params[side]
        if (typeof value === 'number' && (value < expansion.min || value > expansion.max))
          return `${model.title} 扩图${EXPANSION_LABELS[side]}比例须为 ${expansion.min}–${expansion.max}，现在是 ${value}`
      }
  }
  return null
}
