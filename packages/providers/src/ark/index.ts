import { createArkAdapter, createArkPlanAdapter, models as arkModels } from 'modelbay/ark'
import { nodeOptions, referenceStorageHost } from 'modelbay/ark/node'
import type { PlatformAdapter } from 'modelbay'
import {
  definePlugin,
  type ModelSpec,
  defineServerPlugin,
  PLUGIN_API_VERSION,
  ProviderError,
} from '@plein/plugin-sdk'
import { z } from 'zod'
import { adapterToProvider, toAdapterContext } from '../bridge'
import { speechSettings } from '../doubao'

const NETWORK = ['*.volces.com', '*.byteimg.com', '*.ibytedtos.com', '*.byteicdn.com']
/** plein 存量的参考视频对象前缀；生命周期策略按它配置。 */
const REFERENCE_KEY_PREFIX = 'plein/video-references'

const settings = z.object({
  referenceStorage: z
    .enum(['tos', 'oss', 'cos', 's3'])
    .default('tos')
    .meta({
      title: '视频参考存储',
      description: '仅本地参考视频需要；图片和音频参考直接随请求发送',
      labels: {
        tos: '火山引擎 TOS',
        oss: '阿里云 OSS',
        cos: '腾讯云 COS',
        s3: '自建 S3 兼容（RustFS / MinIO / SeaweedFS 等）',
      },
    }),
  referenceEndpoint: z.string().default('').meta({
    title: 'S3 兼容地址',
    description:
      '仅「自建 S3 兼容」填写，须为方舟能从公网访问的 https 地址，如 https://s3.example.com:9000',
  }),
  referencePathStyle: z.boolean().default(false).meta({
    title: '路径式访问',
    description: '仅「自建 S3 兼容」生效：桶名放在路径而不是域名里，RustFS / MinIO 通常需要开启',
  }),
  referenceBucket: z.string().default('').meta({
    title: '视频参考存储桶',
    description: '私有桶；上传至 plein/video-references/，建议为此前缀配置生命周期清理',
  }),
  referenceRegion: z.string().default('cn-beijing').meta({
    title: '视频参考存储地域',
    description:
      'TOS 如 cn-beijing；OSS 如 cn-hangzhou；COS 如 ap-guangzhou；自建服务一般为 us-east-1',
  }),
  customChatModel: z.string().default('').meta({ title: '自定义对话模型 / Endpoint ID' }),
  customImageModel: z.string().default('').meta({ title: '自定义图片模型 / Endpoint ID' }),
  customVideoModel: z.string().default('').meta({ title: '自定义视频模型 / Endpoint ID' }),
})
const planSettings = settings.extend(speechSettings.shape)

/** 给适配器注入 plein 的参考视频对象前缀（settings 表单不暴露这一项）。 */
function withKeyPrefix(adapter: PlatformAdapter): PlatformAdapter {
  const inject = <C extends { settings?: Record<string, unknown> }>(ctx: C): C => ({
    ...ctx,
    settings: { referenceKeyPrefix: REFERENCE_KEY_PREFIX, ...ctx.settings },
  })
  return {
    ...adapter,
    submit: (req, ctx) => adapter.submit(req, inject(ctx)),
    ...(adapter.native
      ? { native: (op, params, ctx) => adapter.native!(op, params, inject(ctx)) }
      : {}),
  }
}

const apiAdapter = withKeyPrefix(createArkAdapter(arkModels, nodeOptions))
const planAdapter = withKeyPrefix(createArkPlanAdapter(arkModels, nodeOptions))

// 套餐的图片、视频模型沿用按量模型 ID（画布节点换平台不用改模型参数）；
// 请求时由 modelbay 适配器换成套餐模型名。对话、语音的 ID 两边本来一致。
const PLAN_MEDIA_IDS = new Map(
  arkModels.flatMap((declaration) => {
    const api = declaration.channels.find((item) => item.channel === 'ark')
    const plan = declaration.channels.find((item) => item.channel === 'ark-plan')
    const media = declaration.capabilities.some(
      (capability) => capability === 'image.generate' || capability === 'video.generate',
    )
    return api && plan && media ? [[plan.id, api.id] as const] : []
  }),
)

/**
 * 套餐图片 / 视频的模型 id 换回按量 id（宿主语义：画布节点换平台不用改模型参数）。
 * 套餐文本只给内置 Agent、套餐视频不支持草稿，这两项来自 modelbay 声明。
 */
function planModel(spec: ModelSpec): ModelSpec {
  const id = PLAN_MEDIA_IDS.get(spec.id)
  return id ? { ...spec, id } : spec
}

// 沿用 TOS 时期的密钥名，已有配置不用重填；S3 兼容存储也用这一对
const TOS_SECRETS = [
  { name: 'ARK_TOS_ACCESS_KEY', title: '存储 Access Key（视频参考）' },
  { name: 'ARK_TOS_SECRET_KEY', title: '存储 Secret Key（视频参考）' },
]

const PLAN_DIRECTORY_SECRETS = [
  {
    name: 'ARK_PLAN_ACCESS_KEY',
    title: '模型目录 Access Key（可选）',
    help: '自动获取套餐模型时使用，不用于生成或视频参考存储',
  },
  { name: 'ARK_PLAN_SECRET_KEY', title: '模型目录 Secret Key（可选）' },
]

export const arkProvider = adapterToProvider(apiAdapter, {
  id: 'volc/ark',
  channel: 'ark',
  description: 'Doubao Seed 对话、Seedream 图片及 Seedance 视频；支持自定义模型 / Endpoint ID',
  settings,
  secrets: [{ name: 'ARK_API_KEY', title: '火山方舟 API Key', required: true }, ...TOS_SECRETS],
  // 列表是否含图片 / 视频模型未能在官方文档确证，先只覆盖对话
  remoteModelsScope: ['text.chat'],
  listRemoteModels: async (ctx) =>
    (await apiAdapter.native!('listModels', {}, toAdapterContext(ctx))) as never,
  // 只查任务列表，不触发生成计费
  test: async (ctx) => {
    await apiAdapter.native!('listTasks', {}, toAdapterContext(ctx))
  },
})

export const arkPlanProvider = adapterToProvider(planAdapter, {
  id: 'volc/ark-plan',
  channel: 'ark-plan',
  // 套餐的文档入口是套餐概览页；适配器的 docsUrl 指向按量的模型列表
  docsUrl: 'https://docs.volcengine.com/docs/ark/agent-plan-personal-plan-overview?lang=zh',
  adjustModel: planModel,
  description:
    '套餐内置 Agent 对话、Seedream 图片、Seedance 视频、语音合成与识别；模型目录查询可选配 AK/SK',
  settings: planSettings,
  secrets: [
    { name: 'ARK_AGENT_PLAN_API_KEY', title: 'Agent Plan 专属 API Key', required: true },
    ...PLAN_DIRECTORY_SECRETS,
    ...TOS_SECRETS,
  ],
  remoteModelsScope: ['text.chat'],
  listRemoteModels: async (ctx) =>
    (await planAdapter.native!('listModels', {}, toAdapterContext(ctx))) as never,
  test: async (ctx) => {
    await planAdapter.native!('listTasks', {}, toAdapterContext(ctx))
  },
  // 宿主策略：套餐文本模型只给内置 Agent
  beforeSubmit(req) {
    if (req.capability === 'text.chat' && req.usage !== 'agent')
      throw new ProviderError('invalid_input', '套餐文本模型仅供 Plein 内置 Agent 使用')
  },
})

export { referenceStorageHost }

export const arkPlugin = defineServerPlugin(
  definePlugin({
    manifest: {
      id: 'volc/ark',
      version: '0.1.0',
      name: '火山方舟',
      engines: { plein: `^${PLUGIN_API_VERSION}` },
      contributes: { providers: ['volc/ark'] },
      permissions: {
        network: NETWORK,
        secrets: ['ARK_API_KEY', 'ARK_TOS_ACCESS_KEY', 'ARK_TOS_SECRET_KEY'],
        assets: 'read',
      },
    },
  }),
  { providers: [arkProvider] },
)

export const arkPlanPlugin = defineServerPlugin(
  definePlugin({
    manifest: {
      id: 'volc/ark-plan',
      version: '0.1.0',
      name: '火山方舟 Agent Plan',
      engines: { plein: `^${PLUGIN_API_VERSION}` },
      contributes: { providers: ['volc/ark-plan'] },
      permissions: {
        network: [...NETWORK, 'openspeech.bytedance.com', 'ark.cn-beijing.volcengineapi.com'],
        secrets: [
          'ARK_AGENT_PLAN_API_KEY',
          'ARK_TOS_ACCESS_KEY',
          'ARK_TOS_SECRET_KEY',
          ...PLAN_DIRECTORY_SECRETS.map((s) => s.name),
        ],
        assets: 'read',
      },
    },
  }),
  { providers: [arkPlanProvider] },
)
