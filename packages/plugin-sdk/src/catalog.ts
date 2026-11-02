import type { PromptPresetDefinition, TemplateDefinition } from './contributions'
import type { PluginManifest } from './manifest'
import type { NodeDescriptor } from './node'
import type { ModelInfo, ProviderDescriptor } from './provider'

/**
 * 插件目录：已安装插件提供的全部能力。
 * 放在 plugin-sdk 是因为它就是插件公开 API 的一部分——前端、服务端、能力层
 * 都要读同一份目录，不该让能力层反过来依赖接口协议包。
 */

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
}
// 元素类型未进目录：插件可以声明，但宿主还渲染不了（沙箱方案未落地），
// 目录里不保留没有消费者的字段；能上屏时再加回。
