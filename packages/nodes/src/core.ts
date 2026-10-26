import { defineNode, definePlugin, PLUGIN_API_VERSION } from '@plein/plugin-sdk'
import { z } from 'zod'
import { CharacterProfile, emptyProfile } from './profile'
import { SceneViews } from './sceneViews'
import { corePrompts } from './prompts'
import { shotPresets } from './shotPresets'
import { noVoice, VoiceRef } from './refs'
import { sequenceNode } from './sequence'
import { animaticNode } from './animatic'
import { stageNode } from './stage'
import { storyboardNode } from './storyboard'
import { imageProcessNode } from './imageProcess'
import { sfxNode, transcribeNode } from './audioNodes'
import { shotAnalysisNode } from './shotAnalysis'
import { aiSceneNode, aiSummaryNode } from './aiShotAnalysis'
import { deliveryCheckNode } from './deliveryCheck'

const model = () => z.string().default('').meta({ title: '模型', widget: 'model' })
/** 分辨率：选项随所选模型变化，空字符串用平台默认 */
const resolution = () => z.string().default('').meta({ title: '分辨率', widget: 'resolution' })
/** 模型专属参数：按模型引用分开存，换模型再换回来时还在；执行时只取所选模型那份 */
const modelOptions = () =>
  z
    // 每个模型的历史值原样保留；执行时只校验当前模型，不能让未选项阻断生成。
    .record(z.string(), z.unknown())
    .default({})
    .meta({ title: '模型专属参数', widget: 'modelOptions' })
const textarea = (title: string, placeholder?: string) =>
  z.string().default('').meta({ title, widget: 'textarea', placeholder })
/**
 * 音色：`{ provider, voiceId }`，两家平台的音色 ID 互相不通用，跨平台必须重选。
 * 旧画布里存的是裸字符串（0.1.0 之前），所以并联字符串，读的时候用 `voiceOf` 归一。
 */
const voice = (title: string, placeholder?: string) =>
  z.union([VoiceRef, z.string()]).default(noVoice).meta({
    title,
    widget: 'voice',
    placeholder,
    description: '两家平台的音色不能混用；平台留空表示还没确认，跨平台时不会被自动沿用',
  })
/** 本次运行真正送进模型的 @ 引用：运行前算好，执行器显示在节点状态里；不是人工字段 */
const usedRefs = () =>
  z
    .array(z.object({ name: z.string(), elementId: z.string(), assetIds: z.array(z.string()) }))
    .default([])
    .meta({ title: '本次实际引用', widget: 'hidden' })
/**
 * 必需参考：@ 引用的元素 id，按优先级排列。必需参考先占参考图名额；缺图、当前模式不收参考图
 * 或放不下时这个镜头不提交。没设的引用都是可选参考，按角色、场景、道具的顺序取舍
 */
const requiredRefs = () =>
  z.array(z.string()).default([]).meta({ title: '必需参考', widget: 'hidden' })
/** 按角色元素 id 保存明确选中的图片资产；空数组表示只引用文字设定。 */
const referenceImagePicks = () =>
  z
    .record(z.string(), z.array(z.string()))
    .default({})
    .meta({ title: '指定角色参考图', widget: 'hidden' })
/**
 * 续镜来路：这个镜头接在哪段视频后面（父视频的元素、资产和取帧位置）。
 * 接续帧参与实际输入，连线缺失时按 frameAssetId 补齐；不进缓存键
 */
export const ContinuesFrom = z.object({
  elementId: z.string(),
  assetId: z.string(),
  /** 取帧位置（秒）；last 时是尾帧 */
  at: z.number().optional(),
  last: z.boolean().optional(),
  /** 取出的那一帧图片资产 */
  frameAssetId: z.string().optional(),
})
export type ContinuesFrom = z.infer<typeof ContinuesFrom>
/** 画幅从宽到高排；auto 为「智能」，交给模型按提示词或素材决定。各模型只显示自己支持的那些 */
const ASPECTS = ['auto', '21:9', '16:9', '3:2', '4:3', '1:1', '3:4', '2:3', '9:16'] as const

/** 文本：提示词、台词等，下游节点的文本输入 */
export const textNode = defineNode({
  type: 'plein/text',
  version: 1,
  title: '文本',
  description: '手写的提示词或文案，连到下游节点作为文本输入',
  category: 'input',
  inputs: [],
  outputs: [{ id: 'text', label: '文本', type: 'text' }],
  params: z.object({ text: textarea('文本', '写下提示词或台词') }),
})

/** 对话模型：生成或改写文本，可附图片 */
export const llmNode = defineNode({
  type: 'plein/llm',
  version: 1,
  title: 'LLM',
  description: '用对话模型生成或改写文本',
  category: 'text',
  capability: 'text.chat',
  inputs: [
    { id: 'prompt', label: '输入', type: 'text', multiple: true },
    { id: 'images', label: '图片', type: 'image', multiple: true },
  ],
  outputs: [{ id: 'text', label: '输出', type: 'text' }],
  params: z.object({
    model: model(),
    system: textarea('系统提示词'),
    prompt: textarea('提示词', '可用上游文本补充'),
    temperature: z.number().min(0).max(2).default(0.7).meta({ title: '温度' }),
    usedRefs: usedRefs(),
  }),
})

/** 文生图 / 参考图生图 */
export const imageNode = defineNode({
  type: 'plein/image',
  version: 1,
  title: '生成图片',
  description: '文生图；连上参考图即为图生图 / 多参考图生图',
  category: 'image',
  capability: 'image.generate',
  inputs: [
    { id: 'prompt', label: '提示词', type: 'text', multiple: true },
    { id: 'references', label: '参考图', type: 'image', multiple: true },
  ],
  outputs: [{ id: 'images', label: '图片', type: 'image' }],
  params: z.object({
    model: model(),
    prompt: textarea('提示词'),
    aspectRatio: z.enum(ASPECTS).default('16:9').meta({ title: '画幅' }),
    resolution: resolution(),
    options: modelOptions(),
    count: z.number().int().min(1).max(4).default(1).meta({ title: '张数' }),
    usedRefs: usedRefs(),
    requiredRefs: requiredRefs(),
    referenceImagePicks: referenceImagePicks(),
  }),
})

/** 局部重绘的蒙版：PNG 资产，和原图同宽高；白色 = 重绘，黑色 = 保留 */
export const EditMask = z.object({
  assetId: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** 画蒙版时的原图：原图换了蒙版就对不上，要重画 */
  sourceAssetId: z.string().optional(),
})
export type EditMask = z.infer<typeof EditMask>

/** 局部重绘：只改蒙版圈出的区域，其余保持原图。只用原生支持蒙版的模型 */
export const imageEditNode = defineNode({
  type: 'plein/image-edit',
  version: 1,
  title: '局部重绘',
  description: '在原图上框选或涂抹要改的区域，按提示词只重绘这块，其余保持不变',
  category: 'image',
  capability: 'image.edit',
  inputs: [
    { id: 'prompt', label: '提示词', type: 'text', multiple: true },
    { id: 'image', label: '原图', type: 'image', required: true },
  ],
  outputs: [{ id: 'images', label: '图片', type: 'image' }],
  params: z.object({
    model: model(),
    prompt: textarea('提示词', '这块区域改成什么，如：把杯子换成红色马克杯'),
    count: z.number().int().min(1).max(4).default(1).meta({ title: '张数' }),
    options: modelOptions(),
    mask: EditMask.nullable().default(null).meta({ title: '重绘区域', widget: 'hidden' }),
    usedRefs: usedRefs(),
  }),
})

/**
 * 视频生成模式：由用户指定，不按连线猜。连进来的图片按输入边的显式顺序编号，模式决定怎么用：
 * 图生视频用第 1 张做首帧，仅尾帧用第 1 张做尾帧，首尾帧用第 1、2 张，多模态参考使用全部参考素材。
 */
export const VIDEO_MODES = ['text', 'image', 'lastFrame', 'frames', 'reference'] as const
export type VideoMode = (typeof VIDEO_MODES)[number]
export const VIDEO_MODE_LABELS: Record<VideoMode, string> = {
  text: '文生视频',
  image: '图生视频',
  lastFrame: '仅尾帧',
  frames: '首尾帧',
  reference: '多模态参考',
}

/** 按模式检查连入的图片数，返回问题（null 表示可以运行）；前后端共用 */
export function videoModeProblem(mode: VideoMode, images: number): string | null {
  if (mode === 'image' && images !== 1)
    return images
      ? `图生视频只用 1 张图作首帧，现在连了 ${images} 张`
      : '图生视频需要连入 1 张图作首帧'
  if (mode === 'lastFrame' && images !== 1)
    return `仅尾帧需要连入 1 张图作尾帧，现在连了 ${images} 张`
  if (mode === 'frames' && images !== 2)
    return `首尾帧需要连入 2 张图（上面的作首帧、下面的作尾帧），现在连了 ${images} 张`
  if (mode === 'reference' && images === 0) return '多模态参考需要连入至少 1 份图片、视频或音频参考'
  return null
}

/** 生成视频：文生视频 / 图生视频 / 仅尾帧 / 首尾帧 / 多模态参考，模式由参数指定 */
export const videoNode = defineNode({
  type: 'plein/video',
  version: 2,
  title: '生成视频',
  description:
    '文生视频、图生视频、仅尾帧、首尾帧、多模态参考；在生成器里选模式，连入的图片按模式使用',
  category: 'video',
  capability: 'video.generate',
  inputs: [
    { id: 'prompt', label: '提示词', type: 'text', multiple: true },
    { id: 'images', label: '图片', type: 'image', multiple: true },
    { id: 'videos', label: '参考视频', type: 'video', multiple: true },
    { id: 'audios', label: '参考音频', type: 'audio', multiple: true },
  ],
  outputs: [
    { id: 'video', label: '视频', type: 'video' },
    { id: 'lastFrame', label: '尾帧', type: 'image' },
  ],
  params: z.object({
    model: model(),
    mode: z
      .enum(VIDEO_MODES)
      .default('text')
      .meta({ title: '生成模式', widget: 'videoMode', labels: VIDEO_MODE_LABELS }),
    prompt: textarea('提示词'),
    duration: z.number().int().min(1).max(30).default(5).meta({ title: '时长（秒）' }),
    aspectRatio: z.enum(ASPECTS).default('16:9').meta({ title: '画幅' }),
    resolution: resolution(),
    count: z.number().int().min(1).max(4).default(1).meta({ title: '数量' }),
    audio: z.boolean().default(true).meta({ title: '生成音频', widget: 'audio' }),
    options: modelOptions(),
    usedRefs: usedRefs(),
    requiredRefs: requiredRefs(),
    referenceImagePicks: referenceImagePicks(),
    continuesFrom: ContinuesFrom.nullable()
      .default(null)
      .meta({ title: '续镜来路', widget: 'hidden' }),
  }),
  // v1 的模式由文档迁移（schema v2）按原连线推断写入；这里只兜底
  migrate: (params) => ({ mode: 'text', ...params }),
})

/** 配音：语音合成 */
export const speechNode = defineNode({
  type: 'plein/speech',
  version: 1,
  title: '配音',
  description: '把台词合成为语音，可用自然语言指定情绪',
  category: 'audio',
  capability: 'audio.speech',
  inputs: [{ id: 'text', label: '台词', type: 'text', multiple: true }],
  outputs: [{ id: 'audio', label: '语音', type: 'audio' }],
  params: z.object({
    model: model(),
    text: textarea('台词'),
    // 手工填的音色 ID 留空时用平台设置里的默认；自动沿用角色卡音色由运行前处理决定
    voice: voice('音色', '音色 ID，留空用平台设置里的默认音色'),
    speed: z.number().min(0.5).max(2).default(1).meta({ title: '语速' }),
    options: modelOptions(),
    instruction: z
      .string()
      .default('')
      .meta({ title: '语气指令', placeholder: '如：压低声音，带着哭腔' }),
    usedRefs: usedRefs(),
  }),
})

/** 配乐 / 音效 */
export const musicNode = defineNode({
  type: 'plein/music',
  version: 1,
  title: '配乐',
  description: '按描述生成背景音乐',
  category: 'audio',
  capability: 'audio.music',
  inputs: [{ id: 'prompt', label: '描述', type: 'text', multiple: true }],
  outputs: [{ id: 'audio', label: '音乐', type: 'audio' }],
  params: z.object({
    model: model(),
    prompt: textarea('描述', '如：紧张的弦乐，渐强'),
    duration: z.number().int().min(5).max(300).default(30).meta({ title: '时长（秒）' }),
  }),
})

/** 角色设定卡：参考图 + 设定 + 音色，提示词里 @ 它即可引用 */
export const characterNode = defineNode({
  type: 'plein/character',
  version: 1,
  title: '角色',
  description: '角色设定卡：连入全身定妆、肖像、角色设定与情绪参考图，在提示词里 @ 角色名即可引用',
  category: 'story',
  inputs: [{ id: 'references', label: '参考图', type: 'image', multiple: true }],
  outputs: [{ id: 'images', label: '参考图', type: 'image' }],
  params: z.object({
    description: textarea('设定', '外貌、服装、性格，如：二十岁，短发，白衬衫'),
    voice: voice('音色', '配音时使用的音色，属于哪个平台要和配音模型一致'),
    // 时期、服饰、表情与次音色：在资产库里编辑，卡片上同步一份，@林夏/少年/校服 引用
    profile: CharacterProfile.default(emptyProfile).meta({ title: '角色档案', widget: 'hidden' }),
  }),
})

/** 场景设定卡 */
export const sceneNode = defineNode({
  type: 'plein/scene',
  version: 1,
  title: '场景',
  description: '场景设定卡：连入参考图，在提示词里 @ 场景名即可引用',
  category: 'story',
  inputs: [{ id: 'references', label: '参考图', type: 'image', multiple: true }],
  outputs: [{ id: 'images', label: '参考图', type: 'image' }],
  params: z.object({
    description: textarea('设定', '时间、地点、光线、氛围，如：雨夜，老城区天台，霓虹反光'),
    sceneViews: SceneViews.default([]).meta({ title: '场景视角', widget: 'hidden' }),
  }),
})

/** 道具设定卡：跨镜头复用的关键道具，外观要一次定死 */
export const propNode = defineNode({
  type: 'plein/prop',
  version: 1,
  title: '道具',
  description: '道具设定卡：连入参考图，在提示词里 @ 道具名即可引用',
  category: 'story',
  inputs: [{ id: 'references', label: '参考图', type: 'image', multiple: true }],
  outputs: [{ id: 'images', label: '参考图', type: 'image' }],
  params: z.object({
    description: textarea('设定', '材质、颜色、做旧程度，如：磨砂黑的旧打火机，铜盖有划痕'),
  }),
})

/** 风格卡：整部片的画面风格，参考图 + 风格描述 */
export const styleNode = defineNode({
  type: 'plein/style',
  version: 1,
  title: '风格',
  description: '风格卡：连入参考图定下画风，在提示词里 @ 风格名即可引用',
  category: 'story',
  inputs: [{ id: 'references', label: '参考图', type: 'image', multiple: true }],
  outputs: [{ id: 'images', label: '参考图', type: 'image' }],
  params: z.object({
    description: textarea('风格', '影调、镜头质感、年代，如：90 年代港片，胶片颗粒，冷调霓虹'),
  }),
})

/**
 * 特效卡：运镜 / 转场 / 视觉特效的做法。
 * 描述在 @ 引用时并入视频提示词；参考视频可手动连到视频生成器的参考视频端口，@ 本身只引用描述。
 */
export const effectNode = defineNode({
  type: 'plein/effect',
  version: 1,
  title: '特效',
  description: '特效卡：运镜 / 特效的描述与参考视频，在视频提示词里 @ 特效名即可引用描述',
  category: 'story',
  inputs: [{ id: 'references', label: '参考视频', type: 'video', multiple: true }],
  outputs: [{ id: 'videos', label: '参考视频', type: 'video' }],
  params: z.object({
    description: textarea(
      '描述',
      '镜头怎么动、画面怎么变，如：镜头从高空俯冲穿过云层，贴近地面后急停',
    ),
  }),
})

/** 内置核心插件：只有声明，执行器在服务端（apps/server/src/executors） */
export const corePlugin = definePlugin({
  manifest: {
    id: 'plein/core',
    version: '0.1.0',
    name: '基础节点',
    description: '文本、LLM、图片、视频、配音、配乐等与平台无关的基础节点',
    engines: { plein: `^${PLUGIN_API_VERSION}` },
    contributes: {
      nodes: [
        'plein/text@1',
        'plein/llm@1',
        'plein/image@1',
        'plein/image-edit@1',
        'plein/image-process@1',
        'plein/video@2',
        'plein/speech@1',
        'plein/music@1',
        'plein/sfx@1',
        'plein/transcribe@1',
        'plein/shot-analysis@1',
        'plein/shot-scene-draft@1',
        'plein/shot-summary-draft@1',
        'plein/delivery-check@1',
        'plein/character@1',
        'plein/scene@1',
        'plein/prop@1',
        'plein/style@1',
        'plein/effect@1',
        'plein/storyboard@1',
        'plein/sequence@2',
        'plein/animatic@1',
        'plein/stage@1',
      ],
      prompts: [...corePrompts, ...shotPresets].map((p) => p.id),
    },
    // 序列导出要用宿主的 ffmpeg
    permissions: { media: true, assets: 'write' },
  },
  nodes: [
    textNode,
    llmNode,
    imageNode,
    imageEditNode,
    imageProcessNode,
    videoNode,
    speechNode,
    musicNode,
    sfxNode,
    transcribeNode,
    shotAnalysisNode,
    aiSceneNode,
    aiSummaryNode,
    deliveryCheckNode,
    characterNode,
    sceneNode,
    propNode,
    styleNode,
    effectNode,
    storyboardNode,
    sequenceNode,
    animaticNode,
    stageNode,
  ],
  prompts: [...corePrompts, ...shotPresets],
})
