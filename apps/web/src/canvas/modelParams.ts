import {
  imageLimits,
  imageModelProblem,
  imageProcessProblem,
  selectedImageOptions,
  videoTaskOverrides,
  videoModelProblem,
  type ModelInfo,
  type ModelLimits,
} from '@plein/plugin-sdk'
import { VIDEO_MODE_LABELS, type VideoMode, videoModeProblem } from '@plein/nodes'
import type { Catalog } from '@plein/protocol'
import {
  aspectKey,
  aspectLabel,
  type FieldSchema,
  fieldsOf,
  type NodeInfo,
  type Upstream,
} from './nodes'

/**
 * 按所选模型的声明处理节点参数：收窄表单选项、换模型时校正取值、提交前检查。
 * 模型怎么声明见 plugin-sdk 的 ModelLimits / ModelSpec.options。
 */

export interface SelectedModel {
  /** 节点里存的引用 */
  ref: string
  info: ModelInfo & { ref: string }
}

/** 节点的模型参数名 */
function modelKey(node: NodeInfo) {
  return fieldsOf(node).find(([, f]) => f.widget === 'model')?.[0]
}

/** 节点参数里选中的模型；没选或所选平台没启用时为空 */
export function selectedModel(
  catalog: Catalog | null,
  node: NodeInfo,
  params: Record<string, unknown> | undefined,
): SelectedModel | undefined {
  const key = modelKey(node)
  if (!key) return undefined
  const ref = String(params?.[key] ?? '')
  if (!ref) return undefined
  const models = (catalog?.providers ?? [])
    .filter((p) => p.enabled)
    .flatMap((p) =>
      p.models
        .filter((m) => !node.capability || m.capabilities.includes(node.capability))
        .map((m) => ({ ...m, ref: `${p.id}:${m.id}` })),
    )
  const info = models.find((m) => m.ref === ref)
  return info ? { ref, info } : undefined
}

const NONE: ModelLimits = {}

/** 有范围约束的数值参数及其单位 */
const RANGED = { duration: '秒', speed: '倍' } as const
type Ranged = keyof typeof RANGED
const isRanged = (k: string): k is Ranged => k in RANGED
/** 模型可以声明为不支持（false）的参数 */
const TOGGLED = ['seed', 'duration', 'speed', 'instruction', 'temperature', 'audio'] as const
const unsupported = (k: string, limits: ModelLimits) =>
  (TOGGLED as readonly string[]).includes(k) && limits[k as (typeof TOGGLED)[number]] === false
const rangeOf = (k: Ranged, limits: ModelLimits) => {
  const r = limits[k]
  return r ? r : undefined
}

/** 精修参数（放大倍数、扩图各边比例）在模型声明里的范围；false 表示不支持 */
function processRange(k: string, limits: ModelLimits) {
  const rules = limits.process
  if (!rules) return undefined
  if (k === 'scale') return rules.scale
  if (['top', 'bottom', 'left', 'right'].includes(k)) return rules.expansion
  return undefined
}

/** 按模型约束改写字段：选项收窄、范围取交集，不支持的项去掉；专属参数单独渲染，这里也去掉 */
export function constrainFields(
  node: NodeInfo,
  fields: Array<[string, FieldSchema]>,
  limits: ModelLimits = NONE,
  params?: Record<string, unknown>,
  references = 0,
  model?: SelectedModel['info'],
): Array<[string, FieldSchema]> {
  if (node.capability === 'image.generate')
    limits = imageLimits(
      limits,
      { ...params, options: selectedImageOptions(params ?? {}) },
      references,
    )
  const ak = aspectKey(node)
  return fields.flatMap(([k, f]): Array<[string, FieldSchema]> => {
    if (f.widget === 'modelOptions') return []
    if (
      node.capability === 'image.generate' &&
      limits.image?.size &&
      selectedImageOptions(params ?? {}).size &&
      (k === ak || f.widget === 'resolution')
    )
      return []
    if (
      node.capability === 'video.generate' &&
      params &&
      Object.hasOwn(videoTaskOverrides(params), k)
    )
      return []
    if (node.capability === 'image.process' && params?.operation) {
      if (k === 'scale' && params.operation !== 'upscale') return []
      if (['top', 'bottom', 'left', 'right'].includes(k) && params.operation !== 'outpaint')
        return []
    }
    if (k === 'operation' && node.capability === 'image.process' && limits.imageOperations)
      return [[k, { ...f, enum: limits.imageOperations }]]
    if (node.capability === 'image.process') {
      const rule = processRange(k, limits)
      if (rule === false) return []
      if (rule)
        return [
          [
            k,
            {
              ...f,
              minimum: Math.max(f.minimum ?? rule.min, rule.min),
              maximum: Math.min(f.maximum ?? rule.max, rule.max),
            },
          ],
        ]
    }
    if (f.widget === 'resolution') {
      // 草稿模式等会进一步收窄分辨率：枚举里只留平台接受的值
      const narrowed =
        node.capability === 'video.generate' ? videoResolutions(model, params, limits) : undefined
      return limits.resolutions?.length
        ? [
            [
              k,
              {
                ...f,
                enum: narrowed
                  ? [...(narrowed.defaultBlocked ? [] : ['']), ...narrowed.options]
                  : ['', ...limits.resolutions],
                ...(limits.defaultResolution && !narrowed?.defaultBlocked
                  ? {
                      labels: {
                        ...f.labels,
                        '': `默认（${limits.defaultResolution}）`,
                      },
                    }
                  : {}),
              },
            ],
          ]
        : []
    }
    if (k === ak && f.enum) {
      // 没声明画幅的模型不给「智能」：auto 要模型明确支持
      let allowed = f.enum.filter((o) =>
        limits.aspectRatios ? limits.aspectRatios.includes(String(o)) : o !== 'auto',
      )
      // 有的模式不接受 auto（如部分视频的文生视频），选项按当前模式收窄
      if (model && params && node.capability === 'video.generate')
        allowed = videoAllowed(model, params, k, allowed).allowed
      return [[k, { ...f, enum: allowed.length ? allowed : f.enum }]]
    }
    if (unsupported(k, limits)) return []
    const range = isRanged(k) ? rangeOf(k, limits) : undefined
    if (range)
      return [
        [
          k,
          {
            ...f,
            minimum: Math.max(f.minimum ?? range.min, range.min),
            maximum: Math.min(f.maximum ?? range.max, range.max),
          },
        ],
      ]
    if (k === 'count' && limits.count) {
      const maximum = Math.min(f.maximum ?? limits.count.max, limits.count.max)
      return maximum <= (f.minimum ?? 1) ? [] : [[k, { ...f, maximum }]]
    }
    return [[k, f]]
  })
}

const NO_REFERENCES = { image: 0, video: 0, audio: 0 }

/**
 * 用 modelbay 的视频预检探测「把某字段改成某值」是否会被平台规则拦下，选项收窄与提交前检查因此共用同一份判断。
 * 不看参考素材数量（交给提交前检查），提示词用占位；返回问题文本，没有问题为 null。
 */
function videoProbe(
  model: SelectedModel['info'],
  params: Record<string, unknown>,
  patch: Record<string, unknown>,
) {
  return videoModelProblem(model, { ...params, ...patch }, NO_REFERENCES, 'x', {
    deferReferenceCounts: true,
  })
}

/**
 * 在候选值里去掉会被视频预检拦下的那些。与「不设该字段」的结果相同的问题算与该字段无关（如模式本身不支持），不算被拦。
 */
function videoAllowed(
  model: SelectedModel['info'],
  params: Record<string, unknown>,
  key: string,
  candidates: unknown[],
) {
  const base = videoProbe(model, params, { [key]: undefined })
  const problems = candidates.map((v) => videoProbe(model, params, { [key]: v }))
  return {
    base,
    allowed: candidates.filter((_, i) => problems[i] === null || problems[i] === base),
    /** 存在能通过的取值，而不设该字段本身过不了：说明默认值也被这条规则排除 */
    defaultBlocked: base !== null && problems.some((p) => p === null),
  }
}

/** 视频分辨率在当前参数下实际可选的取值；没有收窄时返回 undefined */
function videoResolutions(
  model: SelectedModel['info'] | undefined,
  params: Record<string, unknown> | undefined,
  limits: ModelLimits,
) {
  if (!model || !params || !limits.resolutions?.length) return undefined
  const { allowed, defaultBlocked } = videoAllowed(model, params, 'resolution', limits.resolutions)
  if (allowed.length === limits.resolutions.length && !defaultBlocked) return undefined
  return { options: allowed.map(String), defaultBlocked }
}

/** 当前分辨率不被接受时应改成的取值（留空 = 平台默认）；不需要改返回 undefined */
function narrowedResolution(
  model: SelectedModel['info'] | undefined,
  params: Record<string, unknown>,
  limits: ModelLimits,
  value: unknown,
) {
  const narrowed = videoResolutions(model, params, limits)
  if (!narrowed) return undefined
  const current = value ? String(value) : ''
  if (current ? narrowed.options.includes(current) : !narrowed.defaultBlocked) return undefined
  return narrowed.options[0] ?? ''
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n))

/**
 * 换到新模型时需要改的参数和对应说明：分辨率不支持改回默认，画幅换成第一个支持的，
 * 时长、张数夹到范围内。种子留着（隐藏且不会传给平台），换回来还在。
 */
export function adaptToModel(
  node: NodeInfo,
  params: Record<string, unknown>,
  model: SelectedModel['info'] | undefined,
  references = 0,
): { patch: Record<string, unknown>; notes: string[] } {
  const limits =
    node.capability === 'image.generate'
      ? imageLimits(model?.limits, { ...params, options: selectedImageOptions(params) }, references)
      : (model?.limits ?? NONE)
  const patch: Record<string, unknown> = {}
  const notes: string[] = []
  const name = model?.title ?? '所选模型'
  for (const [k, f] of fieldsOf(node)) {
    const v = params[k] ?? f.default
    if (
      node.capability === 'image.generate' &&
      limits.image?.size &&
      selectedImageOptions(params).size &&
      (k === aspectKey(node) || f.widget === 'resolution')
    )
      continue
    if (
      k === 'operation' &&
      node.capability === 'image.process' &&
      limits.imageOperations?.length &&
      !limits.imageOperations.includes(v as 'upscale' | 'outpaint' | 'cutout')
    ) {
      patch[k] = limits.imageOperations[0]
      notes.push('已切换为所选模型支持的精修操作')
    } else if (
      f.widget === 'resolution' &&
      node.capability === 'video.generate' &&
      narrowedResolution(model, params, limits, v) !== undefined
    ) {
      const next = narrowedResolution(model, params, limits, v)!
      patch[k] = next
      notes.push(`分辨率已改为 ${next}（当前设置下平台只接受这一档）`)
    } else if (f.widget === 'resolution' && v && !limits.resolutions?.includes(String(v))) {
      patch[k] = ''
      notes.push(`分辨率已改回默认（${name} 不支持 ${String(v)}）`)
    } else if (k === aspectKey(node) && v !== undefined) {
      const supported = limits.aspectRatios
      const video = !!model && node.capability === 'video.generate'
      // 当前模式不接受的画幅（如文生视频不接受 auto）也要纠正
      const rejected =
        video &&
        videoProbe(model, params, { [k]: v }) !== null &&
        videoProbe(model, params, { [k]: v }) !== videoProbe(model, params, { [k]: undefined })
      if (rejected || (supported ? !supported.includes(String(v)) : v === 'auto')) {
        let allowed = (f.enum ?? []).filter((o) =>
          supported ? supported.includes(String(o)) : o !== 'auto',
        )
        if (video) allowed = videoAllowed(model, params, k, allowed).allowed
        const next = allowed.includes('16:9') ? '16:9' : allowed.find((o) => o !== 'auto')
        if (next !== undefined) {
          patch[k] = next
          notes.push(
            `画幅已从 ${aspectLabel(v)} 改为 ${aspectLabel(next)}（${name} 不支持 ${aspectLabel(v)}）`,
          )
        }
      }
    } else if (k === 'speed' && limits.speed === false && typeof v === 'number' && v !== 1) {
      // 模型不支持调节语速：表单已隐藏该字段，旧值要恢复默认，否则执行器会照传给平台
      patch[k] = 1
      notes.push(`语速已恢复默认（${name} 不支持调节语速）`)
    } else if (
      k === 'temperature' &&
      limits.temperature === false &&
      typeof v === 'number' &&
      v !== (typeof f.default === 'number' ? f.default : 1)
    ) {
      // 推理模型不吃温度采样：表单已隐藏，值留着不传（换回支持的模型时还在），只在换过来时说一声
      notes.push(`${name} 不支持调节温度，已忽略`)
    } else if (isRanged(k) && typeof v === 'number' && rangeOf(k, limits)) {
      const r = rangeOf(k, limits)!
      const n = clamp(v, r.min, r.max)
      if (n !== v) {
        patch[k] = n
        const unit = RANGED[k]
        const label = f.title?.replace(/（.*）/, '') ?? k
        notes.push(
          `${label}已从 ${v} ${unit}改为 ${n} ${unit}（${name} 支持 ${r.min}–${r.max} ${unit}）`,
        )
      }
    } else if (k === 'count' && limits.count && typeof v === 'number' && v > limits.count.max) {
      patch[k] = limits.count.max
      const label = f.title?.replace(/（.*）/, '') ?? '张数'
      notes.push(
        `${label}已改为 ${limits.count.max}（${name} 最多 ${limits.count.max} ${node.capability === 'video.generate' ? '条' : '张'}）`,
      )
    }
  }
  return { patch, notes }
}

/** 提交前按模型约束检查，返回第一条问题 */
export function modelProblem(
  node: NodeInfo,
  params: Record<string, unknown>,
  model: SelectedModel['info'] | undefined,
  ups: Map<string, Upstream[]>,
): string | null {
  // 生成视频：连入的图片数要和所选模式对得上
  const video = node.capability === 'video.generate'
  const mode = String(params.mode ?? 'text') as VideoMode
  if (video) {
    const imageCount = ups.get('images')?.length ?? 0
    const videos = ups.get('videos')?.length ?? 0
    const audios = ups.get('audios')?.length ?? 0
    const prompt = [
      params.prompt ?? '',
      ...(ups.get('prompt') ?? []).map((u) => (u.value?.type === 'text' ? u.value.text : '')),
    ].join('\n')
    const softReferences = mode === 'reference' && prompt.includes('@')
    if (mode !== 'reference' && (videos || audios)) return '视频或音频参考需要选择多模态参考模式'
    // 视频 / 音频分开说：模型不支持某类参考时直接点名，超过上限时说明上限与实际连了多少。
    if (model) {
      const allowed = model.limits?.videoModes
      if (allowed && !allowed.some((m) => m === mode))
        return `${model.title} 不支持「${VIDEO_MODE_LABELS[mode] ?? mode}」模式，请更换模式或模型`
      const videoLimit = model.limits?.referenceMedia?.video ?? 0
      const audioLimit = model.limits?.referenceMedia?.audio ?? 0
      if (videos > videoLimit)
        return videoLimit > 0
          ? `当前模型最多支持 ${videoLimit} 段参考视频，现在连了 ${videos} 段`
          : '当前模型不支持参考视频'
      if (audios > audioLimit)
        return audioLimit > 0
          ? `当前模型最多支持 ${audioLimit} 段参考音频，现在连了 ${audios} 段`
          : '当前模型不支持参考音频'
    }
    const problem = videoModeProblem(
      mode,
      mode === 'reference' ? imageCount + videos + audios : imageCount,
    )
    if (problem && !softReferences) return problem
    if (model) {
      const upstreamPrompt = (ups.get('prompt') ?? [])
        .map((u) => (u.value?.type === 'text' ? u.value.text : ''))
        .join('\n')
      const issue = videoModelProblem(
        model,
        params,
        { image: imageCount, video: videos, audio: audios },
        [params.prompt ?? '', upstreamPrompt].join('\n'),
        // @角色等软引用会在服务端展开，只有那里掌握最终参考图数量和编号。
        { deferReferenceCounts: softReferences },
      )
      if (issue) return issue
    }
  }
  if (!model) return null
  // 对话模型不支持看图：图送进去也读不出来，前端先拦一次（服务端 prepare 对同一组合再挡一次）。
  // 这里能拿到 images 端口的连线，不用等实际输入预览。
  if (
    node.capability === 'text.chat' &&
    (ups.get('images')?.length ?? 0) > 0 &&
    !model.features?.includes('vision')
  )
    return `${model.title} 不支持看图，请换支持图片的模型或断开图片输入`
  if (node.capability === 'image.generate') {
    const issue = imageModelProblem(
      model,
      { ...params, options: selectedImageOptions(params) },
      ups.get('references')?.length ?? 0,
    )
    if (issue) return issue
  }
  if (node.capability === 'image.process') {
    const issue = imageProcessProblem(model, params)
    if (issue) return issue
  }
  const { patch } = adaptToModel(node, params, model)
  const limits = model.limits ?? NONE
  const name = model.title
  for (const [k, f] of fieldsOf(node)) {
    if (!(k in patch)) continue
    const v = params[k] ?? f.default
    if (f.widget === 'resolution') {
      const options = limits.resolutions ?? []
      return `${name} 不支持分辨率 ${String(v)}；${
        options.length ? `请选择 ${options.join('、')}，` : ''
      }或使用默认分辨率`
    }
    if (k === 'speed' && limits.speed === false) return `${name} 不支持调节语速，请把语速恢复为 1`
    if (isRanged(k)) {
      const r = rangeOf(k, limits)
      if (r) {
        const label = f.title?.replace(/（.*）/, '') ?? k
        return `${name} 的${label}须为 ${r.min}–${r.max} ${RANGED[k]}，现在是 ${String(v)} ${RANGED[k]}`
      }
    }
    // 与服务端同一说法：视频按条、图片按张
    if (k === 'count') return `${name} 一次最多生成 ${limits.count!.max} ${video ? '条' : '张'}`
    return `${name} 不支持${f.title ?? k} ${String(v)}`
  }
  // 参考图：图片节点的 references；生成视频只有图片参考模式才把图当参考
  const refs = video
    ? mode === 'reference'
      ? (ups.get('images')?.length ?? 0)
      : 0
    : (ups.get('references')?.length ?? 0)
  if (limits.references && refs > limits.references.max)
    return `${name} 最多支持 ${limits.references.max} 张参考图，现在连了 ${refs} 张`
  return null
}
