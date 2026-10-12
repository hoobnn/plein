import {
  characterNode,
  corePlugin,
  imageNode,
  llmNode,
  musicNode,
  sceneNode,
  arrangeSequence,
  sequenceNode,
  sequenceSpec,
  speechNode,
  StoryboardDraft,
  storyboardNode,
  textNode,
  videoNode,
} from '@plein/nodes'
import {
  type Capability,
  type ChatMessage,
  defineExecutor,
  defineServerPlugin,
  type ExecutorContext,
  inputAssets,
  inputText,
  ProviderError,
} from '@plein/plugin-sdk'
import { z } from 'zod'

/** 参数里没选模型时，用已启用平台中第一个支持该能力的模型 */
function pickModel(ctx: ExecutorContext<{ model: string }>, capability: Capability, label: string) {
  if (ctx.params.model) return ctx.params.model
  const first = ctx.providers.models(capability)[0]
  if (!first)
    throw new ProviderError('unavailable', `没有启用支持「${label}」的平台，请先在设置里启用`)
  return first.ref
}

/** 参数里的文本与上游文本合并：两者都有时参数在前 */
function joinText(own: string, upstream: string | undefined) {
  return [own.trim(), upstream?.trim()].filter(Boolean).join('\n\n')
}

function requireText(text: string, label: string) {
  if (!text) throw new ProviderError('invalid_input', `${label}为空`)
  return text
}

const text = defineExecutor(textNode, async ({ params }) => ({
  text: [{ type: 'text', text: params.text }],
}))

const llm = defineExecutor(llmNode, async (ctx) => {
  const { params, inputs } = ctx
  const prompt = requireText(joinText(params.prompt, inputText(inputs, 'prompt')), '提示词')
  const images = inputAssets(inputs, 'images')
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
  const res = await ctx.providers.call('text.chat', pickModel(ctx, 'text.chat', '对话'), {
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
  const res = await ctx.providers.call(
    'image.generate',
    pickModel(ctx, 'image.generate', '生成图片'),
    {
      prompt: requireText(joinText(params.prompt, inputText(inputs, 'prompt')), '提示词'),
      references: inputAssets(inputs, 'references'),
      count: params.count,
      seed: params.seed,
      extra: { aspectRatio: params.aspectRatio },
    },
  )
  return { images: res.assets.map((a) => ({ type: 'image' as const, ...a })) }
})

const video = defineExecutor(videoNode, async (ctx) => {
  const { params, inputs } = ctx
  const res = await ctx.providers.call(
    'video.generate',
    pickModel(ctx, 'video.generate', '生成视频'),
    {
      prompt: requireText(joinText(params.prompt, inputText(inputs, 'prompt')), '提示词'),
      firstFrame: inputAssets(inputs, 'firstFrame')[0],
      lastFrame: inputAssets(inputs, 'lastFrame')[0],
      duration: params.duration,
      aspectRatio: params.aspectRatio,
      seed: params.seed,
    },
  )
  return { video: res.assets.map((a) => ({ type: 'video' as const, ...a })) }
})

const speech = defineExecutor(speechNode, async (ctx) => {
  const { params, inputs } = ctx
  const text = requireText(joinText(params.text, inputText(inputs, 'text')), '台词')
  const res = await ctx.providers.call('audio.speech', pickModel(ctx, 'audio.speech', '配音'), {
    text,
    voice: params.voice || undefined,
    instruction: params.instruction || undefined,
  })
  // 台词随语音一起往下游传，序列导出时用作字幕
  return { audio: res.assets.map((a) => ({ type: 'audio' as const, ...a, caption: text })) }
})

const music = defineExecutor(musicNode, async (ctx) => {
  const { params, inputs } = ctx
  const res = await ctx.providers.call('audio.music', pickModel(ctx, 'audio.music', '配乐'), {
    prompt: requireText(joinText(params.prompt, inputText(inputs, 'prompt')), '描述'),
    duration: params.duration,
  })
  return { audio: res.assets.map((a) => ({ type: 'audio' as const, ...a })) }
})

/** 基础节点插件的服务端部分：声明来自 @plein/nodes，执行器在这里 */
const STORYBOARD_SYSTEM = `你是短剧分镜师。把剧本拆成镜头，按 JSON Schema 输出。
每个镜头写清：景别、画面描述、出场角色或场景的名字（与剧本里的名字一致）、情绪、光影氛围、音效、台词（说话人与台词）、
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
  const res = await ctx.providers.call('text.chat', pickModel(ctx, 'text.chat', '对话'), {
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

/** 资产卡：输出连入的参考图，供下游直接连线使用 */
const character = defineExecutor(characterNode, async ({ inputs }) => ({
  images: inputAssets(inputs, 'references').map((a) => ({ type: 'image' as const, ...a })),
}))
const scene = defineExecutor(sceneNode, async ({ inputs }) => ({
  images: inputAssets(inputs, 'references').map((a) => ({ type: 'image' as const, ...a })),
}))

/** 序列：探测各段时长，排好时间线，交给宿主的 ffmpeg 合成 */
const sequence = defineExecutor(sequenceNode, async (ctx) => {
  const { params, inputs } = ctx
  const arranged = arrangeSequence(params, inputs)
  if (arranged.length === 0) throw new ProviderError('invalid_input', '没有连入镜头视频')
  ctx.progress(0, '读取素材…')
  const [clips, dialogue] = await Promise.all([
    Promise.all(arranged.map((c) => ctx.media.probe(c.clip))),
    Promise.all(arranged.map((c) => (c.dialogue ? ctx.media.probe(c.dialogue) : undefined))),
  ])
  const spec = sequenceSpec(
    params,
    arranged,
    { clips: clips.map((i) => i.duration ?? 0), dialogue: dialogue.map((i) => i?.duration) },
    inputs.music,
  )
  if (spec.clips.length === 0)
    throw new ProviderError('invalid_input', '各段时长都是 0，检查入点和出点')
  ctx.progress(0, '合成中…')
  const out = await ctx.media.compose(spec)
  return { video: [{ type: 'video', ...out }] }
})

export const coreServerPlugin = defineServerPlugin(corePlugin, {
  executors: [text, llm, image, video, speech, music, character, scene, storyboard, sequence],
})
