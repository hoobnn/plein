import type { CanvasElement, PleinDoc } from '@plein/doc'
import {
  ASSET_NODE_TYPES,
  findBrokenMentions,
  findMentions,
  hasVoice,
  type Mention,
  mentionProblem,
  type VoiceRef,
  voiceFitsProvider,
  voiceOf,
} from '@plein/nodes'
import { type NodeDefinition, parseModelRef, type PortValue } from '@plein/plugin-sdk'
import { NodeRunError } from '../plugins/host'

type Inputs = Record<string, PortValue[]>

/** 会把被引用资产的设定附在提示词后面的能力；配音等不附（台词里不该混进设定） */
const DESCRIBE: ReadonlySet<string> = new Set(['text.chat', 'image.generate', 'video.generate'])

/** 本次运行真正送进模型的资产引用，用于「执行前展示实际引用映射」 */
export interface UsedRef {
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
  /** 不阻断运行、但用户该知道的提示（音色无法校验、@ 名字可能已改名） */
  notices: string[]
}

/** 画布上可被 @ 引用的东西：资产卡（角色、场景、道具、风格）和有名字的图片元素 */
export interface MentionElement {
  id: string
  name: string
  el: CanvasElement
}

/** 列出可被 @ 引用的元素；重名不合并，由 `#序号` 消歧（序号顺序见 sortMentionTargets） */
export function mentionTargets(doc: PleinDoc): MentionElement[] {
  const out: MentionElement[] = []
  for (const el of doc.elements()) {
    const name = el.name?.trim()
    if (!name) continue
    const asset = el.kind === 'node' && el.nodeType && ASSET_NODE_TYPES.has(el.nodeType)
    if (asset || (el.kind === 'image' && el.assetId)) out.push({ id: el.id, name, el })
  }
  return out
}

/** 引用到的一个资产：写下来的名字与它在同名里的序号（重名时提示用） */
interface Hit {
  name: string
  /** 同名目标里的第几个（0 起）；只有重名时用得上 */
  index: number
  total: number
  el: CanvasElement
}

const label = (h: Hit) => (h.total > 1 ? `${h.name}#${h.index + 1}` : h.name)

/** 提示词里 @ 的名字，对应到画布上的元素 */
function checkMention(m: Mention, byId: Map<string, CanvasElement>): Hit | undefined {
  // 重名没写序号、序号越界：不能猜，否则引用会悄悄串到另一个资产上
  const problem = mentionProblem(m)
  if (problem) throw new NodeRunError('invalid_input', problem)
  const el = m.id ? byId.get(m.id) : undefined
  if (!el) return undefined
  return { name: m.name, index: m.ids.indexOf(m.id!), total: m.total, el }
}

/**
 * 运行前处理提示词里的 @ 引用：
 * - 文本里的 `@林夏` 换成 `林夏`；对话、图片、视频节点在主提示词后附上被引用者的设定；
 * - 被引用者的参考图并入节点的 `references` 输入（去重）；生成视频只在「图片参考」模式并入 `images`；
 * - 配音节点没选音色、且只引用了一个有音色的角色时用它的音色——但只有同一家平台才沿用，
 *   跨平台的音色 ID 送过去多半是乱读，宁可停下来让用户重选；
 * - 汇总本次真正送进模型的引用（refs）和需要用户知道的提示（notices）。
 * 返回新的参数与输入，不改文档。
 */
export async function applyMentions(
  doc: PleinDoc,
  el: CanvasElement,
  def: NodeDefinition,
  inputs: Inputs,
  collect: (id: string) => Promise<Inputs>,
): Promise<AppliedMentions> {
  const params = { ...el.params }
  const targets = mentionTargets(doc)
  const byId = new Map(targets.map((t) => [t.id, t.el]))
  const hit = new Map<string, Hit>()
  const notices: string[] = []
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
      text += `${value.slice(last, m.start)}${m.name}`
      last = m.end
      if (h) hit.set(h.el.id, h)
    }
    params[key] = text + value.slice(last)
    for (const b of broken) notices.push(brokenNotice(b.name, b.candidates))
  }
  if (hit.size === 0) return { params, inputs, refs: [], notices }

  const refs: PortValue[] = []
  const refList: UsedRef[] = []
  const notes: string[] = []
  const voices: Array<{ name: string; voice: VoiceRef }> = []
  for (const h of hit.values()) {
    const target = h.el
    if (target.kind === 'image' && target.assetId) {
      refs.push({ type: 'image', assetId: target.assetId, kind: 'image', source: target.id })
      refList.push({ name: h.name, elementId: target.id, assetIds: [target.assetId] })
      continue
    }
    const description = String(target.params?.description ?? '').trim()
    if (description) notes.push(`${label(h)}：${description}`)
    const v = voiceOf(target.params)
    if (hasVoice(v)) voices.push({ name: h.name, voice: v })
    const own = await collect(target.id)
    const images = (own.references ?? []).filter((v) => v.type === 'image')
    refs.push(...images)
    refList.push({ name: h.name, elementId: target.id, assetIds: imageIds(images) })
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
  if (video && !send && refs.length) {
    notices.push('@ 引用的参考图只在「图片参考」模式下送入模型，当前模式只附文字设定')
    for (const r of refList) r.assetIds = []
  }

  // 本次真正送进去的东西带到执行器（宿主不把运行摘要传下去，见 node 定义的 usedRefs 注释）
  params.usedRefs = refList

  const merged =
    send && refs.length
      ? {
          ...inputs,
          [port]: dedupe([...(inputs[port] ?? []), ...refs]),
        }
      : inputs
  return { params, inputs: merged, refs: refList, notices }
}

/**
 * 配音节点沿用角色卡的音色：只有同一家平台的音色 ID 才能直接用。
 * 换了平台就停下来报错，让用户自己挑——静默沿用等于把别的平台的音色 ID 塞给平台，
 * 出来的是不是这个人说不准；旧画布的裸字符串没有平台信息，只能沿用并说明无法校验。
 */
function applyVoice(
  params: Record<string, unknown>,
  voices: Array<{ name: string; voice: VoiceRef }>,
  notices: string[],
) {
  if (voices.length === 0) return
  if (voices.length > 1) {
    notices.push(
      `引用了 ${voices.length} 个有音色的角色（${voices.map((v) => v.name).join('、')}），请在配音节点里手动选择音色`,
    )
    return
  }
  const { name, voice } = voices[0]!
  const provider = parseModelRef(String(params.model ?? ''))?.provider ?? ''
  params.voice = voice
  if (voiceFitsProvider(voice, provider)) return
  // 没选模型或音色没有平台信息：都算「无法校验」，照用但说清楚
  if (provider === '' || voice.provider === '') {
    notices.push(
      `沿用了「${name}」的音色 ${voice.voiceId}，它没有记录属于哪个平台，无法校验是否适用于当前模型，请确认`,
    )
    return
  }
  throw new NodeRunError(
    'invalid_input',
    `「${name}」的音色属于 ${voice.provider}，当前配音模型是 ${provider}，音色不能跨平台使用，请重新选择音色`,
  )
}

function brokenNotice(name: string, candidates: string[]) {
  return `提示词里的 @${name} 找不到同名资产，可能已被改名为「${candidates.join('」「')}」，请改过来`
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
