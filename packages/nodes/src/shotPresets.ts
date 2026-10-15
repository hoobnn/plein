import { definePromptPreset, type PromptPresetDefinition, type ShotSlot } from '@plein/plugin-sdk'
import { z } from 'zod'

/**
 * 镜头与风格预设：运镜、景别、角度、光影、风格各一栏单选，拼成提示词末尾一两行可见、可改的文字。
 * 只是提示词，不是平台的摄影控制参数，效果因模型而异；发给模型的永远是提示词原文。
 */

const VIDEO = ['video.generate']
const PICTURE = ['image.generate', 'video.generate']

const slot = (
  s: ShotSlot,
  appliesTo: string[],
  list: Array<[id: string, title: string, template: string, description?: string]>,
) =>
  list.map(([id, title, template, description]) =>
    definePromptPreset({ id: `plein/${id}`, title, template, description, appliesTo, slot: s }),
  )

/** 不带速度的运镜：固定、手持 */
export const NO_SPEED = new Set(['plein/cam-static', 'plein/cam-handheld'])

export const shotPresets: PromptPresetDefinition[] = [
  ...slot('camera.move', VIDEO, [
    ['cam-static', '固定机位', '固定机位，镜头不动'],
    ['cam-push', '推近', '推近主体'],
    ['cam-pull', '拉远', '拉远露出环境'],
    ['cam-pan', '横摇', '水平摇镜'],
    ['cam-tilt', '升降', '垂直升降'],
    ['cam-orbit', '环绕', '环绕主体'],
    ['cam-follow', '跟拍', '跟随主体移动'],
    ['cam-handheld', '手持', '手持轻微晃动，有临场感'],
  ]),
  ...slot('camera.shot', PICTURE, [
    ['shot-extreme-long', '大远景', '大远景'],
    ['shot-long', '远景', '远景'],
    ['shot-full', '全景', '全景，人物全身入画'],
    ['shot-medium', '中景', '中景，膝盖以上'],
    ['shot-close', '近景', '近景，胸部以上'],
    ['shot-closeup', '特写', '面部特写'],
    ['shot-detail', '大特写', '局部大特写'],
  ]),
  ...slot('camera.angle', PICTURE, [
    ['angle-eye', '平视', '平视角度'],
    ['angle-low', '仰拍', '低角度仰拍'],
    ['angle-high', '俯拍', '高角度俯拍'],
    ['angle-bird', '鸟瞰', '正上方鸟瞰'],
    ['angle-ots', '过肩', '过肩视角'],
    ['angle-pov', '主观视角', '第一人称主观视角'],
  ]),
  ...slot('camera.light', PICTURE, [
    ['light-natural', '自然光', '柔和自然光'],
    ['light-back', '逆光', '逆光，轮廓光'],
    ['light-side', '侧光', '侧光，明暗对比'],
    ['light-golden', '黄金时刻', '黄金时刻暖光'],
    ['light-overcast', '阴天', '阴天漫射光'],
    ['light-neon', '霓虹夜景', '夜景霓虹灯光'],
    ['light-candle', '烛光', '烛光暖调，暗部深'],
    ['light-hard', '硬光', '顶部硬光，阴影锐利'],
  ]),
  ...slot('style', PICTURE, [
    ['style-film', '胶片', '胶片质感，细腻颗粒，暖色调', '35mm 胶片的颗粒和暖调'],
    ['style-hk', '港风', '90 年代港片风格，霓虹色调，高反差'],
    ['style-jp', '日系清新', '日系清新，低饱和，柔和自然光，空气感'],
    ['style-cyber', '赛博朋克', '赛博朋克，冷暖撞色霓虹，雨夜反光'],
    ['style-ink', '水墨国风', '水墨国风，大面积留白，淡雅墨色'],
    ['style-noir', '黑色电影', '黑色电影，高反差黑白，硬光阴影'],
    ['style-kdrama', '韩剧暖调', '韩剧质感，柔焦，暖色奶油调'],
    ['style-doc', '纪实', '纪实摄影风格，自然色彩，真实质感'],
  ]),
]

export const SPEEDS = { slow: '缓慢', normal: '', fast: '快速' } as const
export type ShotSpeed = keyof typeof SPEEDS

/** 节点上记的选择：选了哪些，以及上次插进提示词的原文（据此替换、判断有没有被手改） */
export const ShotPresetState = z.object({
  picks: z
    .partialRecord(
      z.enum(['camera.move', 'camera.shot', 'camera.angle', 'camera.light', 'style']),
      z.string(),
    )
    .default({}),
  speed: z.enum(['slow', 'normal', 'fast']).optional(),
  lines: z.object({ camera: z.string().optional(), style: z.string().optional() }).default({}),
})
export type ShotPresetState = z.infer<typeof ShotPresetState>
export type ShotLines = ShotPresetState['lines']

/** 节点参数里存选择的键；不进缓存键（提示词原文才是内容） */
export const SHOT_PRESETS_KEY = 'shotPresets'

export function shotStateOf(v: unknown): ShotPresetState {
  const parsed = ShotPresetState.safeParse(v ?? {})
  return parsed.success ? parsed.data : { picks: {}, lines: {} }
}

/** 某种节点能用的栏：图片没有运镜 */
export function slotsFor(capability: string | undefined): ShotSlot[] {
  if (capability === 'video.generate')
    return ['camera.move', 'camera.shot', 'camera.angle', 'camera.light', 'style']
  if (capability === 'image.generate')
    return ['camera.shot', 'camera.angle', 'camera.light', 'style']
  return []
}

type Preset = Pick<PromptPresetDefinition, 'id' | 'template' | 'slot'>

/** 按选择拼出要插进提示词的行：镜头一行（运镜、景别、角度、光影），风格一行 */
export function composeShotLines(
  state: Pick<ShotPresetState, 'picks' | 'speed'>,
  presets: readonly Preset[],
  capability: string | undefined,
): ShotLines {
  const byId = new Map(presets.map((p) => [p.id, p]))
  const allowed = new Set(slotsFor(capability))
  const text = (s: ShotSlot) => {
    const id = allowed.has(s) ? state.picks[s] : undefined
    const p = id ? byId.get(id) : undefined
    return p?.slot === s ? p.template.trim() : undefined
  }
  const move = text('camera.move')
  const speed =
    move && !NO_SPEED.has(state.picks['camera.move']!) ? SPEEDS[state.speed ?? 'normal'] : ''
  const camera = [
    move && `${speed}${move}`,
    text('camera.shot'),
    text('camera.angle'),
    text('camera.light'),
  ]
    .filter(Boolean)
    .join('，')
  const style = text('style')
  const head = capability === 'video.generate' ? '镜头' : '画面'
  return {
    ...(camera ? { camera: `${head}：${camera}。` } : {}),
    ...(style ? { style: `风格：${style}。` } : {}),
  }
}

/** 上次插进去的行还在不在提示词里（没在就是被手改过） */
export function shotLinesIntact(prompt: string, lines: ShotLines) {
  return {
    camera: !lines.camera || prompt.includes(lines.camera),
    style: !lines.style || prompt.includes(lines.style),
  }
}

/**
 * 换上新的行：旧行还在就原地替换（新行为空时连同换行一起删掉），不在就把新行接到末尾。
 * 只动自己插进去的那几行，用户写的其他内容不碰
 */
export function applyShotLines(prompt: string, prev: ShotLines, next: ShotLines): string {
  let out = prompt
  for (const key of ['camera', 'style'] as const) {
    const old = prev[key]
    const now = next[key]
    if (old === now && (!now || out.includes(now))) continue
    if (old && out.includes(old)) {
      if (now) out = out.replace(old, now)
      else {
        const i = out.indexOf(old)
        const start = i > 0 && out[i - 1] === '\n' ? i - 1 : i
        const end =
          start === i && out[i + old.length] === '\n' ? i + old.length + 1 : i + old.length
        out = out.slice(0, start) + out.slice(end)
      }
    } else if (now) {
      out = out.trimEnd()
      out = out ? `${out}\n${now}` : now
    }
  }
  return out
}

const MOVE_WORDS = /推近|拉远|推镜|拉镜|摇镜|横摇|环绕|跟拍|跟随镜头|升降镜头|运镜|手持/
const STATIC_WORDS = /固定机位|镜头不动|静止镜头/

/**
 * 明显的冲突，提示但不拦：
 * 固定机位却另写了运镜（或反过来）；图片节点里写了运镜；风格预设和 @风格卡一起用
 */
export function shotConflicts(input: {
  prompt: string
  state: ShotPresetState
  capability: string | undefined
  /** 提示词里 @ 了风格卡 */
  styleCard: boolean
}): string[] {
  const { prompt, state, capability } = input
  let rest: string = prompt
  for (const line of [state.lines.camera, state.lines.style])
    if (line) rest = rest.replace(line, '')
  const out: string[] = []
  const move = capability === 'video.generate' ? state.picks['camera.move'] : undefined
  if (move === 'plein/cam-static' && MOVE_WORDS.test(rest))
    out.push('提示词里另写了运镜，和「固定机位」冲突')
  else if (move && move !== 'plein/cam-static' && STATIC_WORDS.test(rest))
    out.push('提示词里写了固定机位，和所选运镜冲突')
  if (capability === 'image.generate' && (MOVE_WORDS.test(prompt) || prompt.includes('镜头：')))
    out.push('图片不会动，运镜描述最多被当成构图参考')
  if (state.picks.style && input.styleCard)
    out.push('同时用了风格预设和 @风格卡，两段描述可能打架；风格卡还会带上参考图')
  return out
}

/**
 * 改选择：算出新的提示词和要存的状态。picks 里给 null 表示清掉那一栏。
 * 旧行被手改过（不在提示词里了）时，新行接到末尾，手改的内容原样保留
 */
export function pickShotPresets(input: {
  prompt: string
  state: ShotPresetState
  change: { picks?: Partial<Record<ShotSlot, string | null>>; speed?: ShotSpeed }
  presets: readonly Preset[]
  capability: string | undefined
}): { prompt: string; state: ShotPresetState } {
  const { state, change } = input
  const picks = { ...state.picks }
  for (const [k, v] of Object.entries(change.picks ?? {}) as Array<[ShotSlot, string | null]>) {
    if (v) picks[k] = v
    else delete picks[k]
  }
  const speed = change.speed ?? state.speed
  const lines = composeShotLines({ picks, speed }, input.presets, input.capability)
  return {
    prompt: applyShotLines(input.prompt, state.lines, lines),
    state: { picks, ...(speed ? { speed } : {}), lines },
  }
}
