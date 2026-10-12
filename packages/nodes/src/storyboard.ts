import { defineNode } from '@plein/plugin-sdk'
import { z } from 'zod'
import { type VoiceRef, voiceOf } from './refs'

export const SHOT_SIZES = ['远景', '全景', '中景', '近景', '特写'] as const

/** 一行分镜。id 稳定，重新生成按镜号对齐 */
export const Shot = z.object({
  id: z.string(),
  no: z.number().int(),
  duration: z.number().min(1).max(30).default(5),
  shotSize: z.enum(SHOT_SIZES).default('中景'),
  /** 画面描述 */
  description: z.string().default(''),
  /** 出场的资产卡名字（角色、场景），展开时作为 @ 引用 */
  characters: z.array(z.string()).default([]),
  emotion: z.string().default(''),
  lighting: z.string().default(''),
  sfx: z.string().default(''),
  dialogue: z.array(z.object({ character: z.string(), line: z.string() })).default([]),
  /** 分镜图提示词 */
  imagePrompt: z.string().default(''),
  /** 视频运动提示词 */
  motionPrompt: z.string().default(''),
  /** 用户手改过：重新生成时不覆盖 */
  edited: z.boolean().optional(),
})
export type Shot = z.infer<typeof Shot>

/** 交给模型的结构：不含 id 和 edited，由宿主补上 */
export const ShotDraft = Shot.omit({ id: true, edited: true })
export const StoryboardDraft = z.object({ shots: z.array(ShotDraft) })

const model = () => z.string().default('').meta({ title: '模型', widget: 'model' })

/** 分镜：剧本 → 结构化分镜表；表格可编辑，可展开成每个镜头一组节点 */
export const STORYBOARD_TYPE = 'plein/storyboard'

export const storyboardNode = defineNode({
  type: STORYBOARD_TYPE,
  version: 1,
  title: '分镜',
  description: '把剧本拆成分镜表（景别、画面、出场角色、台词、提示词），可展开成镜头节点',
  category: 'story',
  capability: 'text.chat',
  inputs: [{ id: 'script', label: '剧本', type: 'text', multiple: true }],
  outputs: [{ id: 'shots', label: '分镜', type: 'json' }],
  params: z.object({
    model: model(),
    prompt: z.string().default('').meta({
      title: '要求',
      widget: 'textarea',
      placeholder: '补充要求，如：竖屏短剧节奏，每镜 3–5 秒',
    }),
    shotCount: z.number().int().min(1).max(30).default(8).meta({ title: '镜头数' }),
    shots: z.array(Shot).default([]).meta({ title: '分镜表', widget: 'hidden' }),
  }),
  applyOutputs(params, outputs) {
    const value = outputs.shots?.[0]?.value as { shots?: unknown } | undefined
    const drafts = StoryboardDraft.safeParse(value)
    if (!drafts.success) return undefined
    return { shots: mergeShots(params.shots, drafts.data.shots) }
  },
})

let seq = 0
export const newShotId = () =>
  `shot_${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`

/* ------------------------------------------------------------------ *
 * 展开计划：版本、快照、差异与同步（roadmap E1「分镜计划与更新」）
 *
 * 分镜表是镜头计划的事实来源，但展开出来的节点有自己的参数、用户也会手改。
 * 所以展开时在节点的 source 上存一份快照，表格改动后靠它区分两件事：
 * 「计划变了」和「用户在节点上改过」——前者可以同步，后者默认保留。
 * ------------------------------------------------------------------ */

/** 展开出来的节点按角色分三类：分镜图、视频、配音 */
export const SHOT_ROLES = ['image', 'video', 'speech'] as const
export type ShotRole = (typeof SHOT_ROLES)[number]

/** 每种角色从分镜取哪些节点参数：同步与差异只看这几个键，节点自己的模型、种子等不动 */
export const PLAN_PARAMS: Record<ShotRole, readonly string[]> = {
  image: ['prompt'],
  video: ['prompt', 'duration'],
  speech: ['text', 'voice'],
}

/** 推导某个角色的节点按当前分镜该有的参数值。资产 @ 引用和音色要找画布上的卡片，由调用方给出 */
export function planParams(
  shot: Shot,
  role: ShotRole,
  ctx: { mentions?: string; line?: number; voice?: VoiceRef | string } = {},
): Record<string, unknown> {
  if (role === 'speech') {
    const line = shot.dialogue[ctx.line ?? 0]
    // 音色连平台一起写进节点：展开出来的配音节点也要受「跨平台不复用音色」约束，
    // 只写 voiceId 的话换模型后无从判断这个音色属于哪一家
    const voice =
      ctx.voice === undefined
        ? ''
        : typeof ctx.voice === 'string'
          ? voiceOf({ voice: ctx.voice })
          : ctx.voice
    return { text: line?.line ?? '', voice }
  }
  if (role === 'image') {
    return {
      prompt: [ctx.mentions, shot.imagePrompt || shot.description].filter(Boolean).join(' '),
    }
  }
  return {
    prompt: shot.motionPrompt || shot.description,
    duration: Math.max(1, Math.min(30, Math.round(shot.duration))),
  }
}

/** 展开时写在节点 source 上的计划快照：当时的分镜版本 + 真正写进节点的参数值 */
export const ShotPlan = z.object({
  version: z.string(),
  params: z.record(z.string(), z.unknown()),
  /** 用户接管的字段：这些键不再被「同步未改字段」覆盖，直到重新展开该镜头 */
  keep: z.array(z.string()).default([]),
})
export type ShotPlan = z.infer<typeof ShotPlan>

/**
 * 分镜表的版本号：内容哈希。表格一改就变，不依赖谁来记得 +1
 * （表格编辑、模型重新生成、协作者改写都会经过这里）。
 */
export function planVersion(shots: Shot[]): string {
  // 按固定字段顺序序列化，避免 Yjs 往返后键序不同导致版本乱跳
  const text = JSON.stringify(
    shots.map((s) => [
      s.id,
      s.no,
      s.duration,
      s.shotSize,
      s.description,
      s.characters,
      s.emotion,
      s.lighting,
      s.sfx,
      s.dialogue,
      s.imagePrompt,
      s.motionPrompt,
      s.edited ?? false,
    ]),
  )
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `v${(h >>> 0).toString(36)}`
}

/** 参数比较：未设置与空串视为同一个值，老文档和迁移过的节点会缺字段 */
const same = (a: unknown, b: unknown) => {
  const norm = (v: unknown) => (v === undefined || v === null || v === '' ? '' : v)
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b))
}

/** 一个参数上的差异：计划值、节点现值，以及「谁变了」 */
export interface PlanDiff {
  /** 节点参数键，如 prompt / duration / text / voice */
  key: string
  /** 展开时写进节点的计划值 */
  expanded: unknown
  /** 计划现在推导出的值 */
  wanted: unknown
  /** 节点里现在的值 */
  actual: unknown
  /** 计划改过，节点还是展开时的值 */
  stale: boolean
  /** 用户在节点上手改过（或已选择保留覆盖）：同步时不碰它 */
  overridden: boolean
  /** 节点展开时还没有快照（升级前展开的）：分不清手改与否，差异面板要说明 */
  legacy: boolean
}

/** 比对用的上下文：节点上的快照、当前分镜版本、计划推导值、节点现值 */
export interface PlanContext {
  /** 展开时记下的快照，老节点没有 */
  plan?: ShotPlan
  /** 当前分镜表的版本（planVersion） */
  version: string
  /** 按当前分镜推导出的值 */
  wanted: Record<string, unknown>
  /** 节点里现在的值 */
  actual: Record<string, unknown>
}

/**
 * 某个角色的节点与当前分镜逐个参数比对；只有该角色关心的参数参与。
 * - 快照版本与当前版本一致：这一版的差异已经确认过，不再重复提示；
 * - keep 里的字段是用户接管的，计划再动也只提示不覆盖（手改不丢）；
 * - 没有快照的老节点分不清手改与否，当成未手改，差异面板会标出来。
 */
export function diffPlan(role: ShotRole, ctx: PlanContext): PlanDiff[] {
  const { plan, version, wanted, actual } = ctx
  const settled = plan?.version === version
  const keep = plan?.keep ?? []
  const legacy = !plan
  return PLAN_PARAMS[role].map((key) => {
    const expanded = plan?.params[key]
    return {
      key,
      expanded,
      wanted: wanted[key],
      actual: actual[key],
      stale: !settled && !same(expanded, wanted[key]),
      // 没有快照的老节点分不清是不是手改过，按未手改处理（同步前会先展示差异）
      overridden: !settled && (keep.includes(key) || (!legacy && !same(expanded, actual[key]))),
      legacy,
    }
  })
}

/** 同步的两种选择 */
export type SyncMode = 'unmodified' | 'keep-overrides'

export interface PlanSync {
  /** 要写进节点的参数补丁，为空表示这次不动节点 */
  params: Record<string, unknown>
  /** 同步后的快照：确认过的差异推进到当前版本，剩下的下次还会报 */
  plan: ShotPlan
}

/**
 * 合并出「写进节点的参数补丁」与「同步后的快照」。
 * unmodified：只同步用户没在节点上动过的字段，动过的保留用户值并记进 keep，
 * 之后计划再动这个字段也不会覆盖它（手改不丢）；
 * keep-overrides：一个字段都不覆盖，把节点现状固化成新基线
 * （确认过差异，这版先按现状出图，不再反复提示）。
 */
export function syncPlan(role: ShotRole, mode: SyncMode, ctx: PlanContext): PlanSync {
  const params: Record<string, unknown> = {}
  const snapshot: Record<string, unknown> = {}
  const keep = new Set(ctx.plan?.keep ?? [])
  for (const d of diffPlan(role, ctx)) {
    const write = mode === 'unmodified' && !d.overridden && !same(d.wanted, d.actual)
    if (write) params[d.key] = d.wanted
    else if (d.overridden) keep.add(d.key)
    // 节点上没设过的字段按计划记，快照里不留 undefined（Yjs 里也会被当成删除）
    snapshot[d.key] = write ? d.wanted : (d.actual ?? d.expanded ?? d.wanted)
  }
  return { params, plan: { version: ctx.version, params: snapshot, keep: [...keep] } }
}

/**
 * 删镜头：行从计划里去掉，已展开的节点和它们的产物必须留着。
 * 返回被删的那一行，调用方据此提示「N 个节点保留在画布上」并标记脱离计划；
 * 删除与标记同属一次事务，撤销一步即可整体恢复。
 */
export function dropShot(
  shots: Shot[],
  shotId: string,
): { shots: Shot[]; dropped: Shot | undefined } {
  const dropped = shots.find((s) => s.id === shotId)
  return { shots: dropped ? shots.filter((s) => s.id !== shotId) : shots, dropped }
}

/**
 * 新生成的分镜并入现有表格：按镜号对齐，手改过的行保留原样，
 * 其余行换成新内容但沿用原 id（已展开的镜头节点按 id 对应）。
 */
export function mergeShots(current: Shot[], drafts: Array<z.input<typeof ShotDraft>>): Shot[] {
  const byNo = new Map(current.map((s) => [s.no, s]))
  const out: Shot[] = drafts.map((d, i) => {
    const draft = ShotDraft.parse({ ...d, no: d.no ?? i + 1 })
    const old = byNo.get(draft.no)
    if (old?.edited) return old
    return { ...draft, id: old?.id ?? newShotId() }
  })
  // 手改过但新结果里没有的镜头也保留
  const seen = new Set(out.map((s) => s.no))
  for (const s of current) if (s.edited && !seen.has(s.no)) out.push(s)
  return out.sort((a, b) => a.no - b.no)
}
