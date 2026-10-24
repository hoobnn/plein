import { z } from 'zod'

/**
 * 我的音色：在平台上复刻出来、或从平台控制台登记进来的音色。
 * 音色只能在同一家平台的配音模型里用，引用时仍是 `{ provider, voiceId }`；
 * 这里多记名字、性别年龄、样本和训练状态，供资产库管理和音色下拉使用。
 */
export const VoiceStatus = z.enum(['training', 'ready', 'failed'])
export type VoiceStatus = z.infer<typeof VoiceStatus>

const voiceName = z.string().trim().min(1).max(40)
const gender = z.enum(['female', 'male']).nullable()
const age = z.enum(['young', 'mature']).nullable()

/**
 * 新建：带样本就在平台上复刻（计费）；不带样本只登记平台上已有的音色 ID，不调用平台。
 * voiceId 在平台要求预先开通槽位（如豆包的 S_ ID）或登记已有音色时必填，否则由服务端生成
 */
export const CreateVoice = z
  .object({
    provider: z.string().trim().min(1).max(100),
    name: voiceName,
    voiceId: z.string().trim().max(200).default(''),
    sampleAssetId: z
      .string()
      .regex(/^[0-9a-f]{64}$/, '资产 id 不合法')
      .nullable()
      .default(null),
    gender: gender.default(null),
    age: age.default(null),
  })
  .refine((v) => v.sampleAssetId || v.voiceId, {
    message: '登记已有音色需要填写音色 ID',
    path: ['voiceId'],
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
  createdAt: number
  updatedAt: number
}
