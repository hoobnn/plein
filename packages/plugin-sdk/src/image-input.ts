import type { ModelInfo, ModelLimits } from './provider'

export interface ImageParams {
  count?: unknown
  resolution?: unknown
  aspectRatio?: unknown
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
