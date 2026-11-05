import type { AdapterContext, PlatformAdapter } from '@modelbay/core'
import { bailianAdapter, createBailianAdapter } from '@modelbay/bailian'
import { prepareImageEditRequest } from '@modelbay/bailian/image-edit'
import {
  definePlugin,
  defineServerPlugin,
  PLUGIN_API_VERSION,
  ProviderError,
} from '@plein/plugin-sdk'
import { z } from 'zod'
import { adapterModels, adapterToProvider, toAdapterContext } from '../bridge'

// 局部重绘需要蒙版规范化与临时 OSS 上传（依赖 sharp），由宿主在创建适配器时注入。
const base = createBailianAdapter(bailianAdapter.models, { edit: prepareImageEditRequest })

// 适配器会按名依次读取 BAILIAN_API_KEY、域名与轮询覆盖等 MCP / CLI 用的名字；宿主沙箱对未声明
// 的密钥名直接抛错。这里只放行清单声明的密钥，其余按「未设置」返回，让适配器走默认值。
const DECLARED_SECRETS = new Set(['DASHSCOPE_API_KEY'])
const declaredOnly = (ctx: AdapterContext): AdapterContext => ({
  ...ctx,
  secret: (name) => (DECLARED_SECRETS.has(name) ? ctx.secret(name) : undefined),
})
const adapter: PlatformAdapter = {
  ...base,
  submit: (request, ctx) => base.submit(request, declaredOnly(ctx)),
  ...(base.poll ? { poll: (id, ctx) => base.poll!(id, declaredOnly(ctx)) } : {}),
  ...(base.cancel ? { cancel: (id, ctx) => base.cancel!(id, declaredOnly(ctx)) } : {}),
  ...(base.native
    ? { native: (op, params, ctx) => base.native!(op, params, declaredOnly(ctx)) }
    : {}),
}

const settings = z.object({
  region: z
    .enum(['cn-beijing', 'ap-southeast-1', 'us-east-1'])
    .default('cn-beijing')
    .meta({ title: '地域（须与 API Key 一致）' }),
  workspaceId: z
    .string()
    .regex(/^[a-zA-Z0-9-]*$/)
    .default('')
    .meta({ title: '业务空间 ID（留空使用 DashScope 兼容端点）' }),
  voice: z.string().default('Cherry').meta({ title: '默认音色' }),
  language: z.string().default('Auto').meta({ title: '语音语言' }),
  pollIntervalMs: z
    .number()
    .int()
    .min(1000)
    .max(60000)
    .default(10000)
    .meta({ title: '任务轮询间隔（毫秒）' }),
})

// 已下线、仅为旧画布引用保留的模型：宿主标记 deprecated，适配器在发包前拒绝。
const RETIRED = new Set(['qwen3-tts-instruct-flash'])

export const bailianProvider = adapterToProvider(adapter, {
  id: 'aliyun/bailian',
  title: '阿里云百炼',
  description: '千问对话、图像、万相视频和语音合成；连接测试仅检查本地配置，不调用计费模型',
  testScope: 'configuration',
  // 向量、转写等 plein 暂无对应能力的模型（派生后能力为空）不进目录。
  models: adapterModels(adapter, 'bailian')
    .filter((model) => model.capabilities.length > 0)
    .map((model) => (RETIRED.has(model.id) ? { ...model, deprecated: true } : model)),
  settings,
  secrets: [
    {
      name: 'DASHSCOPE_API_KEY',
      title: '百炼 API Key',
      required: true,
      help: '密钥地域须与设置一致；连接测试仅检查是否填写，不验证账户权限或余额',
    },
  ],
  async test(ctx) {
    if (!ctx.secret('DASHSCOPE_API_KEY')?.trim())
      throw new ProviderError('auth', '请配置 DASHSCOPE_API_KEY')
    ctx.log('本地密钥配置已填写；未验证网络、鉴权、模型权限或余额，未调用计费接口')
  },
  // 兼容模式列表以对话模型为主；是否含图片 / 视频模型未在官方文档确证，先只覆盖对话
  remoteModelsScope: ['text.chat'],
  // 地域与业务空间影响列表域名与返回内容，都参与缓存键
  remoteModelsSettings: ['region', 'workspaceId'],
  async listRemoteModels(ctx) {
    const list = await adapter.native!('listModels', {}, toAdapterContext(ctx))
    return (list as Array<{ id: string }>).map((model) => ({
      ...model,
      features: ['structured' as const],
    }))
  },
})

export const bailianPlugin = defineServerPlugin(
  definePlugin({
    manifest: {
      id: 'aliyun/bailian',
      version: '0.1.0',
      name: '阿里云百炼',
      engines: { plein: `^${PLUGIN_API_VERSION}` },
      contributes: { providers: ['aliyun/bailian'] },
      permissions: {
        secrets: ['DASHSCOPE_API_KEY'],
        assets: 'read',
        network: [
          'dashscope.aliyuncs.com',
          'dashscope-intl.aliyuncs.com',
          'dashscope-us.aliyuncs.com',
          '*.cn-beijing.maas.aliyuncs.com',
          '*.ap-southeast-1.maas.aliyuncs.com',
          '*.us-east-1.maas.aliyuncs.com',
          '*.oss-cn-shenzhen.aliyuncs.com',
          '*.oss-cn-beijing.aliyuncs.com',
          '*.oss-cn-shanghai.aliyuncs.com',
          '*.oss-cn-hangzhou.aliyuncs.com',
          '*.oss-ap-southeast-1.aliyuncs.com',
          '*.oss-us-east-1.aliyuncs.com',
          '*.oss-accelerate.aliyuncs.com',
        ],
      },
    },
  }),
  { providers: [bailianProvider] },
)
