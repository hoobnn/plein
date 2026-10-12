import { definePromptPreset } from '@plein/plugin-sdk'

/**
 * 内置提示词预设：短剧常用的出图 / 视频 / 剧本写法。
 * `【…】` 是待填的占位，选用后生成器选中第一个，直接打字替换。
 */
export const corePrompts = [
  definePromptPreset({
    id: 'plein/three-view',
    title: '角色三视图',
    description: '正面、侧面、背面全身设定图，做角色卡参考图',
    template:
      '【角色】的角色设定三视图：正面、侧面、背面全身站姿，同一角色同一服装，纯白背景，平光，线条清晰，角色设计稿风格',
    appliesTo: ['image.generate'],
    params: { aspectRatio: '16:9', count: 1 },
  }),
  definePromptPreset({
    id: 'plein/expression-sheet',
    title: '表情九宫格',
    description: '同一角色九种表情的胸像',
    template:
      '【角色】的表情设定九宫格：开心、愤怒、悲伤、惊讶、恐惧、厌恶、平静、害羞、坚定，同一角色同一服装，胸像，统一浅灰背景',
    appliesTo: ['image.generate'],
    params: { aspectRatio: '1:1', count: 1 },
  }),
  definePromptPreset({
    id: 'plein/multi-angle',
    title: '多机位九宫格',
    description: '同一时刻的九个机位，挑镜头用',
    template:
      '【场景与动作】，九宫格多机位分镜：远景、全景、中景、近景、特写、俯拍、仰拍、过肩、主观视角，同一时刻同一场景，人物与服装保持一致',
    appliesTo: ['image.generate'],
    params: { aspectRatio: '16:9', count: 1 },
  }),
  definePromptPreset({
    id: 'plein/continuous-storyboard',
    title: '连贯分镜四宫格',
    description: '按时间顺序的四格分镜',
    template:
      '【剧情】，四格连贯分镜，从左上到右下按时间顺序，同一角色同一场景，光线一致，每格有明确的动作推进',
    appliesTo: ['image.generate'],
    params: { aspectRatio: '16:9', count: 1 },
  }),
  definePromptPreset({
    id: 'plein/plot-deduction',
    title: '剧情推演',
    description: '连入一张图，推演接下来的四个瞬间',
    template:
      '以参考图为第一格，推演接下来的剧情：【方向】。输出四宫格，每格一个关键瞬间，人物、服装、场景与参考图一致',
    appliesTo: ['image.generate'],
    params: { aspectRatio: '16:9', count: 1 },
  }),
  definePromptPreset({
    id: 'plein/slow-push',
    title: '缓推镜头',
    template: '镜头缓慢推近【主体】，人物有细微动作和呼吸感，背景景深轻微变化，画面稳定，不切镜',
    appliesTo: ['video.generate'],
  }),
  definePromptPreset({
    id: 'plein/orbit',
    title: '环绕运镜',
    template: '镜头围绕【主体】平稳环绕半圈，主体保持在画面中心，动作自然，光线一致，不切镜',
    appliesTo: ['video.generate'],
  }),
  definePromptPreset({
    id: 'plein/script',
    title: '改写成短剧剧本',
    description: '把梗概写成分场剧本，再连到分镜节点',
    template:
      '把下面的剧情改写成竖屏短剧剧本：按场次分段，每场写明时间、地点、出场人物；对白口语化，开头三秒有冲突，结尾留钩子。\n剧情：【剧情梗概】',
    appliesTo: ['plein/llm'],
  }),
]

/** 某个节点可用的预设 */
export function presetsFor<P extends { appliesTo?: string[] }>(
  presets: readonly P[],
  node: { type: string; capability?: string },
): P[] {
  return presets.filter(
    (p) =>
      !p.appliesTo?.length ||
      p.appliesTo.includes(node.type) ||
      (!!node.capability && p.appliesTo.includes(node.capability)),
  )
}

/** 光标前正在输入的 / 查询：只在行首触发，返回 / 的位置和查询词 */
export function slashQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const lineStart = before.lastIndexOf('\n') + 1
  if (before[lineStart] !== '/') return null
  const query = before.slice(lineStart + 1)
  if (/\s/.test(query)) return null
  return { start: lineStart, query }
}

/** 第一个待填占位【…】的位置，用于插入后选中 */
export function firstPlaceholder(text: string, from = 0): { start: number; end: number } | null {
  const start = text.indexOf('【', from)
  if (start < 0) return null
  const end = text.indexOf('】', start)
  return end < 0 ? null : { start, end: end + 1 }
}
