import { z } from 'zod'
import { hasVoice, VoiceRef } from './refs'

/**
 * 角色档案：以「时期」为主线组织一个角色在不同阶段的样子（前后端共用，纯数据 + 纯函数）。
 *
 * - 时期（童年、少年、青年……）：这一时期的外貌设定与参考图，一个主音色，
 *   若干状态次音色（生病、醉酒、耳语……），以及这一时期的多套服饰造型；
 * - 表情：跨时期通用的表情（开心、愤怒……），各自一段描述和参考图。
 *
 * 提示词里用 `@林夏/少年/校服/开心` 引用：`/` 后面按名字（含改名前的旧名）最长匹配，
 * 每类最多一个，顺序随意；只写服饰或次音色时，时期取它所属的那一个。
 */

export const PROFILE_LIMITS = {
  periods: 8,
  outfits: 12,
  voiceStates: 6,
  expressions: 24,
  images: 4,
} as const

const assetId = z.string().regex(/^[0-9a-f]{64}$/, '资产 id 不合法')
const name = z.string().trim().min(1).max(20)
/** 改名前的名字：旧提示词里的 `@林夏/旧名` 继续有效 */
const aliases = z.array(z.string().trim().min(1).max(20)).max(8).default([])

/** 一套服饰造型或一个表情 */
export const ProfileLook = z.object({
  id: z.string().min(1).max(40),
  name,
  aliases,
  description: z.string().max(1000).default(''),
  images: z.array(assetId).max(PROFILE_LIMITS.images).default([]),
})
export type ProfileLook = z.infer<typeof ProfileLook>

/** 状态次音色：生病、醉酒等状态下换一个音色 */
export const VoiceState = z.object({
  id: z.string().min(1).max(40),
  name,
  aliases,
  voice: VoiceRef,
})
export type VoiceState = z.infer<typeof VoiceState>

export const ProfilePeriod = ProfileLook.extend({
  /** 这一时期的主音色；空表示沿用角色的基础音色 */
  voice: VoiceRef.nullable().default(null),
  voiceStates: z.array(VoiceState).max(PROFILE_LIMITS.voiceStates).default([]),
  outfits: z.array(ProfileLook).max(PROFILE_LIMITS.outfits).default([]),
})
export type ProfilePeriod = z.infer<typeof ProfilePeriod>

export const CharacterProfile = z.object({
  periods: z.array(ProfilePeriod).max(PROFILE_LIMITS.periods).default([]),
  expressions: z.array(ProfileLook).max(PROFILE_LIMITS.expressions).default([]),
})
export type CharacterProfile = z.infer<typeof CharacterProfile>

export const emptyProfile = (): CharacterProfile => ({ periods: [], expressions: [] })

/** 从卡片参数或条目里读出档案；格式不对的当作没有，不让一张坏卡片拖垮整次运行 */
export function profileOf(raw: unknown): CharacterProfile {
  const parsed = CharacterProfile.safeParse(raw ?? {})
  return parsed.success ? parsed.data : emptyProfile()
}

export const profileSize = (p: CharacterProfile) => ({
  periods: p.periods.length,
  outfits: p.periods.reduce((n, x) => n + x.outfits.length, 0),
  expressions: p.expressions.length,
  voiceStates: p.periods.reduce((n, x) => n + x.voiceStates.length, 0),
})

export const profileEmpty = (p: CharacterProfile) =>
  p.periods.length === 0 && p.expressions.length === 0

/** 档案用到的全部图片，去重（存档、同步卡片时用） */
export function profileImages(p: CharacterProfile): string[] {
  const out = new Set<string>()
  for (const period of p.periods) {
    for (const id of period.images) out.add(id)
    for (const o of period.outfits) for (const id of o.images) out.add(id)
  }
  for (const e of p.expressions) for (const id of e.images) out.add(id)
  return [...out]
}

// ── 预设 ───────────────────────────────────────────────

export const PERIOD_PRESETS = ['童年', '少年', '青年', '中年', '老年'] as const
export const OUTFIT_PRESETS = ['日常', '校服', '正装', '运动', '睡衣', '古装', '战斗'] as const
export const VOICE_STATE_PRESETS = ['生病', '虚弱', '醉酒', '哭腔', '耳语', '愤怒'] as const
export const EXPRESSION_PRESETS = [
  '开心',
  '大笑',
  '悲伤',
  '哭泣',
  '愤怒',
  '惊讶',
  '害怕',
  '害羞',
  '平静',
  '坚定',
] as const

// ── 改名与重名 ─────────────────────────────────────────

/** 档案里所有能写进引用的名字（含旧名），重名检查用；exceptId 是正在改的那一项 */
export function profileNames(p: CharacterProfile, exceptId?: string): Set<string> {
  const out = new Set<string>()
  const add = (x: { id: string; name: string; aliases: string[] }) => {
    if (x.id === exceptId) return
    out.add(x.name)
    for (const a of x.aliases) out.add(a)
  }
  for (const period of p.periods) {
    add(period)
    period.outfits.forEach(add)
    period.voiceStates.forEach(add)
  }
  p.expressions.forEach(add)
  return out
}

/**
 * 改名：旧名进 aliases，旧提示词里的 `@林夏/旧名` 不断链；改回旧名时从 aliases 里拿掉。
 * 同一个角色里名字（含旧名）不能重复，否则 `@林夏/学生` 指不明是时期还是服饰。
 */
export function renamed<T extends { name: string; aliases: string[] }>(item: T, next: string): T {
  const to = next.trim()
  if (!to || to === item.name) return item
  const aliases = [...new Set([item.name, ...item.aliases])].filter((a) => a !== to).slice(0, 8)
  return { ...item, name: to, aliases }
}

/** 新名字能不能用：空、过长或与档案里其他项（含旧名）重名时返回原因 */
export function nameProblem(p: CharacterProfile, next: string, exceptId?: string) {
  const to = next.trim()
  if (!to) return '名字不能为空'
  if (to.length > 20) return '名字最多 20 个字'
  if (/[/@#\s]/.test(to)) return '名字里不能有 / @ # 和空格'
  if (profileNames(p, exceptId).has(to)) return `「${to}」已经用过了，同一个角色里名字不能重复`
  return undefined
}

/** 新项的 id：短随机串，档案内唯一即可 */
export const profileId = () => Math.random().toString(36).slice(2, 10)

// ── 引用解析 ───────────────────────────────────────────

/** `@林夏/少年/校服/开心` 解析出来的档案项 */
export interface ProfilePick {
  period?: ProfilePeriod
  outfit?: ProfileLook
  expression?: ProfileLook
  voiceState?: VoiceState
}

type Slot = keyof ProfilePick

interface Candidate {
  slot: Slot
  text: string
  item: ProfilePeriod | ProfileLook | VoiceState
  /** 服饰、次音色所属的时期 */
  owner?: ProfilePeriod
}

function candidates(p: CharacterProfile): Candidate[] {
  const out: Candidate[] = []
  const push = (slot: Slot, item: Candidate['item'], owner?: ProfilePeriod) => {
    for (const text of [item.name, ...item.aliases]) out.push({ slot, text, item, owner })
  }
  for (const period of p.periods) {
    push('period', period)
    for (const o of period.outfits) push('outfit', o, period)
    for (const v of period.voiceStates) push('voiceState', v, period)
  }
  for (const e of p.expressions) push('expression', e)
  // 长的优先：「开心大笑」不是「开心」后面多两个字
  return out.sort((a, b) => b.text.length - a.text.length)
}

export interface ProfileMatch {
  pick: ProfilePick
  /** 消耗掉的字符数（含每个 `/`） */
  length: number
  /** 写了 `/xxx` 却对不上任何档案项：xxx（截到标点或空白），给用户提示用 */
  miss?: string
  /** 服饰 / 次音色不属于写明的时期 */
  conflict?: string
}

const WORD = /^[^\s@#/，。,.!！?？:：;；、（）()【】[\]「」"'“”]{1,12}/

/**
 * 从名字后面的文本（`/少年/校服站在天台`）里读出档案项。
 * 每类最多一个；同一类写了两次时第二个不再匹配，原样留在文本里。
 */
export function matchProfile(rest: string, profile: CharacterProfile): ProfileMatch {
  const list = candidates(profile)
  const pick: ProfilePick = {}
  const owners: ProfilePeriod[] = []
  let length = 0
  let miss: string | undefined
  while (rest[length] === '/') {
    const tail = rest.slice(length + 1)
    const hit = list.find((c) => !pick[c.slot] && tail.startsWith(c.text))
    if (!hit) {
      miss = tail.match(WORD)?.[0]
      break
    }
    ;(pick as Record<Slot, unknown>)[hit.slot] = hit.item
    if (hit.owner) owners.push(hit.owner)
    length += 1 + hit.text.length
  }
  let conflict: string | undefined
  for (const owner of owners) {
    if (!pick.period) pick.period = owner
    else if (owner.id !== pick.period.id) {
      conflict = `「${pick.period.name}」时期没有这一项，它属于「${owner.name}」`
      if (pick.outfit && !pick.period.outfits.includes(pick.outfit)) delete pick.outfit
      if (pick.voiceState && !pick.period.voiceStates.includes(pick.voiceState))
        delete pick.voiceState
    }
  }
  return { pick, length, miss, conflict }
}

export const pickEmpty = (p: ProfilePick) =>
  !p.period && !p.outfit && !p.expression && !p.voiceState

/** 引用的显示名：`林夏（少年·校服·开心）` */
export function pickLabel(name: string, p: ProfilePick) {
  const parts = [p.period, p.outfit, p.expression, p.voiceState].flatMap((x) => (x ? [x.name] : []))
  return parts.length ? `${name}（${parts.join('·')}）` : name
}

/** 并进提示词的设定：基础设定 → 时期 → 服饰 → 表情，后面的覆盖前面的 */
export function pickNotes(base: string, p: ProfilePick): string {
  const lines = [base.trim()]
  if (p.period?.description.trim())
    lines.push(`${p.period.name}时期：${p.period.description.trim()}`)
  if (p.outfit?.description.trim())
    lines.push(`服饰「${p.outfit.name}」：${p.outfit.description.trim()}`)
  if (p.expression)
    lines.push(
      `表情「${p.expression.name}」${p.expression.description.trim() ? `：${p.expression.description.trim()}` : ''}`,
    )
  return lines.filter(Boolean).join('\n')
}

/** 每个角色最多送几张参考图：生成模型普遍只收 4–10 张 */
export const PICK_IMAGE_LIMIT = 6

/**
 * 送进模型的参考图：命中的时期、服饰各取前两张，表情取一张，再补基础参考图，去重后截到上限。
 * 时期的图排最前：年龄和脸型最难靠文字纠正。
 */
export function pickImages(p: ProfilePick, base: readonly string[], limit = PICK_IMAGE_LIMIT) {
  const ordered = [
    ...(p.period?.images.slice(0, 2) ?? []),
    ...(p.outfit?.images.slice(0, 2) ?? []),
    ...(p.expression?.images.slice(0, 1) ?? []),
    ...base,
  ]
  return [...new Set(ordered)].slice(0, limit)
}

/** 配音用的音色：状态次音色 → 时期主音色 → 基础音色 */
export function pickVoice(p: ProfilePick, base: VoiceRef): VoiceRef {
  if (p.voiceState && hasVoice(p.voiceState.voice)) return p.voiceState.voice
  if (p.period?.voice && hasVoice(p.period.voice)) return p.period.voice
  return base
}

/** `@名字` 后面可以接的档案项（提示词框补全用），已经写了的那一类不再给 */
export interface ProfileOption {
  slot: Slot
  name: string
  /** 所属时期（服饰、次音色） */
  period?: string
  images: string[]
}

export function profileOptions(profile: CharacterProfile, written: ProfilePick): ProfileOption[] {
  const out: ProfileOption[] = []
  const periods = written.period ? [written.period] : profile.periods
  if (!written.period)
    for (const p of profile.periods) out.push({ slot: 'period', name: p.name, images: p.images })
  if (!written.outfit)
    for (const p of periods)
      for (const o of p.outfits)
        out.push({ slot: 'outfit', name: o.name, period: p.name, images: o.images })
  if (!written.expression)
    for (const e of profile.expressions)
      out.push({ slot: 'expression', name: e.name, images: e.images })
  if (!written.voiceState)
    for (const p of periods)
      for (const v of p.voiceStates)
        out.push({ slot: 'voiceState', name: v.name, period: p.name, images: [] })
  return out
}

export const SLOT_LABELS: Record<Slot, string> = {
  period: '时期',
  outfit: '服饰',
  expression: '表情',
  voiceState: '次音色',
}
