import type { PluginManifest } from '@plein/plugin-sdk'
import { z } from 'zod'

// 插件目录本身是插件公开 API 的一部分，放在 plugin-sdk；
// 这里转出去，前后端仍从 @plein/protocol 引入即可。
export type {
  Catalog,
  CatalogModel,
  PluginInfo,
  ProviderInfo,
  RemoteModelsStatus,
} from '@plein/plugin-sdk'

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
 * 服务端拉取远端模型列表的信号超时；前端轮询窗口按它推导（留余量），
 * 改这里即可同时调整两侧
 */
export const REMOTE_MODELS_PULL_TIMEOUT_MS = 30_000

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
