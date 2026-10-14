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
  secrets: Record<string, boolean>
}

export const ProviderConfigUpdate = z.object({
  enabled: z.boolean().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  /** 值为 null 或空串表示删除 */
  secrets: z.record(z.string(), z.string().nullable()).optional(),
})
export type ProviderConfigUpdate = z.infer<typeof ProviderConfigUpdate>

export interface ProviderTestResult {
  ok: boolean
  code?: string
  message?: string
}
