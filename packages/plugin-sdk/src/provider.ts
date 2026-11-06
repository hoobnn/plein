/**
 * Provider 协议：公共类型与校验以 modelbay 为单一来源，这里再导出，
 * 保持 plein 各包的导入路径不变。
 * describeProvider / ProviderDescriptor / providerTestScope 供设置页使用，按设计留在 plein。
 */
import { z } from 'zod'
import type {
  Capability,
  ModelInfo,
  ProviderDefinition,
  SecretSpec,
  VoiceCloneSpec,
  VoiceDesignSpec,
} from 'modelbay'

export {
  Capability,
  type CapabilityInput,
  type CapabilityInputs,
  type ChatMessage,
  type ChatTool,
  type ChatToolCall,
  defineProvider,
  type LoadedFile,
  type MediaRequirement,
  type MediaRequirements,
  type ModelFeature,
  type ModelInfo,
  type ModelLimits,
  type ModelSpec,
  type PollResult,
  providerConfigured,
  type ProviderContext,
  type ProviderDefinition,
  ProviderError,
  ProviderErrorCode,
  type ProviderErrorInfo,
  type ProviderOutput,
  type ProviderRequest,
  type ProviderSocket,
  type ProviderUsage,
  type RemoteModel,
  type SecretSpec,
  type SpeechLimits,
  type SubmissionRecord,
  type SubmitResult,
  type TranscriptSegment,
  type VoiceCloneInput,
  type VoiceCloneSpec,
  type VoiceCloneState,
  type VoiceCreationResult,
  type VoiceDesignInput,
  type VoiceDesignSpec,
  type VoicePreset,
} from 'modelbay'

/** Provider 的可序列化描述，供设置页使用 */
export interface ProviderDescriptor {
  id: string
  title: string
  description?: string
  docsUrl?: string
  testScope?: 'connection' | 'configuration'
  /** 是否实现了官方模型列表拉取；设置页据此显示「刷新模型列表」 */
  supportsRemoteModels?: boolean
  /** 列表覆盖的能力；为空表示列表只作设置页候选，不参与合并 */
  remoteModelsScope?: Capability[]
  settingsSchema: Record<string, unknown>
  secrets: SecretSpec[]
  /** 任选一组的鉴权约束：组内密钥需同时填写，组与组之间任选其一 */
  credentialAlternatives?: string[][]
  models: ModelInfo[]
  /** 支持声音复刻时的表单说明 */
  voiceClone?: Pick<
    VoiceCloneSpec<never>,
    'voiceId' | 'hint' | 'customId' | 'promptSample' | 'previewModel' | 'sample'
  >
  voiceDesign?: Omit<VoiceDesignSpec<never>, 'design'>
  plugin: string
}

/** 没有远端 test 实现时只能检查配置，不能因缺省描述而声称验证了连接。 */
export function providerTestScope(def: {
  test?: unknown
  testScope?: 'connection' | 'configuration'
}): 'connection' | 'configuration' {
  return typeof def.test === 'function' && def.testScope !== 'configuration'
    ? 'connection'
    : 'configuration'
}

export function describeProvider(def: ProviderDefinition, plugin: string): ProviderDescriptor {
  return {
    id: def.id,
    title: def.title,
    description: def.description,
    docsUrl: def.docsUrl,
    testScope: providerTestScope(def),
    ...(def.listRemoteModels
      ? { supportsRemoteModels: true, remoteModelsScope: def.remoteModelsScope ?? [] }
      : {}),
    settingsSchema: z.toJSONSchema(def.settings, { io: 'input', unrepresentable: 'any' }) as Record<
      string,
      unknown
    >,
    secrets: def.secrets,
    credentialAlternatives: def.credentialAlternatives,
    models: def.models.map(({ options, ...m }) =>
      options
        ? {
            ...m,
            optionsSchema: z.toJSONSchema(options, {
              io: 'input',
              unrepresentable: 'any',
            }) as Record<string, unknown>,
          }
        : m,
    ),
    ...(def.voiceClone
      ? {
          voiceClone: {
            voiceId: def.voiceClone.voiceId,
            hint: def.voiceClone.hint,
            customId: def.voiceClone.customId,
            promptSample: def.voiceClone.promptSample,
            previewModel: def.voiceClone.previewModel,
            ...(def.voiceClone.sample ? { sample: def.voiceClone.sample } : {}),
          },
        }
      : {}),
    ...(def.voiceDesign
      ? {
          voiceDesign: {
            voiceId: def.voiceDesign.voiceId,
            hint: def.voiceDesign.hint,
            maxPromptLength: def.voiceDesign.maxPromptLength,
            maxPreviewLength: def.voiceDesign.maxPreviewLength,
            image: def.voiceDesign.image,
          },
        }
      : {}),
    plugin,
  }
}
