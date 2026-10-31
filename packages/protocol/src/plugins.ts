import {
  type ElementTypeDefinition,
  type ModelInfo,
  type NodeDescriptor,
  type PluginManifest,
  type ProviderDescriptor,
  type PromptPresetDefinition,
  type TemplateDefinition,
} from '@plein/plugin-sdk'
import { z } from 'zod'

export interface PluginInfo {
  id: string
  name: string
  version: string
  description?: string
  builtin: boolean
  status: 'active' | 'error'
  error?: string
  contributes: PluginManifest['contributes']
  permissions: PluginManifest['permissions']
}

/**
 * 本机第三方插件（数据目录 plugins/ 下的文件夹）：默认不启用，设置里看过权限后再打开。
 * sandbox 是子进程里实际生效的隔离，按实测如实显示
 */
export interface LocalPluginInfo {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  /** 插件所在文件夹 */
  dir: string
  enabled: boolean
  /** disabled 没启用；active 已加载；error 清单不对、加载失败或进程反复崩溃 */
  status: 'disabled' | 'active' | 'error'
  error?: string
  permissions?: PluginManifest['permissions']
  contributes?: PluginManifest['contributes']
  sandbox?: { permission: boolean; fsWrite: boolean; net: boolean }
}

export const LocalPluginUpdate = z.object({ enabled: z.boolean() })

/**
 * 目录里的模型条目：内置条目可能带远端状态；远端列表新发现的以通用能力追加。
 * remote-only 模型参数为通用默认，提交是否被平台接受以内置目录收录为准
 */
export interface CatalogModel extends ModelInfo {
  /** 相对最近一次远端列表：available 接口返回里有；unlisted 没返回（可能下线或无权限） */
  remote?: 'available' | 'unlisted'
  /** 远端列表返回但内置目录没有：按 id 推断的通用能力条目 */
  remoteOnly?: boolean
}

/** 远端模型列表的拉取状态，供设置页显示上次刷新时间与失败原因 */
export interface RemoteModelsStatus {
  /** 最近一次成功或失败的拉取时间；从未拉取为 null */
  fetchedAt: number | null
  /** 24 小时内且密钥未换为 fresh；过期为 stale；从未拉取或密钥已换为 idle */
  status: 'fresh' | 'stale' | 'idle'
  /** 最近一次拉取的失败原因；成功拉取后不给 */
  error?: string
}

export interface ProviderInfo extends Omit<ProviderDescriptor, 'models'> {
  models: CatalogModel[]
  enabled: boolean
  /** 必填密钥是否都已填写 */
  configured: boolean
  /** 平台保存的密钥组数 */
  credentialCount: number
  /** 多组密钥时当前组的标签，摘要用；一组或还没选时不给 */
  activeCredentialLabel?: string
  /** 远端模型列表状态；实现了拉取的平台才有，目录 models 已按它合并 */
  remoteModels?: RemoteModelsStatus
}

/** 已安装插件提供的全部能力，前端据此生成节点菜单、表单和设置页 */
export interface Catalog {
  plugins: PluginInfo[]
  nodes: Array<NodeDescriptor & { executable: boolean }>
  providers: ProviderInfo[]
  /** 各模型能力的默认模型（`平台:模型`），新建节点时写进节点；没有可用模型的能力不列出 */
  defaultModels: Partial<Record<string, string>>
  templates: Array<TemplateDefinition & { plugin: string }>
  prompts: Array<PromptPresetDefinition & { plugin: string }>
  elements: Array<
    Pick<ElementTypeDefinition, 'type' | 'title' | 'description' | 'defaultSize'> & {
      dataSchema: Record<string, unknown>
      plugin: string
    }
  >
}

/** 平台配置的读取视图：密钥只返回是否已填写 */
export interface ProviderConfigView {
  enabled: boolean
  settings: Record<string, unknown>
  /** 当前组的密钥填写状态 */
  secrets: Record<string, boolean>
  credentials: Array<{
    id: string
    label: string
    secrets: Record<string, boolean>
    /** 已填写密钥的展示掩码（如 sk-••••••a1b2）；老服务端没有这个字段时界面退回纯圆点 */
    secretHints?: Record<string, string>
    configured: boolean
    /** 仍在等平台结果的调用数，以及关联到这组密钥的音色数 */
    usage: { tasks: number; voices: number }
  }>
  activeCredential: string | null
  /** 列表只作候选的平台（如兼容渠道）当前缓存里的远端模型；其它平台不给 */
  remoteModelCandidates?: Array<{ id: string; name?: string }>
  /** 保存触发的后台拉取仍在进行；前端据此显示「拉取中」并轮询到消失为止 */
  remoteModelsPending?: boolean
}

/** 设置某能力的默认模型 */
export const DefaultModelUpdate = z.object({
  capability: z.string().min(1),
  model: z.string().min(1),
})
export type DefaultModelUpdate = z.infer<typeof DefaultModelUpdate>

export const ProviderConfigUpdate = z.object({
  enabled: z.boolean().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  credentials: z
    .object({
      add: z
        .array(
          z.object({
            label: z.string(),
            secrets: z.record(z.string(), z.string()),
          }),
        )
        .optional(),
      update: z
        .array(
          z.object({
            id: z.string(),
            label: z.string().optional(),
            secrets: z.record(z.string(), z.string().nullable()).optional(),
          }),
        )
        .optional(),
      remove: z.array(z.string()).optional(),
    })
    .optional(),
  activeCredential: z.string().optional(),
  /** 值为 null 或空串表示删除；作用于当前组 */
  secrets: z.record(z.string(), z.string().nullable()).optional(),
})
export type ProviderConfigUpdate = z.infer<typeof ProviderConfigUpdate>

export interface ProviderTestResult {
  ok: boolean
  /** 本次检查的类型；即使连接检查成功，也不证明具体模型可用。 */
  scope: 'configuration' | 'connection'
  modelAccess: 'unverified'
  checkedAt: number
  code?: string
  message?: string
}
