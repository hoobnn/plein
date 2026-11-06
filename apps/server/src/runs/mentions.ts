import type { CanvasElement, PleinDoc } from '@plein/doc'
import {
  findBrokenMentions,
  findMentions,
  hasVoice,
  type Mention,
  mentionName,
  mentionProblem,
  pickEmpty,
  pickImages,
  pickLabel,
  type ProfilePick,
  pickVoice,
  profileOf,
  sceneViewsOf,
  type SceneView,
  type VoiceRef,
  voiceFitsProvider,
  voiceOf,
} from '@plein/nodes'
import {
  type NodeDefinition,
  parseModelRef,
  type PortValue,
  referenceLabelStyle,
  referenceMediaNumbering,
  type ReferenceMediaKind,
} from '@plein/plugin-sdk'
import type { InputIssue, InputRef, InputRefKind } from '@plein/protocol'

import { NodeRunError } from '../plugins/provider-protocol'
import { type BriefFamily, bindingSuffix, bindingText, briefFamily } from './reference-brief'
import { speechProviderTitle } from '../executors/audio'

type Inputs = Record<string, PortValue[]>

/** 本次运行真正送进模型的资产引用，用于「执行前展示实际引用映射」 */
interface UsedRef {
  /** 提示词里写的名字 */
  name: string
  /** 画布上的元素 id */
  elementId: string
  /** 真正送进去的图片资产：卡片连入的参考图，或图片元素本身 */
  assetIds: string[]
}

/** 引用后的参数与输入；refs 与 notices 供宿主写进运行状态 */
export interface AppliedMentions {
  params: Record<string, unknown>
  inputs: Inputs
  refs: UsedRef[]
  /** 不阻断运行、但用户该知道的提示（音色无法校验、@ 名字可能已改名、可选参考降级） */
  notices: InputIssue[]
  /** 每个引用的实际用法：能提供哪些素材、送了哪些、没送的原因、是否必需；供实际输入预览与执行记录 */
  details: InputRef[]
  /** 必需参考用不上（缺图、当前模式不收、放不下）：这个镜头不提交 */
  blocked: InputIssue[]
}

/** 画布上可被 @ 引用的东西：资产卡（角色、场景、道具、风格、特效）和有名字的媒体元素 */
export interface MentionElement {
  id: string
  name: string
  el: CanvasElement
  profile?: ReturnType<typeof profileOf>
  sceneViews?: SceneView[]
}

/** 列出可被 @ 引用的元素；重名不合并，由 `#序号` 消歧（序号顺序见 sortMentionTargets） */
export function mentionTargets(doc: PleinDoc): MentionElement[] {
  const out: MentionElement[] = []
  for (const el of doc.elements()) {
    const name = mentionName(el)
    if (!name) continue
    const profile = el.nodeType === 'plein/character' ? profileOf(el.params?.profile) : undefined
    out.push({
      id: el.id,
      name,
      el,
      ...(profile ? { profile } : {}),
      ...(el.nodeType === 'plein/scene' ? { sceneViews: sceneViewsOf(el.params?.sceneViews) } : {}),
    })
  }
  return out
}

/**
 * 提示词里的 @ 引用当作依赖边：被引用的卡片 → 引用它的节点。
 * 调度时据此先跑卡片上游（例如连进角色卡的定妆图），再跑 @ 它的镜头图；画布上不画这些边。
 */
export function mentionEdges(doc: PleinDoc) {
  const targets = mentionTargets(doc)
  const edges: Array<{ from: [string, string]; to: [string, string] }> = []
  if (targets.length === 0) return edges
  for (const el of doc.elements()) {
    if (el.kind !== 'node') continue
    for (const value of Object.values(el.params ?? {})) {
      if (typeof value !== 'string' || !value.includes('@')) continue
      for (const m of findMentions(value, targets))
        if (m.id && m.id !== el.id) edges.push({ from: [m.id, '@'], to: [el.id, '@'] })
    }
  }
  return edges
}

/** 一段需要解析 @ 的文本，以及把最终内容写回参数或上游输入的入口。 */
interface MentionText {
  value: string
  write(text: string): void
}

/** 引用到的一个资产：写下来的名字与它在同名里的序号（重名时提示用） */
interface Hit {
  name: string
  /** 同名目标里的第几个（0 起）；只有重名时用得上 */
  index: number
  total: number
  el: CanvasElement
  /** `@林夏/少年/校服` 里写明的档案项 */
  pick: ProfilePick
  sceneView?: SceneView
}

const label = (h: Hit) => {
  const base = pickLabel(h.total > 1 ? `${h.name}#${h.index + 1}` : h.name, h.pick)
  return h.sceneView ? `${base}（${h.sceneView.name}）` : base
}

/** 同一个角色写了不同的档案项（`@林夏/童年` 和 `@林夏/青年`）算两处引用 */
const hitKey = (h: Hit) =>
  [
    h.el.id,
    h.pick.period?.id,
    h.pick.outfit?.id,
    h.pick.expression?.id,
    h.pick.voiceState?.id,
    h.sceneView?.id,
  ].join('/')

/** 提示词里 @ 的名字，对应到画布上的元素；消歧问题不抛错，写进 blocked 让预览照常给出 */
function checkMention(
  m: Mention,
  byId: Map<string, CanvasElement>,
  blocked: InputIssue[],
): Hit | undefined {
  // 重名没写序号、序号越界：不能猜，否则引用会悄悄串到另一个资产上。
  // 不再抛错把整个节点打成 unprepared（预览完全看不到）：照常准备，这条引用
  // 不自动改写，blocked 与「未送入」列表（mention_ambiguous）都会提示该改成哪个写法。
  const problem = mentionProblem(m)
  if (problem) blocked.push({ code: 'prepare_failed', message: problem })
  const el = m.id ? byId.get(m.id) : undefined
  if (!el) return undefined
  if (m.sceneViewMiss !== undefined)
    throw new NodeRunError(
      'invalid_input',
      `「${m.name}」的视角「${m.sceneViewMiss}」不存在，请重新选择视角`,
    )
  return {
    name: m.name,
    index: m.ids.indexOf(m.id!),
    total: m.total,
    el,
    pick: m.pick ?? {},
    sceneView: m.sceneView,
  }
}

/**
 * 运行前处理提示词里的 @ 引用：
 * - 文本里的 `@林夏` 换成 `林夏`，不隐式追加资产卡或档案项的文字设定；
 * - 被引用者的参考图并入节点的 `references` 输入（去重）；生成视频只在「多模态参考」模式并入 `images`；
 * - 配音节点没选音色、且只引用了一个有音色的角色时用它的音色——但只有同一家平台才沿用，
 *   跨平台的音色 ID 送过去多半是乱读，宁可停下来让用户重选；
 * - 模型声明了参考图上限（maxRefs）时，节点自己连入的图先占位，再按角色、场景、道具的顺序
 *   每张卡先放一张，有余量再放其余的；放不下的卡不送参考图，并提示用户；
 * - 汇总本次真正送进模型的引用（refs）和需要用户知道的提示（notices）。
 * 返回新的参数与输入，不改文档。
 */
export async function applyMentions(
  doc: PleinDoc,
  el: CanvasElement,
  def: NodeDefinition,
  inputs: Inputs,
  collect: (id: string) => Promise<Inputs>,
  maxRefs?: number,
  validateSceneViewImage?: (assetId: string) => Promise<boolean>,
  mediaLimits: Record<'video' | 'audio', number> = {
    video: Number.MAX_SAFE_INTEGER,
    audio: Number.MAX_SAFE_INTEGER,
  },
  opts?: {
    /** 对话模型（LLM）是否支持看图：模型声明了 vision 才把 @ 引用的图并入 images */
    acceptsImages?: boolean
    /** 当前注册表的平台显示名，用于跨平台音色提醒。 */
    providerTitle?: (provider: string) => string | undefined
  },
): Promise<AppliedMentions> {
  const params = { ...el.params }
  const targets = mentionTargets(doc)
  const byId = new Map(targets.map((t) => [t.id, t.el]))
  const hit = new Map<string, Hit>()
  const notices: InputIssue[] = []
  const blocked: InputIssue[] = []
  const numbered =
    def.capability === 'image.generate' ||
    (def.capability === 'video.generate' && params.mode === 'reference')
  const texts: MentionText[] = []
  for (const [key, value] of Object.entries(params)) {
    if (typeof value !== 'string' || !value.includes('@')) continue
    texts.push({ value, write: (text) => (params[key] = text) })
  }
  // 上游文本与本节点正文共用同一套引用解析，最终拼接前已经完成编号和去重。
  for (const item of inputs.prompt ?? []) {
    if (item.type !== 'text' || !item.text.includes('@')) continue
    texts.push({ value: item.text, write: (text) => (item.text = text) })
  }
  const deferred = new Map<MentionText, Array<{ mention: Mention; hit?: Hit }>>()
  for (const source of texts) {
    const { value } = source
    const found = findMentions(value, targets).filter((m) => m.id !== el.id)
    const broken = findBrokenMentions(value, targets)
    if (found.length === 0) {
      for (const b of broken) notices.push(brokenNotice(b.name, b.candidates))
      continue
    }
    let text = ''
    let last = 0
    for (const m of found) {
      const h = checkMention(m, byId, blocked)
      if (numbered) {
        const list = deferred.get(source) ?? []
        list.push({ mention: m, ...(h ? { hit: h } : {}) })
        deferred.set(source, list)
      } else if (h) {
        // 非参考模式沿用原行为：只去掉 @，保留参考用途原文，不插入平台编号。
        text += `${value.slice(last, m.start)}${h.sceneView ? `${m.name}（${h.sceneView.name}）` : pickLabel(m.name, m.pick ?? {})}`
        last = m.end
      }
      // 消歧失败的引用（h 为空）不改写：原文（含 @ 与 #序号）保留在最终提示词里。
      if (h) hit.set(hitKey(h), h)
      if (m.profileMiss)
        notices.push({
          code: 'profile_miss',
          message: `「${m.name}」的档案里没有「${m.profileMiss}」，这一段按普通文字处理`,
          ...(m.id ? { elementId: m.id } : {}),
        })
      if (m.profileConflict)
        notices.push({
          code: 'profile_conflict',
          message: `@${m.name}：${m.profileConflict}`,
          ...(m.id ? { elementId: m.id } : {}),
        })
    }
    if (!numbered) source.write(text + value.slice(last))
    for (const b of broken) notices.push(brokenNotice(b.name, b.candidates))
  }
  if (hit.size === 0) return { params, inputs, refs: [], notices, details: [], blocked }

  const required = requiredOrder(params.requiredRefs, doc)
  const groups: Group[] = []
  const refList: UsedRef[] = []
  const details: InputRef[] = []
  const imageDetails: InputRef[] = []
  const mediaDetails: InputRef[] = []
  const detailByHit = new Map<string, InputRef>()
  const voices: Array<{ name: string; voice: VoiceRef }> = []
  /** 参考图来自生成失败的上游（记下是哪个节点，供提示定位）：和「还没生成或没连」分开提示 */
  const failedRefs = new Map<string, Array<{ id: string; name: string }>>()
  const imageValidation = new Map<string, Promise<boolean>>()
  const sceneImageUsable = (assetId: string) => {
    if (!validateSceneViewImage) return Promise.resolve(true)
    let checked = imageValidation.get(assetId)
    if (!checked) {
      checked = Promise.resolve()
        .then(() => validateSceneViewImage(assetId))
        .catch(() => false)
      imageValidation.set(assetId, checked)
    }
    return checked
  }
  for (const h of hit.values()) {
    const target = h.el
    const priority = required.get(target.id) ?? -1
    if (target.kind === 'image' && target.assetId) {
      groups.push({
        rank: RANK.length,
        priority,
        images: [{ type: 'image', assetId: target.assetId, kind: 'image', source: target.id }],
      })
      refList.push({ name: label(h), elementId: target.id, assetIds: [target.assetId] })
      const current = detail(target, label(h), priority, [target.assetId], hitIdentity(h))
      details.push(current)
      imageDetails.push(current)
      detailByHit.set(hitKey(h), current)
      continue
    }
    if ((target.kind === 'video' || target.kind === 'audio') && target.assetId) {
      const current = detail(target, label(h), priority, [target.assetId], hitIdentity(h))
      details.push(current)
      mediaDetails.push(current)
      detailByHit.set(hitKey(h), current)
      continue
    }
    if (target.nodeType === 'plein/effect') {
      const own = await collect(target.id)
      const candidates = (own.references ?? []).filter((value) => value.type === 'video')
      const current = detail(
        target,
        label(h),
        priority,
        mediaIds(candidates, 'video'),
        hitIdentity(h),
      )
      details.push(current)
      mediaDetails.push(current)
      detailByHit.set(hitKey(h), current)
      continue
    }
    const v = pickVoice(h.pick, voiceOf(target.params))
    if (hasVoice(v)) voices.push({ name: label(h), voice: v })
    const own = await collect(target.id)
    const base = (own.references ?? []).filter((v) => v.type === 'image')
    if (base.length === 0) {
      const failed = failedReferenceSources(doc, target.id)
      if (failed.length) failedRefs.set(target.id, failed)
    }
    // 只校验实际送入模型的截图；全景原始来源缺失不会误阻断已有截图。
    const invalidViewImages = h.sceneView
      ? (
          await Promise.all(
            h.sceneView.images.map(async (assetId) =>
              (await sceneImageUsable(assetId)) ? null : assetId,
            ),
          )
        ).filter((assetId): assetId is string => assetId !== null)
      : []
    const invalidViewIds = new Set(invalidViewImages)
    // 写了档案项：命中项的图排前面，再补卡片的参考图，每个角色截到上限
    const candidates = h.sceneView
      ? h.sceneView.images
          .filter((assetId) => !invalidViewIds.has(assetId))
          .map((assetId): PortValue => ({
            type: 'image',
            assetId,
            kind: 'image',
            source: target.id,
          }))
      : pickEmpty(h.pick)
        ? base
        : pickImages(h.pick, imageIds(base)).map(
            (id): PortValue =>
              base.find((b) => 'assetId' in b && b.assetId === id) ?? {
                type: 'image',
                assetId: id,
                kind: 'image',
                source: target.id,
              },
          )
    if (h.sceneView && invalidViewImages.length > 0)
      blocked.push({
        code: 'prepare_failed',
        elementId: target.id,
        message: `「${label(h)}」的参考图不可用（不存在、类型不符或原件缺失），请重新选择视角图片`,
      })
    else if (h.sceneView && candidates.length === 0)
      blocked.push({
        code: 'prepare_failed',
        elementId: target.id,
        message: `「${label(h)}」没有参考图，请补齐该视角图片`,
      })
    const rawPicks = params.referenceImagePicks
    const asked =
      target.nodeType === 'plein/character' &&
      rawPicks &&
      typeof rawPicks === 'object' &&
      !Array.isArray(rawPicks)
        ? (rawPicks as Record<string, unknown>)[target.id]
        : undefined
    const selected = Array.isArray(asked)
      ? [...new Set(asked.filter((v): v is string => typeof v === 'string'))]
      : undefined
    const available = imageIds(candidates)
    if (selected?.some((id) => !available.includes(id)))
      blocked.push({
        code: 'prepare_failed',
        elementId: target.id,
        message: `「${label(h)}」选定的参考图已不可用，请重新选择；不会自动换成其他图片`,
      })
    const images =
      selected === undefined
        ? candidates
        : selected.flatMap((id) => candidates.filter((v) => v.type === 'image' && v.assetId === id))
    const rank = RANK.indexOf(target.nodeType ?? '')
    groups.push({ rank: rank < 0 ? RANK.length : rank, priority, images })
    refList.push({
      name: label(h),
      elementId: target.id,
      assetIds: imageIds(images),
    })
    const current = {
      ...detail(target, label(h), priority, available, hitIdentity(h)),
      ...(selected !== undefined ? { selected } : {}),
    }
    details.push(current)
    imageDetails.push(current)
    detailByHit.set(hitKey(h), current)
  }

  if (def.capability === 'audio.speech' && !hasVoice(voiceOf(params)))
    applyVoice(params, voices, notices, opts?.providerTitle)

  // 参考图并到哪个输入：图片节点等是 references；生成视频只有「多模态参考」模式才把图当参考主体；
  // 对话模型（LLM）的图片端口是 images：模型声明了 vision（支持看图）才并入
  const video = def.capability === 'video.generate'
  const chat = def.capability === 'text.chat'
  const chatImages = chat && def.inputs.some((p) => p.id === 'images' && p.type === 'image')
  const port = video || chatImages ? 'images' : 'references'
  const send =
    def.inputs.some((p) => p.id === port && p.type === 'image') &&
    (!video || params.mode === 'reference') &&
    (!chatImages || opts?.acceptsImages === true)
  if (!send && groups.some((g) => g.images.length)) {
    if (video) {
      const framed = new Set(imageIds(inputs[port] ?? []))
      const ignored = refList.flatMap((r) =>
        r.assetIds.length && !r.assetIds.some((id) => framed.has(id)) ? [r.name] : [],
      )
      if (ignored.length)
        notices.push({
          code: 'unsupported_refs',
          message: `@ 引用的参考图（${ignored.join('、')}）只在「多模态参考」模式下送入模型；当前模式未送入，仅保留提示词中的引用名称，不追加文字设定`,
        })
    } else {
      // 这个节点不收参考图：@ 引用的图只留下名字，不能让人以为图送进去了
      const ignored = refList.flatMap((r) => (r.assetIds.length ? [r.name] : []))
      if (ignored.length)
        notices.push({
          code: 'unsupported_refs',
          message: `@ 引用的参考图（${ignored.join('、')}）这个节点不送入模型，仅保留提示词中的引用名称，不追加文字设定`,
        })
    }
    for (const r of refList) r.assetIds = []
  }

  for (const d of details) {
    if (!d.required) continue
    // 视频、音频、特效卡说「参考视频 / 参考音频」，别都说参考图
    const media = d.media === 'video' ? '参考视频' : d.media === 'audio' ? '参考音频' : '参考图'
    if (!send)
      blocked.push({
        code: 'required_unsupported',
        elementId: d.elementId,
        message: video
          ? `「${d.name}」是必需参考，当前模式不送${media}，请切到「多模态参考」或取消必需`
          : `「${d.name}」是必需参考，这个节点不收${media}`,
      })
    else if (d.selected?.length === 0 || d.available.length === 0)
      blocked.push(
        failedRefs.has(d.elementId)
          ? {
              code: 'required_failed',
              elementId: d.elementId,
              message: `「${d.name}」是必需参考，但它的参考图生成失败了（来自${sourceNames(failedRefs.get(d.elementId)!)}），请重新生成或取消必需`,
            }
          : {
              code: 'required_no_image',
              elementId: d.elementId,
              message: `「${d.name}」是必需参考，但还没有可用的${media}（未生成或没连）`,
            },
      )
  }

  const own = send ? (inputs[port] ?? []) : []
  const refs = send ? pickRefs(own, groups, refList, imageDetails, maxRefs, notices, blocked) : []
  for (const [i, d] of imageDetails.entries()) {
    d.sent = send ? refList[i]!.assetIds : []
    if (d.selected?.some((id) => !d.available.includes(id))) d.reason = 'selection_missing'
    else if (d.available.length === 0)
      d.reason = failedRefs.has(d.elementId) ? 'failed' : 'no_image'
    else if (!send) d.reason = 'unsupported'
    else if (d.sent.length < (d.selected ?? d.available).length) d.reason = 'over_limit'
  }
  // 可选参考的上游失败不阻断运行，但同样要在提示里定位到失败的上游节点；
  // 必需参考的失败已经在 blocked（required_failed）里说明，不重复一条提示。
  for (const [elementId, sources] of failedRefs) {
    const d = details.find((item) => item.elementId === elementId)
    if (!d || d.required || d.reason !== 'failed') continue
    notices.push({
      code: 'prepare_failed',
      elementId,
      message: `「${d.name}」的参考图来自${sourceNames(sources)}，最近一次运行失败，未送入；请重新生成后再运行`,
    })
  }

  // 本次真正送进去的东西带到执行器（宿主不把运行摘要传下去，见 node 定义的 usedRefs 注释）
  params.usedRefs = refList

  let merged =
    send && refs.length
      ? {
          ...inputs,
          [port]: dedupe([...own, ...refs]),
        }
      : inputs
  for (const kind of ['video', 'audio'] as const) {
    const referenced = mediaDetails.filter((d) => d.media === kind)
    if (!referenced.length) continue
    const mediaPort = kind === 'video' ? 'videos' : 'audios'
    const limit = mediaLimits[kind]
    // 多模态参考模式、端口也在：只是名额为 0 时，模型根本不支持这类素材，
    // 与「不是参考模式 / 没有这个端口」要分开说，不能悄悄把必需参考丢掉。
    const referenceMode =
      video &&
      params.mode === 'reference' &&
      def.inputs.some((p) => p.id === mediaPort && p.type === kind)
    const supported = referenceMode && limit > 0
    // 节点自己连线进来的同类素材先占名额：它们不被舍弃，超出上限由 runs.ts 阻断。
    const ownMedia = merged[mediaPort] ?? []
    const ownIds = mediaIds(ownMedia, kind)
    if (!supported) {
      const dropped: string[] = []
      for (const d of referenced) {
        d.sent = []
        if (d.available.length === 0) d.reason = 'no_image'
        else {
          d.reason = 'unsupported'
          if (!referenceMode) continue
          if (d.required)
            blocked.push({
              code: 'required_unsupported',
              elementId: d.elementId,
              message: `「${d.name}」是必需参考，但当前模型不支持参考${kind === 'video' ? '视频' : '音频'}，请取消必需或换模型`,
            })
          else dropped.push(d.name)
        }
      }
      // 同一次取舍只给一条汇总，避免每个没送入的引用重复同一段话。
      if (dropped.length)
        notices.push({
          code: 'unsupported_refs',
          message: `当前模型不支持参考${kind === 'video' ? '视频' : '音频'}，${dropped.join('、')} 的参考${kind === 'video' ? '视频' : '音频'}没有送入`,
        })
      continue
    }
    // 名额分配：必需参考按 requiredRefs 的先后在前，可选参考保持出现顺序在后；
    // 每个引用先放第一条，有余量再放其余的（与参考图的取舍同思路）。
    const seen = new Set(ownIds)
    const kept = new Set<string>()
    const take = (assetId: string) => {
      if (seen.has(assetId)) return true
      if (seen.size >= limit) return false
      seen.add(assetId)
      kept.add(assetId)
      return true
    }
    const order = referenced
      .map((d, i) => ({ d, i }))
      .sort((a, b) => mediaPriority(a.d, required) - mediaPriority(b.d, required) || a.i - b.i)
    for (const { d } of order) {
      const first = d.available[0]
      if (!first || take(first)) continue
      if (d.required)
        blocked.push({
          code: 'required_over_limit',
          elementId: d.elementId,
          message: `「${d.name}」是必需参考，但这个模型最多带 ${limit} 段参考${kind === 'video' ? '视频' : '音频'}，放不下了，请减少必需参考或换模型`,
        })
    }
    for (const { d } of order) for (const assetId of d.available.slice(1)) take(assetId)
    const picked = referenced.flatMap((d) =>
      d.available
        .filter((assetId) => kept.has(assetId))
        .map((assetId): PortValue => ({ type: kind, assetId, kind, source: d.elementId })),
    )
    if (ownMedia.length || picked.length)
      merged = { ...merged, [mediaPort]: dedupe([...ownMedia, ...picked]) }
    const finalIds = mediaIds(merged[mediaPort] ?? [], kind)
    const dropped: string[] = []
    for (const d of referenced) {
      d.sent = d.available.filter((id) => finalIds.includes(id))
      if (d.available.length === 0) d.reason = 'no_image'
      else if (d.sent.length < d.available.length) {
        d.reason = 'over_limit'
        if (!d.required) dropped.push(d.name)
      }
    }
    // 同一次取舍只给一条汇总，避免每个被舍弃的引用重复同一段话。
    if (dropped.length)
      notices.push({
        code: 'optional_dropped',
        message: `这个模型最多带 ${limit} 段参考${kind === 'video' ? '视频' : '音频'}，${dropped.join('、')} 的参考${kind === 'video' ? '视频' : '音频'}没有送入`,
      })
  }
  const provider = parseModelRef(String(params.model ?? ''))?.provider
  if (numbered) {
    // 每类媒体各自编号：名称绑定、旧编号与 @ 引用都按最终送入顺序取号。
    const style = referenceLabelStyle(def.capability, provider)
    const media = [...(merged[port] ?? []), ...(merged.videos ?? []), ...(merged.audios ?? [])]
    rewriteReferenceMentions(
      deferred,
      detailByHit,
      referenceMediaNumbering(style, media),
      // 没有专门写法的平台（含 mock）沿用「名字（编号）」
      briefFamily(def.capability, provider) ?? 'image',
    )
  }
  return { params, inputs: merged, refs: refList, notices, details, blocked }
}

/** 正文直接写最终平台编号；画布原文不变，也不再追加一份容易失配的「参考对应」表。 */
function rewriteReferenceMentions(
  deferred: Map<MentionText, Array<{ mention: Mention; hit?: Hit }>>,
  details: Map<string, InputRef>,
  numbering: { label(kind: ReferenceMediaKind, assetId: string): string | undefined },
  family: BriefFamily,
) {
  for (const [source, occurrences] of deferred) {
    let text = source.value
    for (const { mention, hit } of occurrences.toReversed()) {
      const current = hit ? details.get(hitKey(hit)) : undefined
      const tokens = current
        ? [
            ...new Set(
              current.sent.flatMap((id) => {
                const label = numbering.label(current.media ?? 'image', id)
                return label ? [label] : []
              }),
            ),
          ]
        : []
      // 正文里的名字保持可读：#序号只用于区分同名资产，不写进正文。
      const name = hit?.sceneView
        ? `${mention.name}（${hit.sceneView.name}）`
        : pickLabel(mention.name, mention.pick ?? {})
      // 资产卡按平台推荐写法绑定编号；原文紧挨着已经写了同一个名字时只补编号，避免「叶舒叶舒」。
      const repeated = !!hit && text.slice(0, mention.start).endsWith(name)
      // 消歧失败的引用不猜对象：原文原样保留，同一句里的有效引用照常编号。
      const replacement = !hit
        ? text.slice(mention.start, mention.end)
        : hit.el.kind === 'image' || hit.el.kind === 'video' || hit.el.kind === 'audio'
          ? tokens.join('、') || name
          : repeated
            ? bindingSuffix(family, name, tokens)
            : bindingText(family, name, tokens)
      text = text.slice(0, mention.start) + replacement + text.slice(mention.end)
    }
    source.write(text)
  }
}

/**
 * 连进卡片参考图端口的上游节点里，最近一次运行失败的（带名称，提示里能定位是哪张图）。
 * 同一个上游连多条线只记一次；没有任何上游失败时返回空。
 */
function failedReferenceSources(doc: PleinDoc, id: string): Array<{ id: string; name: string }> {
  const failed = new Map<string, string>()
  for (const e of doc.edges()) {
    if (e.to[0] !== id || e.to[1] !== 'references') continue
    const src = doc.get(e.from[0])
    if (src?.kind !== 'node' || src.run?.status !== 'failed') continue
    failed.set(src.id, src.name || src.nodeType || '上游节点')
  }
  return [...failed].map(([id, name]) => ({ id, name }))
}

/** 失败上游节点的名称列表：写进提示文案，用户能定位要重跑哪个节点 */
const sourceNames = (sources: Array<{ name: string }>) =>
  sources.map((s) => `「${s.name}」`).join('、')

/** 一组 @ 引用带来的参考图；priority 为必需参考的先后（-1 为可选） */
interface Group {
  rank: number
  priority: number
  images: PortValue[]
}

/** 当前仍存在的必需参考元素 id → 先后顺序；删除后的残留 id 不参与解析。 */
function requiredOrder(value: unknown, doc: PleinDoc) {
  const ids = Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string' && doc.has(v))
    : []
  return new Map(ids.map((id, i) => [id, i]))
}

const KINDS: Record<string, InputRefKind> = {
  'plein/character': 'character',
  'plein/scene': 'scene',
  'plein/prop': 'prop',
  'plein/style': 'style',
}

/** 引用命中的档案项 / 视角身份（不含显示名）；写在明细上，供预览把同卡不同档案项 / 视角逐条列入未送入 */
const hitIdentity = (h: Hit) =>
  [
    h.pick.period?.id,
    h.pick.outfit?.id,
    h.pick.expression?.id,
    h.pick.voiceState?.id,
    h.sceneView?.id,
  ]
    .map((value) => value ?? '')
    .join('/')

function detail(
  el: CanvasElement,
  name: string,
  priority: number,
  available: string[],
  pickIdentity = '',
): InputRef {
  const media =
    el.kind === 'video' || el.kind === 'audio'
      ? el.kind
      : el.nodeType === 'plein/effect'
        ? 'video'
        : undefined
  return {
    elementId: el.id,
    name,
    kind: el.kind === 'image' ? 'image' : (KINDS[el.nodeType ?? ''] ?? 'other'),
    ...(media ? { media } : {}),
    required: priority >= 0,
    available,
    sent: [],
    ...(pickIdentity ? { pickIdentity } : {}),
  }
}

/** 参考图放不下时的取舍顺序：角色最要紧（同一个人），其次场景、道具；直接 @ 的图片元素排最后 */
const RANK = ['plein/character', 'plein/scene', 'plein/prop', 'plein/style']

/**
 * 在参考图上限内挑出 @ 引用要送的图：必需参考按设定的先后先放，再按角色、场景、道具的顺序；
 * 每张卡先放第一张（主图），有余量再按顺序放其余的。
 * 必需参考的主图放不下时记为阻断；可选参考放不下的从 refList 里去掉对应的图，并提示用户
 */
function pickRefs(
  own: PortValue[],
  groups: Group[],
  refList: UsedRef[],
  /** 与 groups 同步下标（只含图片参考）：details 还含视频、音频与特效卡，按 details 下标取会错位 */
  imageDetails: InputRef[],
  max: number | undefined,
  notices: InputIssue[],
  blocked: InputIssue[],
): PortValue[] {
  const all = groups.flatMap((g) => g.images)
  if (max === undefined) return all
  const ownIds = imageIds(own)
  const seen = new Set(ownIds)
  const room = () => max - seen.size
  const first = (g: Group) => (g.priority >= 0 ? g.priority : Number.MAX_SAFE_INTEGER)
  const order = groups
    .map((g, i) => ({ ...g, i }))
    .sort((a, b) => first(a) - first(b) || a.rank - b.rank || a.i - b.i)
  const kept = new Set<string>()
  const take = (v: PortValue | undefined) => {
    const id = v && imageIds([v])[0]
    if (!id) return false
    if (seen.has(id)) return kept.has(id) || ownIds.includes(id)
    if (room() <= 0) return false
    seen.add(id)
    kept.add(id)
    return true
  }
  for (const g of order) {
    if (take(g.images[0]) || g.priority < 0 || !g.images.length) continue
    blocked.push({
      code: 'required_over_limit',
      elementId: imageDetails[g.i]!.elementId,
      message: `「${imageDetails[g.i]!.name}」是必需参考，但这个模型最多带 ${max} 张参考图，放不下了，请减少必需参考或换模型`,
    })
  }
  for (const g of order) for (const v of g.images.slice(1)) take(v)
  const dropped: UsedRef[] = []
  for (const r of refList) {
    const before = r.assetIds.length
    r.assetIds = r.assetIds.filter((id) => kept.has(id) || ownIds.includes(id))
    if (before > 0 && r.assetIds.length === 0) dropped.push(r)
  }
  // 同一次取舍只给一条汇总，避免每个被舍弃的引用重复同一段话。
  if (dropped.length) {
    const message = `这个模型最多带 ${max} 张参考图，${dropped.map((r) => r.name).join('、')} 的参考图没有送入，仅保留引用名称，不追加文字设定`
    notices.push({ code: 'optional_dropped', message })
  }
  return all.filter((v) => kept.has(imageIds([v])[0] ?? ''))
}

/**
 * 配音节点沿用角色卡的音色：只有同一家平台的音色 ID 才能直接用。
 * 换了平台就停下来报错，让用户自己挑——静默沿用等于把别的平台的音色 ID 塞给平台，
 * 出来的是不是这个人说不准；旧画布的裸字符串没有平台信息，只能沿用并说明无法校验。
 */
function applyVoice(
  params: Record<string, unknown>,
  voices: Array<{ name: string; voice: VoiceRef }>,
  notices: InputIssue[],
  providerTitle?: (provider: string) => string | undefined,
) {
  if (voices.length === 0) return
  if (voices.length > 1) {
    notices.push({
      code: 'voice_ambiguous',
      message: `引用了 ${voices.length} 个有音色的角色（${voices.map((v) => v.name).join('、')}），请在配音节点里手动选择音色`,
    })
    return
  }
  const { name, voice } = voices[0]!
  const provider = parseModelRef(String(params.model ?? ''))?.provider ?? ''
  params.voice = voice
  if (voiceFitsProvider(voice, provider)) return
  // 没选模型或音色没有平台信息：都算「无法校验」，照用但说清楚
  if (provider === '' || voice.provider === '') {
    notices.push({
      code: 'voice_unverified',
      message: `沿用了「${name}」的音色 ${voice.voiceId}，它没有记录属于哪个平台，无法校验是否适用于当前模型，请确认`,
    })
    return
  }
  throw new NodeRunError(
    'invalid_input',
    `「${name}」的音色属于 ${speechProviderTitle(voice.provider, providerTitle)}，当前配音模型是 ${speechProviderTitle(provider, providerTitle)}，音色不能跨平台使用，请重新选择音色`,
  )
}

function brokenNotice(name: string, candidates: string[]): InputIssue {
  return {
    code: 'mention_broken',
    message: `提示词里的 @${name} 找不到同名资产，可能已被改名为「${candidates.join('」「')}」，请改过来`,
  }
}

const imageIds = (values: PortValue[]) => mediaIds(values, 'image')

const mediaIds = (values: PortValue[], kind: ReferenceMediaKind) =>
  values.flatMap((v) => (v.type === kind && 'assetId' in v ? [v.assetId] : []))

/**
 * 视频 / 音频引用的取舍顺序：必需参考按 requiredRefs 里的先后在前，可选参考排最后（保持出现顺序）。
 * 与参考图的 RANK 不同，媒体没有「角色更重要」这一层，只看必需与否。
 */
const mediaPriority = (d: InputRef, required: Map<string, number>) => {
  const order = required.get(d.elementId)
  return order === undefined ? Number.MAX_SAFE_INTEGER : order
}

/** 参考图去重：同一张图经多个引用进来只送一次 */
function dedupe(values: PortValue[]): PortValue[] {
  const seen = new Set<string>()
  return values.filter((v) => {
    const id = 'assetId' in v ? v.assetId : ''
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}
