import type { PleinDoc } from '@plein/doc'
import { mentionName } from '@plein/nodes'
import {
  type PortValue,
  type ReferenceLabelStyle,
  referenceMediaNumbering,
} from '@plein/plugin-sdk'
import type { InputRef } from '@plein/protocol'

type ReferenceMediaKind = 'image' | 'video' | 'audio'

/**
 * 参考素材的「素材说明段」与资产卡绑定写法。
 *
 * 各平台官方的参考模式写法不同：方舟先定义每份素材的作用（重要素材靠前），
 * MiniMax 在提示词开头分行写「Image N: 职责」，万相只用「图N / 视频N」称呼素材，
 * 图片多参考则在开头写「图1是人物，图2是服装」。措辞集中在这里，
 * 编号字符串一律由调用方传入（来自 modelbay 的标签函数），这里不自己拼平台编号。
 */

/** 措辞模板的平台族；与 modelbay 的编号风格无关，按厂商和节点能力区分 */
export type BriefFamily = 'ark' | 'minimax' | 'wan' | 'image'

/** 编辑 / 延长任务：说明段与自动文本里不出现「参考」 */
export type BriefTask = 'edit' | 'extend'

export function briefFamily(
  capability: string | undefined,
  provider: string | undefined,
): BriefFamily | undefined {
  if (capability === 'image.generate') return 'image'
  if (capability !== 'video.generate') return undefined
  if (provider === 'minimax/api') return 'minimax'
  if (provider === 'aliyun/bailian') return 'wan'
  if (provider === 'volc/ark' || provider === 'volc/ark-plan') return 'ark'
  return undefined
}

/** 编辑 / 延长任务取自模型选项里的 omni_reference_task_type */
export function briefTask(params: Record<string, unknown>): BriefTask | undefined {
  const options = params.options as Record<string, Record<string, unknown>> | undefined
  const task = options?.[String(params.model ?? '')]?.omni_reference_task_type
  return task === 'edit' || task === 'extend' ? task : undefined
}

export type BriefRoleType =
  | 'character'
  | 'scene'
  | 'prop'
  | 'style'
  | 'effect'
  | 'speech'
  | 'music'
  | 'generic'

export interface BriefRole {
  type: BriefRoleType
  /** 资产卡 / 素材的名字（不含档案项后缀） */
  name?: string
  /** 同一张卡的多张图合并成一行 */
  elementId?: string
}

export interface BriefMaterial {
  kind: ReferenceMediaKind
  /** 同类素材里的第几份，从 1 开始 */
  index: number
  /** 提示词正文里这份素材的编号写法（modelbay 标签函数给出） */
  label: string
  role: BriefRole
}

interface Line {
  kind: ReferenceMediaKind
  materials: BriefMaterial[]
  role: BriefRole
}

const MERGEABLE = new Set<BriefRoleType>(['character', 'scene', 'prop', 'style'])

/** 同一张卡（或同名同类）的多张图合并为一行；其余素材各占一行；按素材顺序输出 */
function lines(materials: BriefMaterial[]): Line[] {
  const out: Line[] = []
  for (const kind of ['image', 'video', 'audio'] as const) {
    const group = materials.filter((m) => m.kind === kind).sort((a, b) => a.index - b.index)
    for (const m of group) {
      const key = (r: BriefRole) => r.elementId ?? r.name
      const same = MERGEABLE.has(m.role.type)
        ? out.find(
            (l) =>
              l.kind === kind &&
              l.role.type === m.role.type &&
              key(l.role) !== undefined &&
              key(l.role) === key(m.role),
          )
        : undefined
      if (same) same.materials.push(m)
      else out.push({ kind, materials: [m], role: m.role })
    }
  }
  return out
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * 用户正文里已经显式交代了这份素材作用的编号：编号后紧跟「是 / 为 / 作为 / 定义为 / 冒号」，
 * 或紧跟「中的」这类定义写法（「图片1中的人物定义为主体1」）。命中就不再重复生成。
 */
export function explainedLabels(userText: string, labels: string[]): Set<string> {
  const done = new Set<string>()
  for (const label of labels) {
    const cue = new RegExp(
      `${escape(label)}\\s*(?:是|为|作为|定义为|用作|当作|中的|[:：]|\\bis\\b)`,
    )
    if (cue.test(userText)) done.add(label)
  }
  return done
}

const joinLabels = (labels: string[]) => labels.join('、')

// ── 方舟（中文） ─────────────────────────────────────────

/** 编辑 / 延长任务里不写「参考」，改称「素材」 */
function arkLine(line: Line, task: BriefTask | undefined, firstVideo: boolean): string {
  const ref = task ? '素材' : '参考'
  const labels = joinLabels(line.materials.map((m) => m.label))
  const many = line.materials.length > 1
  const name = line.role.name ? `「${line.role.name}」` : ''
  switch (line.role.type) {
    case 'character':
      return many
        ? `${labels}：同一角色${name}的多张外貌${ref}，合并为一个主体，保持面部、发型、服装一致`
        : `${labels}：角色${name}的外貌${ref}，保持面部、发型、服装一致`
    case 'scene':
      return many
        ? `${labels}：同一场景${name}的多个视角${ref}，保持空间布局与光线氛围`
        : `${labels}：场景${name}的环境${ref}，保持空间布局与光线氛围`
    case 'prop':
      return `${labels}：道具${name}的外观${ref}，保持形状、材质、颜色一致`
    case 'style':
      return `${labels}：画面风格${ref}${name}，沿用其色调、光影与质感`
    case 'effect':
      return `${labels}：运镜与动作${ref}视频${name}，沿用其镜头运动与节奏`
    case 'speech':
      return `${labels}：配音音色${ref}，沿用其音色与语气`
    case 'music':
      return `${labels}：背景音乐${ref}，沿用其节奏与情绪`
    default:
      if (line.kind === 'video') {
        if (task === 'edit' && firstVideo)
          return `${labels}：待编辑的视频，保留其主体内容，仅按要求修改`
        if (task === 'extend' && firstVideo) return `${labels}：待延长的视频，从其结尾自然接续`
        return `${labels}：${ref}视频，沿用其动作与镜头语言`
      }
      if (line.kind === 'audio') return `${labels}：${ref}音频，沿用其声音特征`
      return `${labels}：${ref}图`
  }
}

// ── 万相（中文，每份素材只含单个角色） ──────────────────────

function wanLine(line: Line): string {
  const labels = joinLabels(line.materials.map((m) => m.label))
  const name = line.role.name ? `「${line.role.name}」` : ''
  switch (line.role.type) {
    case 'character':
      return `${labels}：角色${name}的形象，保持面部与服装一致`
    case 'scene':
      return `${labels}：场景${name}，保持空间布局与光线氛围`
    case 'prop':
      return `${labels}：道具${name}，保持形状、材质、颜色一致`
    case 'style':
      return `${labels}：画面风格参考${name}`
    case 'effect':
      return `${labels}：运镜参考视频${name}，沿用其镜头运动`
    case 'speech':
      return `${labels}：配音音色参考`
    case 'music':
      return `${labels}：背景音乐参考`
    default:
      return line.kind === 'video'
        ? `${labels}：参考视频，沿用其动作`
        : line.kind === 'audio'
          ? `${labels}：参考音频`
          : `${labels}：参考图`
  }
}

// ── MiniMax（英文职责行） ─────────────────────────────────

const ENGLISH = { image: 'Image', video: 'Video', audio: 'Audio' } as const

function minimaxLine(line: Line): string {
  const labels = line.materials
    .map((m) => {
      const english = `${ENGLISH[m.kind]} ${m.index}`
      return m.label === english ? english : `${english} (${m.label})`
    })
    .join(', ')
  const many = line.materials.length > 1
  const name = line.role.name ? ` "${line.role.name}"` : ''
  switch (line.role.type) {
    case 'character':
      return many
        ? `${labels}: multiple views of the same character${name}. Keep face, hairstyle and outfit consistent.`
        : `${labels}: character reference for${name}. Keep face, hairstyle and outfit consistent.`
    case 'scene':
      return `${labels}: scene reference${name}. Keep the layout, lighting and atmosphere.`
    case 'prop':
      return `${labels}: prop reference${name}. Keep shape, material and color consistent.`
    case 'style':
      return `${labels}: style reference${name}. Follow its palette, lighting and texture.`
    case 'effect':
      return `${labels}: camera-movement reference video${name}. Follow its camera motion and pacing.`
    case 'speech':
      return `${labels}: voice reference. Follow its timbre and delivery.`
    case 'music':
      return `${labels}: background music reference. Follow its rhythm and mood.`
    default:
      return line.kind === 'video'
        ? `${labels}: reference video. Follow its action and camera language.`
        : line.kind === 'audio'
          ? `${labels}: reference audio.`
          : `${labels}: reference image.`
  }
}

// ── 图片多参考：开头一句话交代每张图的对象 ──────────────────

function imageClause(line: Line): string {
  const labels = joinLabels(line.materials.map((m) => m.label))
  const name = line.role.name ? `「${line.role.name}」` : ''
  switch (line.role.type) {
    case 'character':
      return `${labels}是${line.materials.length > 1 ? '同一人物' : '人物'}${name}`
    case 'scene':
      return `${labels}是场景${name}`
    case 'prop':
      return `${labels}是道具${name}`
    case 'style':
      return `${labels}是风格参考${name}`
    default:
      return `${labels}是参考图`
  }
}

/**
 * 素材说明段：逐条写「标签：作用」。用户正文已显式交代作用的标签不重复；
 * 一行里部分标签已交代时，只保留未交代的那些。没有素材返回空串。
 */
export function buildReferenceBrief({
  family,
  materials,
  userText = '',
  task,
}: {
  family: BriefFamily
  materials: BriefMaterial[]
  userText?: string
  task?: BriefTask
}): string {
  const explained = explainedLabels(
    userText,
    materials.map((m) => m.label),
  )
  // 没有语义的普通素材，说明行只能写「参考图 / 参考视频」，不增加信息，也不替用户猜用法：不生成。
  // 例外：编辑 / 延长任务里的第一段视频一定是待处理的源视频。
  const source = task
    ? materials.find((m) => m.kind === 'video' && m.role.type === 'generic')
    : undefined
  const pending = materials.filter(
    (m) => !explained.has(m.label) && (m.role.type !== 'generic' || m === source),
  )
  const rows = lines(pending)
  if (rows.length === 0) return ''
  if (family === 'image') return `${rows.map(imageClause).join('，')}。`
  return rows
    .map((line) => {
      if (family === 'ark') return arkLine(line, task, line.materials[0] === source)
      if (family === 'wan') return wanLine(line)
      return minimaxLine(line)
    })
    .join('\n')
}

const stripAt = (label: string) => label.replace(/^@/, '')

/**
 * 正文里资产卡的绑定写法（替换原来统一的「名字（编号）」）：
 * 方舟用「名字@编号」简写；万相直接称编号；MiniMax 在说明行里体现，正文只留名字；
 * 图片多参考保留「名字（编号）」。
 */
export function bindingText(family: BriefFamily, name: string, labels: string[]): string {
  if (labels.length === 0) return name
  if (family === 'minimax') return name
  if (family === 'wan') return joinLabels(labels)
  if (family === 'ark')
    return `${name}@${stripAt(labels[0]!)}${labels
      .slice(1)
      .map((label) => `、@${stripAt(label)}`)
      .join('')}`
  return `${name}（${joinLabels(labels)}）`
}

/** 原文紧挨着已经写了同一个名字时，只补编号部分，避免「叶舒叶舒」 */
export function bindingSuffix(family: BriefFamily, name: string, labels: string[]): string {
  if (labels.length === 0) return ''
  if (family === 'minimax') return ''
  if (family === 'wan') return `（${joinLabels(labels)}）`
  return bindingText(family, name, labels).slice(name.length)
}

// ── 提示词长度（软提示，不拦截） ─────────────────────────────

const CJK_CHAR = /[㐀-鿿　-〿＀-￯]/g
const LATIN_WORD = /[A-Za-z0-9][A-Za-z0-9'_@-]*/g

/** 方舟官方口径：中文提示词不超过 500 字，英文不超过 1000 词；含中文时按字数加词数计 */
export function arkPromptSize(text: string): { size: number; limit: number; unit: '字' | '词' } {
  const cjk = text.match(CJK_CHAR)?.length ?? 0
  const words = text.replace(CJK_CHAR, ' ').match(LATIN_WORD)?.length ?? 0
  return cjk > 0
    ? { size: cjk + words, limit: 500, unit: '字' }
    : { size: words, limit: 1000, unit: '词' }
}

/** 超出时给一句软提示；没超出返回 undefined */
export function promptLengthHint(
  family: BriefFamily | undefined,
  text: string,
  options: { modelId?: string; declaredLimit?: number } = {},
): string | undefined {
  if (family === 'ark') {
    const { size, limit, unit } = arkPromptSize(text)
    return size > limit
      ? `最终提示词约 ${size} ${unit}（含自动生成的素材说明），超过方舟建议的 ${limit} ${unit}，较长的描述可能被忽略；可精简正文，不会因此拦截生成`
      : undefined
  }
  // 平台声明了上限的由运行前的硬检查负责；MiniMax H3 官方上限 7000 字符，未声明时补一道软提示
  if (family === 'minimax' && options.declaredLimit === undefined) {
    const size = text.length
    return size > 7000
      ? `最终提示词 ${size} 字符（含自动生成的素材说明），超过 MiniMax H3 的 7000 字符上限，请精简`
      : undefined
  }
  return undefined
}

const CARD_ROLES: Record<string, BriefRoleType> = {
  'plein/character': 'character',
  'plein/scene': 'scene',
  'plein/prop': 'prop',
  'plein/style': 'style',
  'plein/effect': 'effect',
  'plein/speech': 'speech',
  'plein/music': 'music',
}

/**
 * 最终送入的每份素材及其作用：先看 @ 引用的明细（角色 / 场景 / 道具 / 风格卡、特效卡），
 * 再看连线上游的节点类型（配音、配乐、特效），都没有就是一份普通参考素材。
 * 编号与写法完全来自 modelbay 的标签函数。
 */
export function briefMaterials({
  doc,
  media,
  details,
  style,
}: {
  doc: PleinDoc
  /** 最终送入的素材，顺序即编号顺序 */
  media: PortValue[]
  details: InputRef[]
  style: ReferenceLabelStyle
}): BriefMaterial[] {
  const numbering = referenceMediaNumbering(style, media)
  const seen = new Set<string>()
  const out: BriefMaterial[] = []
  for (const value of media) {
    if (value.type !== 'image' && value.type !== 'video' && value.type !== 'audio') continue
    if (!('assetId' in value)) continue
    const kind = value.type
    const key = `${kind}:${value.assetId}`
    if (seen.has(key)) continue
    seen.add(key)
    const index = numbering.index(kind, value.assetId)
    const label = numbering.label(kind, value.assetId)
    if (index === undefined || label === undefined) continue
    const detail = details.find(
      (d) => (d.media ?? 'image') === kind && d.sent.includes(value.assetId),
    )
    const element = doc.get(
      detail?.elementId ?? ('source' in value ? value.source : undefined) ?? '',
    )
    const type = CARD_ROLES[element?.nodeType ?? '']
    const name = element ? (mentionName(element) ?? element.name) : undefined
    const role: BriefRole =
      element && type
        ? { type, ...(name ? { name } : {}), elementId: element.id }
        : { type: 'generic' }
    out.push({ kind, index, label, role })
  }
  return out
}
