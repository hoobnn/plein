import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  CapabilityError,
  type ContentBlock,
  capabilityFor,
  content,
  link,
  mentionElements,
  need,
  nodeElementOf,
  placeNew,
  promptField,
  summarize,
} from '@plein/capabilities'
import {
  clearShotGroup,
  currentResult,
  elementMedia,
  groupShots,
  layoutShotGroup,
  makeShotGroup,
  mediaSize,
  moveShot,
  type PleinDoc,
  setParams,
  shotGroupOf,
} from '@plein/doc'
import { type ContinuesFrom, continueShotParams, nearestAspect } from '@plein/nodes'
import {
  MediaDeriveRequest,
  MediaDerivationOrigin,
  type MediaDerivation,
  MediaOp,
} from '@plein/protocol'
import sharp, { type Sharp } from 'sharp'
import { z } from 'zod'
import { collageAssets } from '../assets/collage'
import { DeriveError, deriveAsset } from '../assets/derive'
import { inputContextOf, PromptError, rewritePrompt, usesH3Structure } from '../prompt/rewrite'
import { NodeRunError } from '../plugins/provider-protocol'
import { ffmpegBin, hasFfmpeg } from '../assets/media'
import type { ServerContext } from './tool-registry'

const exec = promisify(execFile)

const id = z.string().min(1).max(200)
const serverCapability = capabilityFor<ServerContext>()

const asset = (ctx: ServerContext, assetId: string) => {
  const a = ctx.env.assets.get(ctx.env.ownerId, assetId)
  if (!a) throw new CapabilityError(`资产 ${assetId} 不存在`)
  return a
}

export const viewMedia = serverCapability({
  name: 'view_media',
  title: '查看效果',
  description:
    '查看图片 / 视频 / 音频的内容：图片返回缩略图，视频按时间均匀抽帧，音频返回时长和台词。用来检查生成效果。传资产 id，或传元素 id（取它的素材或当前结果）。',
  group: 'media',
  where: 'server',
  effect: 'read',
  input: z.object({
    asset_id: z.string().optional(),
    element_id: id.optional(),
    frames: z.number().int().min(1).max(8).default(4).describe('视频抽几帧'),
  }),
  run: async (ctx, a) => {
    const assetId =
      a.asset_id ??
      (a.element_id
        ? ctx.withDoc((doc) => elementMedia(need(doc, a.element_id!))?.assetId)
        : undefined)
    if (!assetId) throw new CapabilityError('需要 asset_id，或一个有媒体内容的 element_id')
    const meta = asset(ctx, assetId)
    const src = ctx.env.assets.originalPath(assetId)
    const info = `${meta.kind}，${meta.mime}${meta.width ? `，${meta.width}×${meta.height}` : ''}${meta.duration ? `，${meta.duration.toFixed(1)} 秒` : ''}；source_asset_id=${assetId}${a.element_id ? `；element_id=${a.element_id}` : ''}`
    if (meta.kind === 'image') {
      return content([{ type: 'text', text: info }, await jpeg(sharp(src).rotate())])
    }
    if (meta.kind === 'video') {
      if (!(await hasFfmpeg())) return `${info}；本机没有 ffmpeg，无法抽帧`
      const d = meta.duration ?? 1
      const blocks: ContentBlock[] = [{ type: 'text', text: info }]
      for (let i = 0; i < a.frames; i++) {
        const t = (d * (i + 0.5)) / a.frames
        const { stdout } = await exec(
          ffmpegBin(),
          [
            '-v',
            'error',
            '-ss',
            t.toFixed(2),
            '-i',
            src,
            '-frames:v',
            '1',
            '-f',
            'image2pipe',
            '-c:v',
            'png',
            '-',
          ],
          { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 60_000 },
        )
        blocks.push({ type: 'text', text: `${t.toFixed(1)} 秒` }, await jpeg(sharp(stdout), 640))
      }
      return content(blocks)
    }
    const caption = a.element_id
      ? ctx.withDoc((doc) => {
          const v = currentResult(need(doc, a.element_id!))?.value
          return v && 'caption' in v ? v.caption : undefined
        })
      : undefined
    return caption ? `${info}；台词：${caption}` : info
  },
})

/**
 * 把加工协议的判别联合拍平成工具入参字段。
 * 同名字段各分支约束不同时取并集（如 crop 的 left/top 允许 0，repair-region 要求 ≥1），
 * 否则拍平会用更严的那一支挡掉本合法的入参；各操作自己的严格约束仍由 MediaDeriveRequest 校验。
 */
function flatDeriveFields(): Record<string, z.ZodType> {
  const fields: Record<string, z.ZodType[]> = {}
  for (const option of MediaDeriveRequest.options)
    for (const [key, schema] of Object.entries(option.shape)) {
      if (key === 'op' || key === 'assetId') continue
      ;(fields[key] ??= []).push(schema)
    }
  return Object.fromEntries(
    Object.entries(fields).map(([key, schemas]) => {
      // 只有一个分支的字段照搬协议里的写法
      if (schemas.length === 1) return [key, schemas[0]!.optional()]
      // 多个分支的字段取各分支约束的并集；默认值是 op 自己的规定，拍平层不能带，
      // 否则会替 op 填上本该必填的字段（如 replace-range 的 start）
      const loose = [
        ...new Map(
          schemas
            .map((s) => (s instanceof z.ZodDefault ? (s.unwrap() as z.ZodType) : s))
            .map((s) => [JSON.stringify(z.toJSONSchema(s)), s] as const),
        ).values(),
      ]
      // 各分支约束相同的字段只留一份，避免 schema 里出现重复分支
      const schema =
        loose.length === 1 ? loose[0]! : z.union(loose as [z.ZodType, z.ZodType, ...z.ZodType[]])
      return [key, schema.optional()]
    }),
  )
}

export const editMedia = serverCapability({
  name: 'edit_media',
  title: '加工素材',
  description:
    '加工素材，与画布上的加工工具条是同一套实现：trim 截取片段（start、end 秒）、speed 变速（speed 倍数）、separate 把视频分离成音轨和无声视频（要去掉原声就用分出来的无声视频）、frame 抽一帧成图片（at 秒）、crop 按摆正后的像素裁剪图片或视频（left、top、width、height；视频宽高须为偶数，保留首条音轨）、rotate / flip 只处理图片、split 把音频按区间切开（segments）；repair-region 用本地插值修补视频固定区域（left/top/width/height、start/end）；replace-range 用 replacementAssetId 的片段替换 start/end 区间（replacementStart 指定替换素材入点）；frame 支持 last=true 尾帧，speed 支持 keepPitch。结果是新资产，作为元素放在原元素旁边，原素材不变；要做多步就依次调用。',
  group: 'media',
  where: 'server',
  effect: 'edit',
  input: z.object({
    element_id: id.optional().describe('素材元素或节点（取当前结果）'),
    asset_id: z.string().optional(),
    op: MediaOp,
    // 加工协议是判别联合，同名字段各分支约束不同（crop 的 left/top 允许 0，repair-region 要求 ≥1）。
    // 拍平后取各分支约束的并集，各操作自己的严格约束仍由 MediaDeriveRequest 校验。
    ...flatDeriveFields(),
  }),
  run: async (ctx, { element_id, asset_id, ...edit }) => {
    const source = element_id ? ctx.withDoc((doc) => need(doc, element_id)) : undefined
    const sourceMap = element_id ? ctx.withDoc((doc) => doc.elementMaps.get(element_id)) : undefined
    // 开始时元素上的素材；加工期间变了就不能再往画布上写
    const sourceAssetId = element_id
      ? ctx.withDoc((doc) => elementMedia(need(doc, element_id))?.assetId)
      : undefined
    const assetId = asset_id ?? sourceAssetId
    if (!assetId) throw new CapabilityError('需要素材的 asset_id 或 element_id')
    if (source?.locked) throw new CapabilityError('素材已锁定')
    const req = MediaDeriveRequest.safeParse({ ...edit, assetId })
    if (!req.success) throw new CapabilityError(`参数不对：${z.prettifyError(req.error)}`)
    let made: MediaDerivation
    try {
      made = await deriveAsset(ctx.env.assets, ctx.env.ownerId, req.data)
    } catch (err) {
      if (err instanceof DeriveError) throw new CapabilityError(err.message)
      throw err
    }
    return ctx.withDoc((doc: PleinDoc) => {
      if (element_id) {
        const current = need(doc, element_id)
        if (
          current.locked ||
          doc.elementMaps.get(element_id) !== sourceMap ||
          elementMedia(current)?.assetId !== sourceAssetId
        )
          throw new CapabilityError('来源已变化或锁定，加工资产已保存，未写入画布')
      }
      const origin = MediaDerivationOrigin.safeParse({
        version: 1,
        op: made.op,
        source: made.source,
        params: made.params,
      })
      const elements = made.assets.flatMap((out) => {
        const kind = out.kind
        if (kind !== 'image' && kind !== 'video' && kind !== 'audio') return []
        const size = mediaSize(kind, out.width, out.height)
        const elId = placeNew(
          doc,
          { near: element_id },
          {
            kind,
            assetId: out.id,
            name: out.name,
            ...(origin.success ? { params: { mediaDerivation: origin.data } } : {}),
            ...size,
          },
        )
        return [{ id: elId, kind, asset_id: out.id, duration: out.duration }]
      })
      return { elements, ...(made.note ? { note: made.note } : {}) }
    })
  },
})

export const continueShot = serverCapability({
  name: 'continue_shot',
  title: '取帧续镜',
  description:
    '取帧续镜：从一段视频（视频素材或视频节点的当前结果）取一帧（不给 at 时取尾帧），在右边接一个图生视频节点，那一帧连成它的首帧，并在新节点上记下父视频；父镜头是同类视频节点时沿用模型、时长、画幅。只建不跑，写好 prompt 后用 run_node 生成。和画布上的「续镜」按钮是同一套规则。',
  group: 'media',
  where: 'server',
  effect: 'edit',
  input: z.object({
    element_id: id.describe('父镜头：视频元素或已出视频的节点'),
    at: z.number().min(0).optional().describe('取帧时刻（秒），不填取尾帧'),
    prompt: z.string().max(4000).optional().describe('下一个镜头的提示词'),
    name: z.string().max(100).optional(),
  }),
  run: async (ctx, a) => {
    const src = ctx.withDoc((doc) => {
      const el = need(doc, a.element_id)
      const media = elementMedia(el)
      if (media?.kind !== 'video') throw new CapabilityError(`${a.element_id} 当前没有视频`)
      const own =
        a.at === undefined && el.kind === 'node' ? currentResult(el, 'lastFrame') : undefined
      return {
        assetId: media.assetId,
        name: el.name ?? '视频',
        nodeType: el.kind === 'node' ? el.nodeType : undefined,
        params: el.params,
        lastFrame: own?.value.type === 'image' ? own.value.assetId : undefined,
      }
    })
    const same = src.nodeType ? ctx.nodes.latest(src.nodeType) : undefined
    const info = same?.def.capability === 'video.generate' ? same : ctx.nodes.latest('plein/video')
    if (!info) throw new CapabilityError('没有能做图生视频的节点')
    const last = a.at === undefined
    let frame:
      | { id: string; name: string; width?: number; height?: number; at?: number }
      | undefined
    if (!src.lastFrame) {
      try {
        const made = await deriveAsset(ctx.env.assets, ctx.env.ownerId, {
          op: 'frame',
          assetId: src.assetId,
          at: a.at ?? 0,
          ...(last ? { last: true } : {}),
          name: `${src.name} · ${last ? '尾帧' : `${a.at}s`}`,
        })
        const out = made.assets[0]
        if (!out) throw new CapabilityError('没取到画面')
        const at = typeof made.params.at === 'number' ? made.params.at : undefined
        frame = { id: out.id, name: out.name, width: out.width, height: out.height, at }
      } catch (err) {
        if (err instanceof DeriveError) throw new CapabilityError(err.message)
        throw err
      }
    }
    const from: ContinuesFrom = {
      elementId: a.element_id,
      assetId: src.assetId,
      ...(last ? { last: true } : {}),
      ...(frame?.at !== undefined ? { at: frame.at } : a.at !== undefined ? { at: a.at } : {}),
      frameAssetId: frame?.id ?? src.lastFrame,
    }
    const { descriptor: desc } = info
    const props =
      (desc.paramsSchema as { properties?: Record<string, { enum?: unknown[] }> }).properties ?? {}
    const aspect = nearestAspect(props.aspectRatio?.enum ?? [], frame?.width, frame?.height)
    const params = continueShotParams({
      defaults: desc.defaults,
      keys: Object.keys(props),
      parent: same === info ? src.params : undefined,
      aspect: aspect !== undefined ? { key: 'aspectRatio', value: aspect } : undefined,
      from,
      prompt: a.prompt,
    })
    return ctx.withDoc((doc) => {
      need(doc, a.element_id)
      let fromId = a.element_id
      let fromPort = 'lastFrame'
      if (frame) {
        const size = mediaSize('image', frame.width, frame.height)
        fromId = placeNew(
          doc,
          { near: a.element_id },
          { kind: 'image', assetId: frame.id, name: frame.name.replace(/\.png$/, ''), ...size },
        )
        fromPort = 'image'
      }
      const nodeId = placeNew(
        doc,
        { near: fromId },
        { ...nodeElementOf(desc, params), name: a.name ?? `${src.name} · 续镜` },
      )
      link(doc, fromId, fromPort, nodeId, 'images')
      return {
        id: nodeId,
        frame_element_id: frame ? fromId : undefined,
        continues_from: from,
        element: summarize(doc, need(doc, nodeId), false),
        next: a.prompt ? '用 run_node 生成' : '先写 prompt（update_element 改参数），再 run_node',
      }
    })
  },
})

export const shotGroup = serverCapability({
  name: 'shot_group',
  title: '分镜组',
  description:
    '把一个分组框设成分镜组：组里的图片按顺序编号（画布上显示角标），能排版、拼成大图。order 给出的元素按给定顺序排在最前；arrange 为 true 时按顺序排成 cols 列网格（只挪位置不改大小，分组框收到刚好包住）；clear 为 true 时取消分镜组，图片都留着。返回组里镜头的顺序。和分组框工具条上的「分镜组」是同一套规则。',
  group: 'edit',
  where: 'server',
  effect: 'edit',
  input: z.object({
    frame_id: id.describe('分组框元素'),
    order: z.array(id).max(64).optional().describe('想要的镜头顺序（元素 id），没列的接在后面'),
    arrange: z.boolean().default(false),
    cols: z.number().int().min(1).max(16).optional(),
    clear: z.boolean().default(false),
  }),
  run: (ctx, a) =>
    ctx.withDoc((doc) => {
      const frame = need(doc, a.frame_id)
      if (frame.kind !== 'frame') throw new CapabilityError(`${a.frame_id} 不是分组框`)
      if (a.clear) {
        clearShotGroup(doc, a.frame_id)
        return { frame_id: a.frame_id, shot_group: false }
      }
      if (!shotGroupOf(frame)) makeShotGroup(doc, a.frame_id, a.cols ? { cols: a.cols } : {})
      a.order?.forEach((el, i) => moveShot(doc, a.frame_id, el, i))
      const cols = a.arrange ? layoutShotGroup(doc, a.frame_id, a.cols) : undefined
      return {
        frame_id: a.frame_id,
        shot_group: true,
        cols: cols ?? shotGroupOf(doc.get(a.frame_id))?.cols,
        shots: groupShots(doc, a.frame_id).map((el, i) => ({ n: i + 1, id: el.id, name: el.name })),
      }
    }),
})

export const makeCollage = serverCapability({
  name: 'make_collage',
  title: '拼成大图',
  description:
    '把分镜组（不是分镜组的分组框先按阅读顺序编号）里的图片按顺序拼成一张大图，放在分组框右边；每格大小一致（取第一张的比例），等比放进格子，numbers 为 true 时在左上角印序号。返回新图片元素和实际像素。本地加工，不调模型。',
  group: 'media',
  where: 'server',
  effect: 'edit',
  input: z.object({
    frame_id: id.describe('分组框元素'),
    cols: z.number().int().min(1).max(16).optional().describe('列数，不填按分镜组记的列数'),
    numbers: z.boolean().default(true),
    name: z.string().max(100).optional(),
  }),
  run: async (ctx, a) => {
    const src = ctx.withDoc((doc) => {
      const frame = need(doc, a.frame_id)
      if (frame.kind !== 'frame') throw new CapabilityError(`${a.frame_id} 不是分组框`)
      const assetIds = groupShots(doc, a.frame_id).flatMap((el) => {
        const m = elementMedia(el)
        return m?.kind === 'image' ? [m.assetId] : []
      })
      return { assetIds, name: frame.name ?? '分镜组', cols: shotGroupOf(frame)?.cols }
    })
    if (src.assetIds.length < 2) throw new CapabilityError('组里至少要两张图才能拼')
    const cols = a.cols ?? src.cols ?? Math.ceil(Math.sqrt(src.assetIds.length))
    let made
    try {
      made = await collageAssets(ctx.env.assets, ctx.env.ownerId, {
        assetIds: src.assetIds,
        cols,
        numbers: a.numbers,
        name: a.name ?? `${src.name} · 拼图`,
      })
    } catch (err) {
      if (err instanceof DeriveError) throw new CapabilityError(err.message)
      throw err
    }
    return ctx.withDoc((doc) => {
      // 画布上和分镜组一样宽
      const fw = need(doc, a.frame_id).w
      const size = { w: fw, h: Math.round((fw * made.height) / made.width) }
      const elId = placeNew(
        doc,
        { near: a.frame_id },
        {
          kind: 'image',
          assetId: made.asset.id,
          name: `${a.name ?? `${src.name} · 拼图`} ${made.width}×${made.height}`,
          ...size,
        },
      )
      return {
        id: elId,
        asset_id: made.asset.id,
        width: made.width,
        height: made.height,
        cols: made.cols,
        rows: made.rows,
      }
    })
  },
})

async function jpeg(img: Sharp, size = 768): Promise<ContentBlock> {
  const buf = await img
    .resize(size, size, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer()
  return { type: 'image', data: buf.toString('base64'), mimeType: 'image/jpeg' }
}

export const rewrite = serverCapability({
  name: 'rewrite_prompt',
  title: '改写提示词',
  description:
    '用对话模型改写节点的提示词：mode=optimize 补全画面 / 镜头细节，translate 中英互译。@ 引用和【占位】原样保留。默认直接写回节点，apply=false 时只返回结果。' +
    '生成模型取自节点当前的 params.model，参考素材取自节点的实际输入（与 inspect_node_input 同源），所以先用 set_node_model 选好模型、连好参考再改写。' +
    'structure：auto（默认）在生成模型是 MiniMax H3 且节点是多模态参考模式时用 H3 六段结构，其余用通用公式；default 强制通用公式；h3 强制六段结构（节点模型须是 H3）。' +
    'detail：expand（默认）补全细节，refine 只精修表达、不新增内容。model：改写用的对话模型 ref（来自 list_models 的 text.chat），不填用第一个已启用的对话模型。',
  group: 'edit',
  where: 'server',
  effect: (a) => (a.apply === false ? 'read' : 'edit'),
  input: z.object({
    id,
    mode: z.enum(['optimize', 'translate']).default('optimize'),
    apply: z.boolean().default(true),
    structure: z.enum(['auto', 'default', 'h3']).default('auto'),
    detail: z.enum(['refine', 'expand']).default('expand'),
    model: z.string().max(200).optional().describe('改写用的对话模型 ref；不填用默认对话模型'),
  }),
  run: async (ctx, a) => {
    const { key, text, target, mentions, generationModel, nodeType } = ctx.withDoc((doc) => {
      const el = need(doc, a.id)
      const key = promptField(el.params)
      const text = key ? String(el.params?.[key] ?? '').trim() : ''
      if (!key || !text) throw new CapabilityError('这个节点没有可改写的提示词')
      const capability = el.nodeType ? ctx.nodes.latest(el.nodeType)?.def.capability : undefined
      const target = capability?.startsWith('video.') ? ('video' as const) : ('image' as const)
      // 节点当前选的生成模型；已停用或能力不符的不传，免得改写被「目标模型不可用」拦下
      const picked = String(el.params?.model ?? '')
      const usable =
        picked && capability && ctx.nodes.models(capability).some((m) => m.ref === picked)
      return {
        key,
        text,
        target,
        mentions: [...mentionElements(doc).keys()],
        generationModel: usable ? picked : undefined,
        nodeType: el.kind === 'node' ? el.nodeType : undefined,
      }
    })
    // 实际输入预览与界面同源；非运行节点或准备不过去时没有上下文，照常改写
    let inputContext: ReturnType<typeof inputContextOf> | undefined
    if (nodeType) {
      try {
        inputContext = inputContextOf(
          await ctx.env.runs.preview(ctx.env.canvasId, a.id, ctx.env.ownerId),
        )
      } catch (err) {
        if (!(err instanceof NodeRunError)) throw err
      }
    }
    try {
      const out = await rewritePrompt(
        ctx.env.host,
        {
          text,
          mode: a.mode,
          target,
          detail: a.detail,
          structure: a.structure,
          ...(a.model ? { model: a.model } : {}),
          ...(generationModel ? { generationModel } : {}),
          ...(inputContext ? { inputContext } : {}),
          mentions,
        },
        {
          ownerId: ctx.env.ownerId,
          signal: AbortSignal.any([
            AbortSignal.timeout(120_000),
            ...(ctx.env.execution ? [ctx.env.execution.abort.signal] : []),
          ]),
        },
      )
      if (a.apply) ctx.withDoc((doc) => setParams(doc, a.id, { [key]: out.text }))
      return {
        [key]: out.text,
        applied: a.apply,
        rewrite_model: out.model,
        ...(generationModel ? { generation_model: generationModel } : {}),
        structure:
          a.mode === 'optimize' &&
          usesH3Structure({ structure: a.structure, generationModel, inputContext })
            ? 'h3'
            : 'default',
      }
    } catch (err) {
      if (err instanceof PromptError) throw new CapabilityError(err.message)
      throw err
    }
  },
})
