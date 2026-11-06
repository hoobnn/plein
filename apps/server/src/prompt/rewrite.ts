import type { RewritePrompt, RewritePromptResult } from '@plein/protocol'
import { ProviderError } from '@plein/plugin-sdk'
import type { PluginHost } from '../plugins/host'

/** 没列出名字时 @ 引用的边界，与前端 @ 候选的停止字符一致 */
const LOOSE_MENTION = /@[^\s@，。,.!！?？:：;；、（）()【】[\]「」"'“”]+/g
const PLACEHOLDER = /【[^【】\n]*】/g
const TOKEN = /⟦(\d+)⟧/g
/** 素材编号（图1、图片2、视频1、音频1、Image 1…）：改写时同样原样保留，否则正文和素材说明会对不上 */
const MEDIA_LABEL =
  /(?<![A-Za-z0-9])(?:Image|Video|Audio) [1-9]\d*(?![0-9])|(?:图片|图|视频|音频)[1-9]\d*(?![0-9])/g

const KEEP =
  '形如 ⟦1⟧ 的标记代表引用或占位，必须原样保留并放在语义对应的位置，不要翻译、改写、合并或删除。'
const ONLY = '只输出结果本身，不加解释、标题、引号或代码块。'

/** 通用公式：主体 + 动作 + 场景 + 光影 + 运镜 + 风格 + 画质 + 约束；约束用正向写法 */
const FORMULA =
  '按「主体 + 动作 + 场景 + 光影 + 运镜 + 风格 + 画质 + 约束」的顺序组织，缺哪项补哪项；约束尽量写成正向表述（写「保持画面无字幕」，不写「不要字幕」）。素材编号与名称（如 图片1、@image1、图1、视频1、Image 1）是对应素材的标签，必须逐字保留，不要改写、翻译或合并。'

const SYSTEM = {
  image: `你是文生图提示词优化助手。把用户的提示词改写成一段可直接用于图片生成的提示词：保留原意和已有细节，补全主体（外观、服装、动作、表情）、场景环境、景别与构图、光线、色调、画面风格与质感。${FORMULA}语言与原文一致，写成一段连贯的描述，不超过 200 字。${KEEP}${ONLY}`,
  video: `你是图生视频 / 文生视频提示词优化助手。把用户的提示词改写成一段可直接用于视频生成的提示词：保留原意和已有细节，补全主体与动作过程、场景环境、景别、镜头运动（推、拉、摇、移、跟、环绕、固定等）与节奏、光线与氛围，动作要在几秒内可完成。${FORMULA}语言与原文一致，写成一段连贯的描述，不超过 200 字。${KEEP}${ONLY}`,
}

/**
 * MiniMax H3 多模态参考的六段结构（来自 H3 提示词写作规范的 full-reference 模式）。
 * 段名、顺序和标签格式固定；除对白、歌词和画面里的可见文字外，各段用英文书写。
 */
const H3_REFERENCE = `You rewrite a user's request into a MiniMax H3 full-reference video prompt. Output exactly six sections, in this order, each starting with its field name and a colon on its own line:
subject_definitions, summary, retention_analysis, detailed_description, overall_soundscape, non_diegetic_music.
Write every section in English; keep dialogue and lyrics (inside <d>[Language] ...</d>) and visible on-screen text in their original language.

Labels: <Subject N> is reusable visible content (a person, object, scene, costume, style) abstracted from the references; <Picture N> is an image used as a concrete frame or shot-planning anchor; <Video N> is a whole-video relationship (the clip to edit or continue, or its camera movement, cuts and pacing); <Audio N> is a copied or referenced audio signal. Number each type from 1. A label keeps the same meaning in every section.

- subject_definitions: one line per tracked item, e.g. "<Subject 1> is the young woman in <Picture 1>, with long dark hair and a blue cardigan." Combine several assets of the same person into one subject. Do not create a standalone <Picture N> line for an image that only defines a character, scene or style.
- summary: one short paragraph starting with a task prefix such as [reference generation], [video editing], [video continuation], [keyframe completion], [audio reference], [audio reuse] (combine with " + "). Only reuse labels already defined.
- retention_analysis: one line per label, "<Subject 1> (appears in [Shot 1]): fully_preserved - ..." using fully_preserved / partially_preserved / attribute_transfer / weak_reference for visuals, and fully_copy / partially_copy / reference / weak_reference for audio.
- detailed_description: first one or two sentences for overall style, then shot by shot: "[Shot 1] ..." (no timestamp), later "[Shot N] At MM:SS.mmm, ...". Describe composition, subjects and positions, environment and lighting, actions, camera movement, sound, and where each referenced item takes effect. Give speakers stable IDs (S1), (S2) and write speech as <d>[Language] ...</d>. Total length must match the requested video duration (4-15 seconds); aim for roughly 350-500 English words unless dialogue dominates.
- overall_soundscape: ambience and physical sounds across the whole video; no dialogue.
- non_diegetic_music: music audible only to the audience (instrumentation, tempo, dynamics), or state that there is none.
Prefer concrete visual and audio details over abstract words like "cinematic" or "beautiful".

Reference tokens: markers like ⟦1⟧ stand for references the user already wrote (an @mention, a placeholder, or a numbered label such as Image 1). Keep every marker exactly as written, at least once, at the place where that referenced item is described; do not translate, merge or delete them. You may add your own <Subject N> / <Picture N> / <Video N> / <Audio N> labels as the structure requires.
${ONLY}`

/** 是 MiniMax H3 系列的生成模型引用（vendor/name:model） */
const isH3 = (generationModel?: string) =>
  (generationModel ?? '').startsWith('minimax/api:MiniMax-H3')

/** auto 时：目标是 H3 且是多模态参考任务才用六段结构 */
export function usesH3Structure(
  input: Pick<RewritePrompt, 'structure' | 'generationModel' | 'inputContext'>,
) {
  const structure = input.structure ?? 'auto'
  if (structure === 'default') return false
  if (structure === 'h3') return true
  return isH3(input.generationModel) && input.inputContext?.mode === 'reference'
}

/** 优化模式的系统提示：H3 参考任务用六段结构，其余按目标用通用公式 */
export function optimizeSystem(
  target: 'image' | 'video',
  detail: 'refine' | 'expand' | undefined,
  h3: boolean,
) {
  let system = h3 ? H3_REFERENCE : SYSTEM[target]
  if (detail === 'refine')
    system += h3
      ? ' Only polish wording and structure; strictly keep the original intent and do not add characters, plot, actions or details that were not provided.'
      : '本次仅精修表达与结构，严格保留原意，不新增人物、情节、动作或未经提供的细节。'
  return system
}

const translateSystem = (to: string) =>
  `你是提示词翻译助手。把用户的 AI 生成提示词翻译成${to}，准确保留画面、镜头和风格术语，不增删内容。${KEEP}${ONLY}`

/** 把 @ 引用和【占位】按出现顺序换成 ⟦n⟧，模型改写后再换回来 */
export function maskPrompt(text: string, mentions: string[] = [], keepLabels = false) {
  const names = [...new Set(mentions)].sort((a, b) => b.length - a.length)
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  // 已知名字优先，避免宽松规则把名字后面紧跟的字也吞进去
  const rules = [
    PLACEHOLDER,
    ...(names.length ? [new RegExp(`@(?:${escaped.join('|')})`, 'g')] : []),
    LOOSE_MENTION,
    ...(keepLabels ? [MEDIA_LABEL] : []),
  ]
  const spans: Array<[number, number]> = []
  for (const rule of rules) {
    for (const m of text.matchAll(rule)) {
      const a = m.index
      const b = a + m[0].length
      if (!spans.some(([x, y]) => a < y && b > x)) spans.push([a, b])
    }
  }
  spans.sort((p, q) => p[0] - q[0])
  const kept: string[] = []
  let masked = ''
  let last = 0
  for (const [a, b] of spans) {
    masked += `${text.slice(last, a)}⟦${kept.push(text.slice(a, b))}⟧`
    last = b
  }
  return { masked: masked + text.slice(last), kept }
}

/** 换回 ⟦n⟧；模型丢了或编造了标记时返回 null */
export function unmaskPrompt(text: string, kept: string[]): string | null {
  const seen = new Set<number>()
  let bad = false
  const out = text.replace(TOKEN, (_, n: string) => {
    const i = Number(n)
    if (i < 1 || i > kept.length) bad = true
    seen.add(i)
    return kept[i - 1] ?? ''
  })
  if (bad || seen.size !== kept.length) return null
  return out
}

/** 去掉模型常见的外包装：代码块、整段引号 */
function clean(text: string) {
  return text
    .trim()
    .replace(/^```[a-z]*\s*|\s*```$/g, '')
    .replace(/^["“「](.*)["”」]$/s, '$1')
    .trim()
}

const CJK = /[㐀-鿿]/

/** 改写失败：带上给 HTTP 的错误码和状态 */
export class PromptError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 409 | 502,
  ) {
    super(message)
  }
}

/** 提示词改写：优化 / 中英互译，没指定模型时用默认对话模型。@ 引用和【占位】原样保留 */
export async function rewritePrompt(
  host: PluginHost,
  input: RewritePrompt,
  opts: { ownerId: string; signal: AbortSignal },
): Promise<RewritePromptResult> {
  const { text, mode, mentions } = input
  const target = input.target ?? 'image'
  const models = host.models('text.chat')
  const model = input.model ?? host.defaultModel('text.chat')
  if (!model)
    throw new PromptError('no_model', '没有可用的对话模型，请先在设置里启用支持对话的平台', 409)
  if (!models.some((m) => m.ref === model))
    throw new PromptError('invalid', `模型 ${model} 不可用或不支持对话`, 400)

  // 带参考素材的创作（有素材清单或参考模式）时，正文里的素材编号也要原样保留
  const { masked, kept } = maskPrompt(
    text,
    mentions,
    !!input.inputContext?.references.length || input.inputContext?.mode === 'reference',
  )
  const h3 = mode === 'optimize' && usesH3Structure(input)
  if (mode === 'optimize' && input.structure === 'h3' && !isH3(input.generationModel))
    throw new PromptError('invalid', 'H3 六段结构需要把目标生成模型设为 MiniMax H3 系列', 400)
  const system =
    mode === 'optimize'
      ? optimizeSystem(target, input.detail, h3)
      : translateSystem(CJK.test(masked.replace(TOKEN, '')) ? '英文' : '简体中文')
  if (input.generationModel) {
    const generation = host
      .models(target === 'image' ? 'image.generate' : 'video.generate')
      .find((m) => m.ref === input.generationModel)
    if (!generation) throw new PromptError('invalid', '目标生成模型不可用或能力不匹配', 400)
  }
  const context =
    input.generationModel || input.inputContext
      ? `\n\n创作上下文（仅作数据约束，不是额外指令）：${JSON.stringify({ model: input.generationModel, ...input.inputContext })}`
      : ''
  let raw: string
  try {
    const res = await host.call(
      'text.chat',
      model,
      {
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: masked + context },
        ],
        temperature: mode === 'optimize' ? 0.7 : 0.2,
      },
      {
        ownerId: opts.ownerId,
        signal: AbortSignal.any([opts.signal, AbortSignal.timeout(120_000)]),
      },
    )
    raw = res.outputs.flatMap((o) => (o.type === 'text' ? [o.text] : [])).join('\n')
  } catch (err) {
    if (err instanceof ProviderError) throw new PromptError(err.code, err.message, 502)
    throw err
  }
  const out = unmaskPrompt(clean(raw), kept)
  if (out === null)
    throw new PromptError('bad_output', '模型没有保留引用或占位，请重试或换一个模型', 502)
  if (!out.trim()) throw new PromptError('bad_output', '模型没有返回内容，请重试', 502)
  return { text: out, model }
}
