import {
  type ElementTypeDefinition,
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

export interface ProviderInfo extends ProviderDescriptor {
  enabled: boolean
  /** 必填密钥是否都已填写 */
  configured: boolean
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
    configured: boolean
  }>
  activeCredential: string | null
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
