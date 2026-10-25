import { imageProcess } from './image-process'
import {
  characterNode,
  effectNode,
  corePlugin,
  imageEditNode,
  imageNode,
  llmNode,
  musicNode,
  propNode,
  sceneNode,
  arrangeSequence,
  sequenceNode,
  sequenceSpec,
  subtitleExportProblem,
  speechNode,
  StoryboardDraft,
  stageNode,
  storyboardNode,
  styleNode,
  textNode,
  videoModeProblem,
  videoNode,
  voiceOf,
} from '@plein/nodes'
import {
  type ChatMessage,
  defineExecutor,
  defineServerPlugin,
  type ExecutorContext,
  inputAssets,
  inputText,
  ProviderError,
  videoTaskOverrides,
} from '@plein/plugin-sdk'
import { z } from 'zod'
import { mediaCaps, missingCapability } from '../assets/media'
import { animaticExecutor } from './animatic'
import { sfx, transcription, speechDirection, speechVoice } from './audio'

/** 节点选的模型：不替用户挑，没选就报错 */
function pickModel(ctx: ExecutorContext<{ model: string }>, label: string) {
  if (ctx.params.model) return ctx.params.model
  throw new ProviderError('invalid_input', `还没选「${label}」用的模型，请在节点上选择`)
}

/** 所选模型的专属参数 */
function modelOptions(params: { model: string; options: Record<string, unknown> }) {
  const value = params.model ? params.options[params.model] : undefined
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ProviderError('invalid_input', '当前模型的专属参数格式无效，请修正或恢复默认')
  return value as Record<string, unknown>
}

/** 参数里的文本与上游文本合并：两者都有时参数在前 */
function joinText(own: string, upstream: string | undefined) {
  return [own.trim(), upstream?.trim()].filter(Boolean).join('\n\n')
}

function requireText(text: string, label: string) {
  if (!text) throw new ProviderError('invalid_input', `${label}为空`)
  return text
}

/**
 * 把「本次真正送进模型的 @ 引用」写进节点运行状态。
 * 运行前的解析结果通过隐藏参数带过来（见 node 定义的 `usedRefs`），
 * 用户在节点上能直接看到这次送的是谁、几张参考图；extra 用来补一句提示。
 */
function sayProgress(ctx: ExecutorContext<{ usedRefs?: unknown }>, extra = '') {
  const refs = (ctx.params.usedRefs ?? []) as Array<{ name: string; assetIds: string[] }>
  const shown = refs.length
    ? `本次引用：${refs
        .map((r) => (r.assetIds.length ? `${r.name}（${r.assetIds.length} 张参考图）` : r.name))
        .join('、')}`
    : ''
  const text = [shown, extra].filter(Boolean).join('；')
  if (text) ctx.progress(0, text)
}

const text = defineExecutor(textNode, async ({ params }) => ({
  text: [{ type: 'text', text: params.text }],
}))

const llm = defineExecutor(llmNode, async (ctx) => {
  const { params, inputs } = ctx
  const prompt = requireText(joinText(params.prompt, inputText(inputs, 'prompt')), '提示词')
  const images = inputAssets(inputs, 'images')
  sayProgress(ctx)
  const messages: ChatMessage[] = []
  if (params.system.trim()) messages.push({ role: 'system', content: params.system })
  messages.push({
    role: 'user',
    content: images.length
      ? [
          { type: 'text', text: prompt },
          ...images.map((image) => ({ type: 'image' as const, image })),
        ]
      : prompt,
  })
  const res = await ctx.providers.call('text.chat', pickModel(ctx, '对话'), {
    messages,
    temperature: params.temperature,
  })
  const out = res.outputs.flatMap((o) =>
    o.type === 'text' ? [o.text] : o.type === 'json' ? [JSON.stringify(o.value)] : [],
  )
  return { text: [{ type: 'text', text: out.join('\n') }] }
})

const image = defineExecutor(imageNode, async (ctx) => {
  const { params, inputs } = ctx
  sayProgress(ctx)
  const res = await ctx.providers.call('image.generate', pickModel(ctx, '生成图片'), {
    prompt: requireText(joinText(params.prompt, inputText(inputs, 'prompt')), '提示词'),
    references: inputAssets(inputs, 'references'),
    count: params.count,
    resolution: params.resolution || undefined,
    extra: { ...modelOptions(params), aspectRatio: params.aspectRatio },
  })
  return { images: res.assets.map((a) => ({ type: 'image' as const, ...a })) }
})

const imageEdit = defineExecutor(imageEditNode, async (ctx) => {
  const { params, inputs } = ctx
  const [source] = inputAssets(inputs, 'image')
  if (!source) throw new ProviderError('invalid_input', '局部重绘需要连入一张原图')
  const mask = params.mask
  if (!mask)
    throw new ProviderError('invalid_input', '还没画重绘区域：点「画区域」框选或涂抹要改的地方')
  if (mask.sourceAssetId && mask.sourceAssetId !== source.assetId)
    throw new ProviderError('invalid_input', '原图换过了，重绘区域对不上：点「画区域」重新画')
  sayProgress(ctx)
  const res = await ctx.providers.call('image.edit', pickModel(ctx, '局部重绘'), {
    image: source,
    mask: { assetId: mask.assetId, kind: 'image', mime: 'image/png' },
    prompt: requireText(joinText(params.prompt, inputText(inputs, 'prompt')), '提示词'),
    count: params.count,
    extra: modelOptions(params),
  })
  return { images: res.assets.map((a) => ({ type: 'image' as const, ...a })) }
})

const video = defineExecutor(videoNode, async (ctx) => {
  const { params, inputs } = ctx
  const images = inputAssets(inputs, 'images')
  const references = [...images, ...inputAssets(inputs, 'videos'), ...inputAssets(inputs, 'audios')]
  if (params.mode !== 'reference' && references.length > images.length)
    throw new ProviderError('invalid_input', '视频或音频参考需要选择多模态参考模式')
  const problem = videoModeProblem(
    params.mode,
    params.mode === 'reference' ? references.length : images.length,
  )
  if (problem) throw new ProviderError('invalid_input', problem)
  // 文生视频不送图；其余按模式取用连入的图片
  const media =
    params.mode === 'image'
      ? { firstFrame: images[0] }
      : params.mode === 'lastFrame'
        ? { lastFrame: images[0] }
        : params.mode === 'frames'
          ? { firstFrame: images[0], lastFrame: images[1] }
          : params.mode === 'reference'
            ? { references }
            : {}
  sayProgress(ctx)
  const model = pickModel(ctx, '生成视频')
  const spec = ctx.providers.models('video.generate').find((m) => m.ref === model)
  const prompt = joinText(params.prompt, inputText(inputs, 'prompt'))
  const input = {
    prompt:
      spec?.limits?.optionalVideoPrompt && params.mode !== 'text' && references.length
        ? prompt
        : requireText(prompt, '提示词'),
    ...media,
    duration: params.duration,
    aspectRatio: params.aspectRatio,
    resolution: params.resolution || undefined,
    audio: params.audio,
    extra: modelOptions(params),
    ...videoTaskOverrides(params),
  }
  // 平台一次只出一条视频：要几条就并行提交几次
  const results = await Promise.all(
    Array.from({ length: params.count }, () => ctx.providers.call('video.generate', model, input)),
  )
  const assets = results.flatMap((r, index) =>
    r.assets.map((asset) => ({ ...asset, outputGroup: String(index) })),
  )
  return {
    video: assets.filter((a) => a.kind === 'video').map((a) => ({ type: 'video' as const, ...a })),
    // 开了「返回尾帧」的模型多给一张图
    lastFrame: assets
      .filter((a) => a.kind === 'image')
      .map((a) => ({ type: 'image' as const, ...a })),
  }
})

const speech = defineExecutor(speechNode, async (ctx) => {
  const { params, inputs } = ctx
  const text = requireText(joinText(params.text, inputText(inputs, 'text')), '台词')
  // 音色存的是 { provider, voiceId }，送进平台前只取音色 ID：
  // 各家的音色 ID 只在本家平台有效，平台的入参契约不变
  const voice = voiceOf(params)
  const model = pickModel(ctx, '配音')
  const check = speechVoice(model, voice)
  if (check.problem) throw new ProviderError('invalid_input', check.problem, { retryable: false })
  sayProgress(ctx, check.notice)
  const direction = speechDirection(
    model,
    params.instruction,
    modelOptions(params),
    ctx.providers.models('audio.speech').find((spec) => spec.ref === model),
  )
  const res = await ctx.providers.call('audio.speech', model, {
    text,
    voice: voice.voiceId || undefined,
    instruction: direction.instruction,
    // 1 倍是平台默认，不传：有的平台（千问）不接受语速参数
    speed: params.speed === 1 ? undefined : params.speed,
    extra: direction.extra,
  })
  // 台词随语音一起往下游传，序列导出时用作字幕
  return { audio: res.assets.map((a) => ({ type: 'audio' as const, ...a, caption: text })) }
})

const music = defineExecutor(musicNode, async (ctx) => {
  const { params, inputs } = ctx
  const res = await ctx.providers.call('audio.music', pickModel(ctx, '配乐'), {
    prompt: requireText(joinText(params.prompt, inputText(inputs, 'prompt')), '描述'),
    duration: params.duration,
  })
  return { audio: res.assets.map((a) => ({ type: 'audio' as const, ...a })) }
})

/** 基础节点插件的服务端部分：声明来自 @plein/nodes，执行器在这里 */
const STORYBOARD_SYSTEM = `你是短剧分镜师。把剧本拆成镜头，按 JSON Schema 输出。
每个镜头写清：景别、画面描述、出场的角色、所在场景和画面里的关键道具（characters 字段；给了角色 / 场景 / 道具设定清单时，名字照清单原样写，清单外的不写）、情绪、光影氛围、音效、台词（说话人与台词）、
用于生成分镜图的画面提示词（具体可画：人物外观动作、构图、环境、光线）、用于图生视频的运动提示词（镜头运动与人物动作）。
镜号从 1 开始连续编号，时长以秒计。`

/** 分镜：剧本 → 结构化分镜表（写回参数由节点声明的 applyOutputs 完成） */
const storyboard = defineExecutor(storyboardNode, async (ctx) => {
  const { params, inputs } = ctx
  const script = requireText(inputText(inputs, 'script') ?? '', '剧本（请连入剧本文本）')
  const user = [
    `请拆成大约 ${params.shotCount} 个镜头。`,
    params.prompt.trim() && `补充要求：${params.prompt.trim()}`,
    `<剧本>\n${script}\n</剧本>`,
  ]
    .filter(Boolean)
    .join('\n\n')
  const res = await ctx.providers.call('text.chat', pickModel(ctx, '对话'), {
    messages: [
      { role: 'system', content: STORYBOARD_SYSTEM },
      { role: 'user', content: user },
    ],
    jsonSchema: z.toJSONSchema(StoryboardDraft, { io: 'input' }) as Record<string, unknown>,
  })
  const out = res.outputs[0]
  let value: unknown = out?.type === 'json' ? out.value : undefined
  if (out?.type === 'text') {
    try {
      value = JSON.parse(out.text.replace(/^```(?:json)?\s*|\s*```$/g, ''))
    } catch {
      throw new ProviderError('unknown', '模型没有按格式返回分镜，请重试或换一个模型')
    }
  }
  const parsed = StoryboardDraft.safeParse(value)
  if (!parsed.success)
    throw new ProviderError('unknown', '模型返回的分镜格式不对，请重试或换一个模型')
  return { shots: [{ type: 'json', value: parsed.data }] }
})

/** 资产卡：输出连入的参考图，供下游直接连线使用（道具卡、风格卡同理） */
const character = defineExecutor(characterNode, async ({ inputs }) => ({
  images: inputAssets(inputs, 'references').map((a) => ({ type: 'image' as const, ...a })),
}))
const scene = defineExecutor(sceneNode, async ({ inputs }) => ({
  images: inputAssets(inputs, 'references').map((a) => ({ type: 'image' as const, ...a })),
}))
const prop = defineExecutor(propNode, async ({ inputs }) => ({
  images: inputAssets(inputs, 'references').map((a) => ({ type: 'image' as const, ...a })),
}))
const style = defineExecutor(styleNode, async ({ inputs }) => ({
  images: inputAssets(inputs, 'references').map((a) => ({ type: 'image' as const, ...a })),
}))
const effect = defineExecutor(effectNode, async ({ inputs }) => ({
  videos: inputAssets(inputs, 'references').map((a) => ({ type: 'video' as const, ...a })),
}))

/**
 * 3D 构图：截图由网页渲染后作为节点结果写入，下游直接读结果；
 * 还没截图时没有输出（不报错，实际输入预览里看得到缺这张参考）
 */
const stage = defineExecutor(stageNode, async () => ({ image: [] }))

/** 序列：探测各段时长，排好时间线，交给宿主的 ffmpeg 合成 */
const sequence = defineExecutor(sequenceNode, async (ctx) => {
  const { params, inputs } = ctx
  const arranged = arrangeSequence(params, inputs)
  if (arranged.length === 0) throw new ProviderError('invalid_input', '没有连入镜头视频')
  const subtitleProblem = subtitleExportProblem(params, arranged)
  if (subtitleProblem)
    throw new ProviderError('invalid_input', subtitleProblem, { retryable: false })
  ctx.progress(0, '读取素材…')
  const [clips, dialogue, more] = await Promise.all([
    Promise.all(arranged.map((c) => ctx.media.probe(c.clip))),
    Promise.all(arranged.map(async (c) => (c.dialogue ? ctx.media.probe(c.dialogue) : undefined))),
    Promise.all(arranged.map((c) => Promise.all(c.more.map((m) => ctx.media.probe(m))))),
  ])
  const spec = sequenceSpec(
    params,
    arranged,
    {
      clips: clips.map((i) => i.duration ?? 0),
      dialogue: dialogue.map((i) => i?.duration),
      more: more.map((list) => list.map((i) => i.duration)),
    },
    inputs.music,
    undefined,
  )
  if (spec.clips.length === 0)
    throw new ProviderError('invalid_input', '各段时长都是 0，检查入点和出点')
  // 烧字幕要 libass；缺了就在合成前说清楚，别等 ffmpeg 报一句看不懂的滤镜错误。
  // 本机缺能力是长期状态，重试没有意义，标成不可重试。
  // 完全没有 ffmpeg 时不是缺 libass 的问题，交给合成本身报错
  const caps = await mediaCaps()
  if (spec.subtitles?.cues.length && caps.ffmpeg && !caps.subtitles)
    throw new ProviderError('unavailable', missingCapability('subtitles'), { retryable: false })
  ctx.progress(0, '合成中…')
  const out = await ctx.media.compose(spec)
  return { video: [{ type: 'video', ...out }] }
})

export const coreServerPlugin = defineServerPlugin(corePlugin, {
  executors: [
    text,
    llm,
    image,
    imageEdit,
    imageProcess,
    video,
    speech,
    music,
    sfx,
    transcription,
    character,
    scene,
    prop,
    style,
    effect,
    storyboard,
    sequence,
    animaticExecutor,
    stage,
  ],
})
