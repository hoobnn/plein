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
  pickNotes,
  type ProfilePick,
  pickVoice,
  profileOf,
  type VoiceRef,
  voiceFitsProvider,
  voiceOf,
} from '@plein/nodes'
import { type NodeDefinition, parseModelRef, type PortValue } from '@plein/plugin-sdk'
import type { InputIssue, InputRef, InputRefKind } from '@plein/protocol'
import { NodeRunError } from '../plugins/host'

type Inputs = Record<string, PortValue[]>

/** 会把被引用资产的设定附在提示词后面的能力；配音等不附（台词里不该混进设定） */
const DESCRIBE: ReadonlySet<string> = new Set(['text.chat', 'image.generate', 'video.generate'])

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
  /** 每个引用的实际用法：能提供哪些图、送了哪些、没送的原因、是否必需；供实际输入预览与执行记录 */
  details: InputRef[]
  /** 必需参考用不上（缺图、当前模式不收、放不下）：这个镜头不提交 */
  blocked: InputIssue[]
}

/** 画布上可被 @ 引用的东西：资产卡（角色、场景、道具、风格）和有名字的图片元素 */
export interface MentionElement {
  id: string
  name: string
  el: CanvasElement
  profile?: ReturnType<typeof profileOf>
}

/** 列出可被 @ 引用的元素；重名不合并，由 `#序号` 消歧（序号顺序见 sortMentionTargets） */
function mentionTargets(doc: PleinDoc): MentionElement[] {
  const out: MentionElement[] = []
  for (const el of doc.elements()) {
    const name = mentionName(el)
    if (!name) continue
    const profile = el.nodeType === 'plein/character' ? profileOf(el.params?.profile) : undefined
    out.push({ id: el.id, name, el, ...(profile ? { profile } : {}) })
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

/** 引用到的一个资产：写下来的名字与它在同名里的序号（重名时提示用） */
interface Hit {
  name: string
  /** 同名目标里的第几个（0 起）；只有重名时用得上 */
  index: number
  total: number
  el: CanvasElement
  /** `@林夏/少年/校服` 里写明的档案项 */
  pick: ProfilePick
}

const label = (h: Hit) => pickLabel(h.total > 1 ? `${h.name}#${h.index + 1}` : h.name, h.pick)

/** 同一个角色写了不同的档案项（`@林夏/童年` 和 `@林夏/青年`）算两处引用 */
const hitKey = (h: Hit) =>
  [
    h.el.id,
    h.pick.period?.id,
    h.pick.outfit?.id,
    h.pick.expression?.id,
    h.pick.voiceState?.id,
  ].join('/')

/** 提示词里 @ 的名字，对应到画布上的元素 */
function checkMention(m: Mention, byId: Map<string, CanvasElement>): Hit | undefined {
  // 重名没写序号、序号越界：不能猜，否则引用会悄悄串到另一个资产上
  const problem = mentionProblem(m)
  if (problem) throw new NodeRunError('invalid_input', problem)
  const el = m.id ? byId.get(m.id) : undefined
  if (!el) return undefined
  return { name: m.name, index: m.ids.indexOf(m.id!), total: m.total, el, pick: m.pick ?? {} }
}

/**
 * 运行前处理提示词里的 @ 引用：
 * - 文本里的 `@林夏` 换成 `林夏`；对话、图片、视频节点在主提示词后附上被引用者的设定；
 * - 被引用者的参考图并入节点的 `references` 输入（去重）；生成视频只在「图片参考」模式并入 `images`；
 * - 配音节点没选音色、且只引用了一个有音色的角色时用它的音色——但只有同一家平台才沿用，
 *   跨平台的音色 ID 送过去多半是乱读，宁可停下来让用户重选；
 * - 模型声明了参考图上限（maxRefs）时，节点自己连入的图先占位，再按角色、场景、道具的顺序
 *   每张卡先放一张，有余量再放其余的；放不下的卡只附文字设定，并提示用户；
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
): Promise<AppliedMentions> {
  const params = { ...el.params }
  const targets = mentionTargets(doc)
  const byId = new Map(targets.map((t) => [t.id, t.el]))
  const hit = new Map<string, Hit>()
  const notices: InputIssue[] = []
  for (const [key, value] of Object.entries(params)) {
    if (typeof value !== 'string' || !value.includes('@')) continue
    const found = findMentions(value, targets).filter((m) => m.id !== el.id)
    const broken = findBrokenMentions(value, targets)
    if (found.length === 0) {
      for (const b of broken) notices.push(brokenNotice(b.name, b.candidates))
      continue
    }
    let text = ''
    let last = 0
    for (const m of found) {
      const h = checkMention(m, byId)
      // 写了档案项的换成「林夏（少年·校服）」，同一段里出现两个时期也分得清
      text += `${value.slice(last, m.start)}${pickLabel(m.name, m.pick ?? {})}`
      last = m.end
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
          message: `@${m.name}：${m.profileConflict}，已忽略`,
          ...(m.id ? { elementId: m.id } : {}),
        })
    }
    params[key] = text + value.slice(last)
    for (const b of broken) notices.push(brokenNotice(b.name, b.candidates))
  }
  if (hit.size === 0) return { params, inputs, refs: [], notices, details: [], blocked: [] }

  const required = requiredOrder(params.requiredRefs)
  const groups: Group[] = []
  const refList: UsedRef[] = []
  const details: InputRef[] = []
  const blocked: InputIssue[] = []
  const notes: string[] = []
  const voices: Array<{ name: string; voice: VoiceRef }> = []
  /** 参考图来自生成失败的上游：和「还没生成或没连」分开提示 */
  const failedRefs = new Set<string>()
  for (const h of hit.values()) {
    const target = h.el
    const priority = required.get(target.id) ?? -1
    if (target.kind === 'image' && target.assetId) {
      groups.push({
        rank: RANK.length,
        priority,
        images: [{ type: 'image', assetId: target.assetId, kind: 'image', source: target.id }],
      })
      refList.push({ name: h.name, elementId: target.id, assetIds: [target.assetId] })
      details.push(detail(target, h.name, priority, [target.assetId]))
      continue
    }
    const description = pickNotes(String(target.params?.description ?? ''), h.pick)
    if (description) notes.push(`${label(h)}：${description}`)
    const v = pickVoice(h.pick, voiceOf(target.params))
    if (hasVoice(v)) voices.push({ name: pickLabel(h.name, h.pick), voice: v })
    const own = await collect(target.id)
    const base = (own.references ?? []).filter((v) => v.type === 'image')
    if (base.length === 0 && referenceFailed(doc, target.id)) failedRefs.add(target.id)
    // 写了档案项：命中项的图排前面，再补卡片的参考图，每个角色截到上限
    const images = pickEmpty(h.pick)
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
    const rank = RANK.indexOf(target.nodeType ?? '')
    groups.push({ rank: rank < 0 ? RANK.length : rank, priority, images })
    refList.push({
      name: pickLabel(h.name, h.pick),
      elementId: target.id,
      assetIds: imageIds(images),
    })
    details.push(detail(target, pickLabel(h.name, h.pick), priority, imageIds(images)))
  }

  const prompt = ['prompt', 'text'].find((k) => typeof params[k] === 'string')
  if (prompt && notes.length && def.capability && DESCRIBE.has(def.capability))
    params[prompt] = `${params[prompt]}\n\n设定：\n${notes.join('\n')}`

  if (def.capability === 'audio.speech' && !hasVoice(voiceOf(params)))
    applyVoice(params, voices, notices)

  // 参考图并到哪个输入：图片节点等是 references；生成视频只有「图片参考」模式才把图当参考主体
  const video = def.capability === 'video.generate'
  const port = video ? 'images' : 'references'
  const send =
    def.inputs.some((p) => p.id === port && p.type === 'image') &&
    (!video || params.mode === 'reference')
  if (video && !send && groups.some((g) => g.images.length)) {
    notices.push({
      code: 'unsupported_refs',
      message: '@ 引用的参考图只在「图片参考」模式下送入模型，当前模式只附文字设定',
    })
    for (const r of refList) r.assetIds = []
  }

  for (const d of details) {
    if (!d.required) continue
    if (!send)
      blocked.push({
        code: 'required_unsupported',
        elementId: d.elementId,
        message: video
          ? `「${d.name}」是必需参考，当前模式不送参考图，请切到「图片参考」或取消必需`
          : `「${d.name}」是必需参考，这个节点不收参考图`,
      })
    else if (d.available.length === 0)
      blocked.push(
        failedRefs.has(d.elementId)
          ? {
              code: 'required_failed',
              elementId: d.elementId,
              message: `「${d.name}」是必需参考，但它的参考图生成失败了，请重新生成或取消必需`,
            }
          : {
              code: 'required_no_image',
              elementId: d.elementId,
              message: `「${d.name}」是必需参考，但还没有可用的参考图（未生成或没连）`,
            },
      )
  }

  const own = send ? (inputs[port] ?? []) : []
  const refs = send ? pickRefs(own, groups, refList, details, maxRefs, notices, blocked) : []
  for (const [i, d] of details.entries()) {
    d.sent = send ? refList[i]!.assetIds : []
    if (d.available.length === 0) d.reason = failedRefs.has(d.elementId) ? 'failed' : 'no_image'
    else if (!send) d.reason = 'unsupported'
    else if (d.sent.length < d.available.length) d.reason = 'over_limit'
  }

  // 本次真正送进去的东西带到执行器（宿主不把运行摘要传下去，见 node 定义的 usedRefs 注释）
  params.usedRefs = refList

  const merged =
    send && refs.length
      ? {
          ...inputs,
          [port]: dedupe([...own, ...refs]),
        }
      : inputs
  return { params, inputs: merged, refs: refList, notices, details, blocked }
}

/** 连进卡片参考图端口的上游节点里，有最近一次运行失败的 */
function referenceFailed(doc: PleinDoc, id: string) {
  for (const e of doc.edges()) {
    if (e.to[0] !== id || e.to[1] !== 'references') continue
    const src = doc.get(e.from[0])
    if (src?.kind === 'node' && src.run?.status === 'failed') return true
  }
  return false
}

/** 一组 @ 引用带来的参考图；priority 为必需参考的先后（-1 为可选） */
interface Group {
  rank: number
  priority: number
  images: PortValue[]
}

/** 必需参考的元素 id → 先后顺序 */
function requiredOrder(value: unknown) {
  const ids = Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
  return new Map(ids.map((id, i) => [id, i]))
}

const KINDS: Record<string, InputRefKind> = {
  'plein/character': 'character',
  'plein/scene': 'scene',
  'plein/prop': 'prop',
  'plein/style': 'style',
}

function detail(el: CanvasElement, name: string, priority: number, available: string[]): InputRef {
  return {
    elementId: el.id,
    name,
    kind: el.kind === 'image' ? 'image' : (KINDS[el.nodeType ?? ''] ?? 'other'),
    required: priority >= 0,
    available,
    sent: [],
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
  details: InputRef[],
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
      elementId: details[g.i]!.elementId,
      message: `「${details[g.i]!.name}」是必需参考，但这个模型最多带 ${max} 张参考图，放不下了，请减少必需参考或换模型`,
    })
  }
  for (const g of order) for (const v of g.images.slice(1)) take(v)
  const dropped: UsedRef[] = []
  for (const r of refList) {
    const before = r.assetIds.length
    r.assetIds = r.assetIds.filter((id) => kept.has(id) || ownIds.includes(id))
    if (before > 0 && r.assetIds.length === 0) dropped.push(r)
  }
  // 一条给人看的汇总，按引用各记一条供程序判断时 message 相同
  const message = `这个模型最多带 ${max} 张参考图，${dropped.map((r) => r.name).join('、')} 的参考图没有送入，只附了文字设定`
  for (const r of dropped)
    notices.push({ code: 'optional_dropped', elementId: r.elementId, message })
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
    `「${name}」的音色属于 ${voice.provider}，当前配音模型是 ${provider}，音色不能跨平台使用，请重新选择音色`,
  )
}

function brokenNotice(name: string, candidates: string[]): InputIssue {
  return {
    code: 'mention_broken',
    message: `提示词里的 @${name} 找不到同名资产，可能已被改名为「${candidates.join('」「')}」，请改过来`,
  }
}

const imageIds = (values: PortValue[]) =>
  values.flatMap((v) => (v.type === 'image' && 'assetId' in v ? [v.assetId] : []))

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
