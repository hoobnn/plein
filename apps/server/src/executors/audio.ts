import { sfxNode, transcribeNode, type VoiceRef } from '@plein/nodes'
import {
  defineExecutor,
  inputAssets,
  inputText,
  ProviderError,
  parseModelRef,
  type ModelSpec,
  type TranscriptSegment,
} from '@plein/plugin-sdk'
import { z } from 'zod'
import {
  arkPlanProvider,
  arkProvider,
  bailianProvider,
  doubaoProvider,
  minimaxProvider,
  mockProvider,
  openaiProvider,
} from '@plein/providers'

const PROVIDER_TITLES = new Map(
  [
    arkPlanProvider,
    arkProvider,
    bailianProvider,
    doubaoProvider,
    minimaxProvider,
    mockProvider,
    openaiProvider,
  ].map((provider) => [provider.id, provider.title]),
)

/** 优先使用当前注册表中的平台名；独立执行器没有注册表时使用内置平台声明。 */
export function speechProviderTitle(
  provider: string,
  registryTitle?: (id: string) => string | undefined,
) {
  return registryTitle?.(provider) ?? PROVIDER_TITLES.get(provider) ?? '其他平台'
}

/** 与声音复刻平台一致的音色 ID 判定；预置音色不能误当成已创建的音色。 */
function createdVoiceId(value: string) {
  return (
    /^[A-Za-z][A-Za-z0-9_-]{6,254}[A-Za-z0-9]$/.test(value) &&
    !/^((?:S_|ICL_|MIX_|DiT_|BV)|[a-z]{2}_|(?:wvae|moon|mercury|venus|earth|mars|jupiter|saturn|uranus|neptune|pluto|umm)_)/i.test(
      value,
    ) &&
    !/_(?:bigtts|bigtts_cc|tob|cs_tob|streaming)$/i.test(value)
  )
}

/** 预检与执行共用音色的平台约束；旧音色仍允许使用，但先说明无法校验。 */
export function speechVoice(
  model: string,
  voice: VoiceRef,
  options: {
    spec?: ModelSpec
    providerTitle?: (provider: string) => string | undefined
  } = {},
) {
  const parsed = parseModelRef(model)
  const provider = parsed?.provider ?? ''
  if (voice.voiceId && voice.provider && provider && voice.provider !== provider)
    return {
      problem: `音色 ${voice.voiceId} 属于 ${speechProviderTitle(voice.provider, options.providerTitle)}，当前配音模型是 ${speechProviderTitle(provider, options.providerTitle)} 的，请换成同一平台的音色或模型`,
    }
  if (parsed?.model.startsWith('seed-icl-')) {
    const title =
      options.spec?.title ??
      doubaoProvider.models.find((spec) => spec.id === parsed.model)?.title ??
      '当前声音复刻模型'
    // 预检拿不到平台设置里的默认音色；留空时不能等适配器选中预置默认值后才报错。
    if (!voice.voiceId) return { problem: `${title} 需要选择已创建的复刻或设计音色` }
    const cloned = voice.voiceId.startsWith('S_') || createdVoiceId(voice.voiceId)
    if (!cloned)
      return {
        problem: `${title} 只能用已创建的复刻或设计音色，当前是预置音色 ${voice.voiceId}`,
      }
  }
  if (voice.voiceId && !voice.provider)
    return { notice: `音色 ${voice.voiceId} 未标明所属平台，请确认它适用于当前模型` }
  return {}
}

const SPEECH_EMOTIONS: Record<string, string> = {
  happy: 'happy',
  高兴: 'happy',
  sad: 'sad',
  悲伤: 'sad',
  angry: 'angry',
  愤怒: 'angry',
  fearful: 'fearful',
  害怕: 'fearful',
  disgusted: 'disgusted',
  厌恶: 'disgusted',
  surprised: 'surprised',
  惊讶: 'surprised',
  calm: 'calm',
  平静: 'calm',
}

/** 不支持自由语气的模型不能静默丢弃指令；MiniMax 只接受官方标签的精确映射。 */
export function speechDirection(
  model: string,
  instruction: string,
  options: Record<string, unknown>,
  spec?: ModelSpec,
) {
  const text = instruction.trim()
  if (!text || spec?.limits?.instruction !== false)
    return { instruction: text || undefined, extra: options }
  const emotion = Object.hasOwn(SPEECH_EMOTIONS, text) ? SPEECH_EMOTIONS[text] : undefined
  if (parseModelRef(model)?.provider === 'minimax/api' && emotion) {
    const override = options.emotion
    if (
      override !== undefined &&
      override !== '' &&
      (typeof override !== 'string' || !Object.values(SPEECH_EMOTIONS).includes(override))
    )
      throw new ProviderError('invalid_input', '当前配音模型的 emotion 需要选择官方情绪值')
    return { instruction: undefined, extra: { ...options, emotion: override || emotion } }
  }
  throw new ProviderError(
    'invalid_input',
    '当前配音模型不支持这段语气指令，请换用支持自由语气的模型；MiniMax 仅支持高兴、悲伤、愤怒、害怕、厌恶、惊讶、平静等精确情绪标签',
  )
}

export const sfx = defineExecutor(sfxNode, async (ctx) => {
  const prompt = [ctx.params.prompt.trim(), inputText(ctx.inputs, 'prompt')?.trim()]
    .filter(Boolean)
    .join('\n\n')
  if (!prompt) throw new ProviderError('invalid_input', '音效描述为空')
  if (!ctx.params.model) throw new ProviderError('invalid_input', '还没选音效模型')
  const res = await ctx.providers.call('audio.sfx', ctx.params.model, {
    prompt,
    duration: ctx.params.duration,
  })
  return {
    audio: res.assets
      .filter((a) => a.kind === 'audio')
      .map((a) => ({ type: 'audio' as const, ...a })),
  }
})

const SegmentList = z.array(
  z
    .object({
      start: z.number().finite().min(0),
      end: z.number().finite().min(0),
      text: z.string(),
    })
    .refine((s) => s.end > s.start, '分句结束时间必须晚于开始时间'),
)

export const transcription = defineExecutor(transcribeNode, async (ctx) => {
  const audio = inputAssets(ctx.inputs, 'audio').filter((a) => a.kind === 'audio')
  if (audio.length !== 1) throw new ProviderError('invalid_input', '语音识别需要连入一段音频')
  if (!ctx.params.model) throw new ProviderError('invalid_input', '还没选语音识别模型')
  const res = await ctx.providers.call('audio.transcribe', ctx.params.model, {
    audio: audio[0]!,
    ...(ctx.params.language.trim() ? { language: ctx.params.language.trim() } : {}),
  })
  const segments: TranscriptSegment[] = []
  for (const out of res.outputs) {
    if (out.type !== 'json' || !out.value || typeof out.value !== 'object') continue
    const raw = (out.value as { segments?: unknown }).segments
    if (raw === undefined) continue
    const parsed = SegmentList.safeParse(raw)
    if (!parsed.success) throw new ProviderError('unknown', '平台返回的语音识别时间戳无效')
    segments.push(...parsed.data)
  }
  const text =
    res.outputs
      .flatMap((out) => (out.type === 'text' ? [out.text] : []))
      .join('\n')
      .trim() || segments.map((s) => s.text).join('\n')
  if (!text) throw new ProviderError('unknown', '平台没有返回识别文字')
  return {
    text: [{ type: 'text', text }],
    segments: [{ type: 'json', value: { segments } }],
  }
})
