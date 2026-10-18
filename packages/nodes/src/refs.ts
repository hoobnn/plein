import { z } from 'zod'

/**
 * 资产引用与音色的公共约定（前后端共用）。
 *
 * 规则：引用以稳定 ID 为准，名字只用于展示。
 * 角色卡上的音色绑定为 `{ provider, voiceId }`：各家复刻 / 设计的音色只能在同一家 TTS 里用，
 * 换平台必须重新选，不能把一个平台的音色 ID 塞给另一个平台。
 */

/** 音色引用：属于哪个平台、用哪个音色 ID */
export const VoiceRef = z.object({
  /** Provider id，形如 `vendor/name`；空字符串表示「未指定平台」，只作展示与手动填写 */
  provider: z.string().trim().default(''),
  voiceId: z.string().trim().default(''),
})
export type VoiceRef = z.infer<typeof VoiceRef>

/** 空的音色引用 */
export const noVoice: VoiceRef = { provider: '', voiceId: '' }

/** 有没有选中音色 */
export const hasVoice = (v: unknown): v is VoiceRef =>
  typeof v === 'object' && v !== null && String((v as VoiceRef).voiceId ?? '').trim() !== ''

/**
 * 从任意历史取值里读出音色引用。
 * 0.1.0 之前音色是裸字符串（`voice: 'S_xxx'`），迁移后按「未指定平台」处理：
 * 仍然能用，但不能跨平台自动沿用，用户在卡片上确认一次即可。
 */
export function voiceOf(params: unknown): VoiceRef {
  const raw = (params as { voice?: unknown } | null | undefined)?.voice
  if (typeof raw === 'string') return { provider: '', voiceId: raw.trim() }
  const parsed = VoiceRef.safeParse(raw)
  return parsed.success ? parsed.data : noVoice
}

/**
 * 音色能不能用于某个平台的模型。
 * 未指定平台的旧音色无法判断，不在这里拦截（卡片与配音节点会提示确认）。
 */
export const voiceFitsProvider = (v: VoiceRef, provider: string) =>
  hasVoice(v) && v.provider !== '' && provider !== '' && v.provider === provider
