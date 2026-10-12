import {
  corePlugin,
  imageNode,
  llmNode,
  musicNode,
  speechNode,
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
  const res = await ctx.providers.call('audio.speech', pickModel(ctx, 'audio.speech', '配音'), {
    text: requireText(joinText(params.text, inputText(inputs, 'text')), '台词'),
    voice: params.voice || undefined,
    instruction: params.instruction || undefined,
  })
  return { audio: res.assets.map((a) => ({ type: 'audio' as const, ...a })) }
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
export const coreServerPlugin = defineServerPlugin(corePlugin, {
  executors: [text, llm, image, video, speech, music],
})
