import { z } from 'zod'

/**
 * 我的音色：在平台上设计、复刻，或登记已有的音色。
 * 音色只能在同一家平台的配音模型里用，引用时仍是 `{ provider, voiceId }`；
 * 这里多记名字、性别年龄、样本和训练状态，供资产库管理和音色下拉使用。
 */
export const VoiceStatus = z.enum(['training', 'ready', 'failed'])
export type VoiceStatus = z.infer<typeof VoiceStatus>

const voiceName = z.string().trim().min(1).max(40)
const gender = z.enum(['female', 'male']).nullable()
const age = z.enum(['young', 'mature']).nullable()

/**
 * 新建：mode 明确区分设计、复刻、登记。旧客户端不传 mode 时，仍按有无样本兼容复刻和登记。
 * voiceId 在平台要求预先开通槽位（如豆包的 S_ ID）或登记已有音色时必填，否则由服务端生成
 */
export const CreateVoice = z
  .object({
    mode: z.enum(['clone', 'design', 'register']).optional(),
    idMode: z.enum(['slot', 'custom']).default('slot'),
    prompt: z.string().trim().max(2000).default(''),
    previewText: z.string().trim().max(1000).default(''),
    imageAssetId: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable()
      .default(null),
    promptSampleAssetId: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable()
      .default(null),
    promptText: z.string().trim().max(1000).default(''),
    noiseReduction: z.boolean().default(false),
    volumeNormalization: z.boolean().default(false),
    language: z.enum(['zh', 'en']).default('zh'),
    provider: z.string().trim().min(1).max(100),
    name: voiceName,
    voiceId: z.string().trim().max(256).default(''),
    sampleAssetId: z
      .string()
      .regex(/^[0-9a-f]{64}$/, '资产 id 不合法')
      .nullable()
      .default(null),
    gender: gender.default(null),
    age: age.default(null),
  })
  .superRefine((v, ctx) => {
    const mode = v.mode ?? (v.sampleAssetId ? 'clone' : 'register')
    const fail = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message })
    if (mode === 'register' && !v.voiceId) fail('voiceId', '登记已有音色需要填写音色 ID')
    if (mode === 'clone' && !v.sampleAssetId) fail('sampleAssetId', '声音复刻需要上传样本')
    if (mode === 'design' && !v.prompt && !v.imageAssetId)
      fail('prompt', '音色设计需要文字描述或角色图片')
    if (mode === 'design' && !v.previewText) fail('previewText', '音色设计需要试听文本')
    if (mode !== 'clone' && (v.sampleAssetId || v.promptSampleAssetId))
      fail('sampleAssetId', '只有声音复刻可以提交音频样本')
    if (mode !== 'design' && (v.prompt || v.imageAssetId))
      fail('prompt', '只有音色设计可以提交音色描述或图片')
    if (mode === 'clone' && !!v.promptSampleAssetId !== !!v.promptText)
      fail('promptText', '增强参考音频和对应文字须同时填写')
  })
export type CreateVoice = z.input<typeof CreateVoice>

export const UpdateVoice = z.object({ name: voiceName, gender, age }).partial()
export type UpdateVoice = z.infer<typeof UpdateVoice>

export interface Voice {
  id: string
  provider: string
  voiceId: string
  name: string
  status: VoiceStatus
  /** 训练失败或最近一次查询状态出错的原因 */
  message: string | null
  /** 复刻用的样本；登记的已有音色没有 */
  sampleAssetId: string | null
  gender: 'female' | 'male' | null
  age: 'young' | 'mature' | null
  source?: 'clone' | 'design' | 'register'
  previewAssetId?: string | null
  /** 创建时使用的密钥组及密钥指纹；旧音色没有记录时用当前组查询训练状态 */
  credentialId?: string | null
  credentialFingerprint?: string | null
  createdAt: number
  updatedAt: number
}
