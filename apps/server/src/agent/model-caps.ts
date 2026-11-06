import {
  adaptToModel,
  CapabilityError,
  capabilityFor,
  constrainFields,
  fieldsOf,
  need,
  selectedModel,
  summarize,
  type ModelCatalogLike,
} from '@plein/capabilities'
import {
  aspectSize,
  inputEdges,
  parseAspect,
  setParams,
  updateElement,
  videoAssetOf,
} from '@plein/doc'
import { Capability, modelParamOf, modelRef, type ModelInfo } from '@plein/plugin-sdk'
import { z } from 'zod'
import { NodeRunError } from '../plugins/provider-protocol'
import { catalogOf } from '../plugins/routes'
import type { ServerContext } from './tool-registry'

const id = z.string().min(1).max(200)
const serverCapability = capabilityFor<ServerContext>()

interface Row {
  ref: string
  provider: string
  providerTitle: string
  enabled: boolean
  configured: boolean
  remoteOnly: boolean
  info: ModelInfo
}

/** 目录里的全部模型（含未启用平台的），去掉仅供内置智能体用的 */
function rowsOf(ctx: ServerContext): Row[] {
  return catalogOf(ctx.env.host).providers.flatMap((p) =>
    p.models
      .filter((m) => !m.agentOnly)
      .map((m) => ({
        ref: modelRef(p.id, m.id),
        provider: p.id,
        providerTitle: p.title,
        enabled: p.enabled,
        configured: p.configured,
        remoteOnly: m.remoteOnly === true,
        info: m,
      })),
  )
}

/** 选模型时最常用的几项约束，摘要里带上，细节用 ref 下钻 */
function highlights(info: ModelInfo) {
  const l = info.limits
  if (!l) return undefined
  const out: Record<string, unknown> = {}
  if (l.resolutions?.length) out.resolutions = l.resolutions
  if (l.aspectRatios?.length) out.aspect_ratios = l.aspectRatios
  if (l.duration) out.duration = l.duration
  if (l.videoModes?.length) out.video_modes = l.videoModes
  if (l.count) out.count = l.count
  if (l.references) out.references = l.references
  return Object.keys(out).length ? out : undefined
}

export const listModels = serverCapability({
  name: 'list_models',
  title: '查看模型目录',
  description:
    '列出模型目录：按能力（capability，如 image.generate、video.generate、text.chat、audio.speech）筛选。' +
    '不带 ref 返回摘要（ref、title、provider、enabled 是否已启用平台、features、价格、简介、主要约束 highlights、有无专属参数）；' +
    '带 ref 返回这个模型的完整 limits（分辨率、画幅、时长、模式、参考数量等）、options_schema（模型专属参数的 JSON Schema，节点 params.options[ref] 按它写）、完整简介和可用节点类型。' +
    '通常只关心能用的，传 enabled_only=true。ref 填进节点前先用它核对约束；换模型用 set_node_model，不要直接改 params.model。' +
    '发现顺序：list_canvas_capabilities → list_canvas_actions → list_node_types → list_models。',
  group: 'read',
  where: 'server',
  effect: 'read',
  input: z.object({
    ref: z.string().max(200).optional().describe('模型 ref（平台:模型），给了就返回完整详情'),
    capability: Capability.optional().describe('只列支持这种能力的模型'),
    enabled_only: z.boolean().default(false).describe('只列已启用平台的模型'),
    include_deprecated: z.boolean().default(false).describe('包含已弃用的模型'),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(100).default(60),
  }),
  run: (ctx, a) => {
    const rows = rowsOf(ctx)
    const defaults = ctx.env.host.defaultModels() as Record<string, string>
    const defaultFor = (ref: string) =>
      Object.entries(defaults)
        .filter(([, v]) => v === ref)
        .map(([k]) => k)
    if (a.ref) {
      const row = rows.find((r) => r.ref === a.ref)
      if (!row)
        throw new CapabilityError(`没有模型 ${a.ref}，不带 ref 调用 list_models 查看可用模型`)
      const { info } = row
      const nodes = ctx.nodes
        .all()
        .filter(
          (n) => n.descriptor.capability && info.capabilities.includes(n.descriptor.capability),
        )
        .map((n) => ({
          type: n.descriptor.type,
          title: n.descriptor.title,
          model_param: modelParamOf(n.descriptor),
        }))
      return {
        ref: row.ref,
        title: info.title,
        provider: row.provider,
        provider_title: row.providerTitle,
        enabled: row.enabled,
        configured: row.configured,
        capabilities: info.capabilities,
        ...(info.features?.length ? { features: info.features } : {}),
        ...(info.deprecated ? { deprecated: true } : {}),
        ...(row.remoteOnly ? { remote_only: true } : {}),
        ...(info.price ? { price: info.price } : {}),
        default_for: defaultFor(row.ref),
        description: info.description,
        limits: info.limits ?? {},
        options_schema: info.optionsSchema,
        ...(info.promptGuide ? { prompt_guide_version: info.promptGuide.version } : {}),
        ...(info.voices?.length ? { voices: info.voices } : {}),
        node_types: nodes,
      }
    }
    const matched = rows.filter(
      (r) =>
        (!a.capability || r.info.capabilities.includes(a.capability)) &&
        (!a.enabled_only || r.enabled) &&
        (a.include_deprecated || !r.info.deprecated),
    )
    const page = matched.slice(a.offset, a.offset + a.limit)
    const next = a.offset + page.length
    return {
      total: matched.length,
      models: page.map((r) => ({
        ref: r.ref,
        title: r.info.title,
        provider: r.provider,
        enabled: r.enabled,
        capabilities: r.info.capabilities,
        ...(r.info.features?.length ? { features: r.info.features } : {}),
        ...(r.info.deprecated ? { deprecated: true } : {}),
        ...(r.info.price ? { price: r.info.price } : {}),
        default_for: defaultFor(r.ref),
        description: r.info.description?.slice(0, 100),
        highlights: highlights(r.info),
        has_options: r.info.optionsSchema !== undefined,
      })),
      ...(next < matched.length ? { next_offset: next } : {}),
    }
  },
})

/** 取值不同才算改了 */
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** 模型不暴露、但节点上带着非默认值的参数：值保留，只是不会传给平台 */
const HIDEABLE = new Set([
  'seed',
  'duration',
  'speed',
  'instruction',
  'temperature',
  'audio',
  'count',
])

export const setNodeModel = serverCapability({
  name: 'set_node_model',
  title: '切换节点模型',
  description:
    '给节点换模型，并像界面一样校正依赖模型的参数：不支持的分辨率改回默认，不支持的画幅（含 auto/智能，或当前模式不接受的画幅）换成支持的，时长和张数夹进模型范围，' +
    '草稿模式等专属参数引起的分辨率限制，精修操作换成模型支持的。种子等模型不支持的参数会保留但不再传给平台（返回 ignored_params），换回支持的模型时还在。' +
    '模型专属参数按模型 ref 分别保存，换模型不会丢。返回 changed（改了哪些参数：from → to）和 notes（原因）。model 必须是已启用平台里支持该节点能力的模型 ref（list_models enabled_only=true）。' +
    '不要用 update_element 直接写 params.model，那样不会校正其他参数。',
  group: 'edit',
  where: 'server',
  effect: 'edit',
  input: z.object({ id: id.describe('节点'), model: z.string().min(1).max(200) }),
  run: async (ctx, a) => {
    const target = ctx.withDoc((doc) => {
      const el = need(doc, a.id)
      const desc =
        el.kind === 'node' && el.nodeType ? ctx.nodes.latest(el.nodeType)?.descriptor : undefined
      if (!desc) throw new CapabilityError(`${a.id} 不是工作流节点`)
      const key = modelParamOf(desc)
      if (!key) throw new CapabilityError(`节点 ${desc.type} 不选择模型`)
      return { desc, key, params: { ...desc.defaults, ...el.params } as Record<string, unknown> }
    })
    const { desc, key } = target
    const catalog: ModelCatalogLike = catalogOf(ctx.env.host)
    const next = { ...target.params, [key]: a.model }
    const picked = selectedModel(catalog, desc, next)
    if (!picked) {
      const row = rowsOf(ctx).find((r) => r.ref === a.model)
      if (!row) throw new CapabilityError(`没有模型 ${a.model}，用 list_models 查看可用模型`)
      if (!row.enabled)
        throw new CapabilityError(
          `${row.info.title} 所在平台没有启用，先让用户在设置里启用，或换已启用的模型`,
        )
      throw new CapabilityError(
        `${row.info.title} 不支持 ${desc.capability} 能力，不能用于节点 ${desc.type}`,
      )
    }
    // 图片生成的参考张数影响可选参数：与界面一样优先看实际输入预览，备不出来时数连线
    let references = 0
    if (desc.capability === 'image.generate') {
      try {
        const input = await ctx.env.runs.preview(ctx.env.canvasId, a.id, ctx.env.ownerId)
        references = input.inputs.references?.filter((v) => v.type === 'image').length ?? 0
      } catch (err) {
        if (!(err instanceof NodeRunError)) throw err
        references = ctx.withDoc((doc) => inputEdges(doc, a.id, 'references').length)
      }
    }
    const { patch, notes } = adaptToModel(desc, next, picked.info, references)
    const hidden = new Set(
      fieldsOf(desc)
        .map(([k]) => k)
        .filter(
          (k) =>
            !constrainFields(
              desc,
              fieldsOf(desc),
              picked.info.limits,
              { ...next, ...patch },
              references,
              picked.info,
            ).some(([kk]) => kk === k),
        ),
    )
    return ctx.withDoc((doc) => {
      const el = need(doc, a.id)
      const before = { ...desc.defaults, ...el.params } as Record<string, unknown>
      const changed: Record<string, { from: unknown; to: unknown }> = {}
      const writes: Record<string, unknown> = { [key]: a.model, ...patch }
      for (const [k, v] of Object.entries(writes))
        if (!same(before[k], v)) changed[k] = { from: before[k], to: v }
      setParams(doc, a.id, writes)
      // 画幅变了卡片跟着变形（保持长边与中心）；已有视频结果时卡片跟视频走
      const ak = fieldsOf(desc).find(([k, f]) => /aspect/i.test(k) && f.enum)?.[0]
      const ratio = ak && patch[ak] !== undefined ? parseAspect(patch[ak]) : null
      if (ratio && !videoAssetOf(el)) {
        const { w, h } = aspectSize(ratio, Math.max(el.w, el.h))
        updateElement(doc, a.id, {
          w,
          h,
          x: Math.round(el.x + (el.w - w) / 2),
          y: Math.round(el.y + (el.h - h) / 2),
        })
      }
      const ignored = [...hidden].filter(
        (k) =>
          HIDEABLE.has(k) &&
          before[k] !== undefined &&
          !same(before[k], (desc.defaults as Record<string, unknown>)[k]),
      )
      return {
        id: a.id,
        model: a.model,
        title: picked.info.title,
        previous_model: before[key] || undefined,
        changed,
        notes,
        ...(ignored.length ? { ignored_params: ignored } : {}),
        has_model_options: picked.info.optionsSchema !== undefined,
        element: summarize(doc, need(doc, a.id), false),
      }
    })
  },
})

export const modelCapabilities = [listModels, setNodeModel]
