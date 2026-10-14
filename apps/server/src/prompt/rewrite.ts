import type { RewritePrompt, RewritePromptResult } from '@plein/protocol'
import { ProviderError } from '@plein/plugin-sdk'
import type { PluginHost } from '../plugins/host'

/** 没列出名字时 @ 引用的边界，与前端 @ 候选的停止字符一致 */
const LOOSE_MENTION = /@[^\s@，。,.!！?？:：;；、（）()【】[\]「」"'“”]+/g
const PLACEHOLDER = /【[^【】\n]*】/g
const TOKEN = /⟦(\d+)⟧/g

const KEEP =
  '形如 ⟦1⟧ 的标记代表引用或占位，必须原样保留并放在语义对应的位置，不要翻译、改写、合并或删除。'
const ONLY = '只输出结果本身，不加解释、标题、引号或代码块。'

const SYSTEM = {
  image: `你是文生图提示词优化助手。把用户的提示词改写成一段可直接用于图片生成的提示词：保留原意和已有细节，补全主体（外观、服装、动作、表情）、场景环境、景别与构图、光线、色调、画面风格与质感。语言与原文一致，写成一段连贯的描述，不超过 200 字。${KEEP}${ONLY}`,
  video: `你是图生视频 / 文生视频提示词优化助手。把用户的提示词改写成一段可直接用于视频生成的提示词：保留原意和已有细节，补全主体与动作过程、场景环境、景别、镜头运动（推、拉、摇、移、跟、环绕、固定等）与节奏、光线与氛围，动作要在几秒内可完成。语言与原文一致，写成一段连贯的描述，不超过 200 字。${KEEP}${ONLY}`,
}

const translateSystem = (to: string) =>
  `你是提示词翻译助手。把用户的 AI 生成提示词翻译成${to}，准确保留画面、镜头和风格术语，不增删内容。${KEEP}${ONLY}`

/** 把 @ 引用和【占位】按出现顺序换成 ⟦n⟧，模型改写后再换回来 */
export function maskPrompt(text: string, mentions: string[] = []) {
  const names = [...new Set(mentions)].sort((a, b) => b.length - a.length)
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  // 已知名字优先，避免宽松规则把名字后面紧跟的字也吞进去
  const rules = [
    PLACEHOLDER,
    ...(names.length ? [new RegExp(`@(?:${escaped.join('|')})`, 'g')] : []),
    LOOSE_MENTION,
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

/** 提示词改写：优化 / 中英互译，用已启用的对话模型。@ 引用和【占位】原样保留 */
export async function rewritePrompt(
  host: PluginHost,
  input: RewritePrompt,
  opts: { ownerId: string; signal: AbortSignal },
): Promise<RewritePromptResult> {
  const { text, mode, mentions } = input
  const target = input.target ?? 'image'
  const models = host.models('text.chat')
  const model = input.model ?? models[0]?.ref
  if (!model)
    throw new PromptError('no_model', '没有可用的对话模型，请先在设置里启用支持对话的平台', 409)
  if (!models.some((m) => m.ref === model))
    throw new PromptError('invalid', `模型 ${model} 不可用或不支持对话`, 400)

  const { masked, kept } = maskPrompt(text, mentions)
  const system =
    mode === 'optimize'
      ? SYSTEM[target]
      : translateSystem(CJK.test(masked.replace(TOKEN, '')) ? '英文' : '简体中文')
  let raw: string
  try {
    const res = await host.call(
      'text.chat',
      model,
      {
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: masked },
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
