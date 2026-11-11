import { bailianAdapter, createBailianAdapter } from 'modelbay/bailian'
import { prepareImageEditRequest } from 'modelbay/bailian/node'
import {
  definePlugin,
  defineServerPlugin,
  PLUGIN_API_VERSION,
  ProviderError,
} from '@plein/plugin-sdk'
import { z } from 'zod'
import { adapterModels, adapterToProvider, toAdapterContext } from '../bridge'

// 局部重绘需要蒙版规范化与临时 OSS 上传（依赖 sharp），由宿主在创建适配器时注入。
const adapter = createBailianAdapter(bailianAdapter.models, { edit: prepareImageEditRequest })

/**
 * modelbay 目录里 plein 宿主跑不通的百炼模型，不进 plein 目录（MCP 侧不受影响）：
 * - `qwen3-asr-flash`：适配器 submit 尚未实现 audio.transcribe；
 * - `wan2.2-s2v`：需要驱动音频 / 人像素材，plein 节点给不出；
 * - `happyhorse-1.0-video-edit`：需要待编辑视频与参考素材，plein 节点给不出；
 * - `cosyvoice-*`、`qwen-audio-*-tts-*`：必须指定系统音色或复刻音色，设置里的默认音色（Cherry）
 *   对它们无效，而 plein 的语音节点只带一个默认音色。
 */
function unsupportedInPlein(id: string): boolean {
  return (
    id === 'qwen3-asr-flash' ||
    id === 'wan2.2-s2v' ||
    id === 'happyhorse-1.0-video-edit' ||
    id.startsWith('cosyvoice-') ||
    /^qwen-audio-[\d.]+-tts-/.test(id)
  )
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

export const bailianProvider = adapterToProvider(adapter, {
  id: 'aliyun/bailian',
  title: '阿里云百炼',
  description: '千问对话、图像、万相视频和语音合成；连接测试仅检查本地配置，不调用计费模型',
  testScope: 'configuration',
  docsUrl: 'https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key',
  channel: 'bailian',
  models: adapterModels(adapter, 'bailian').filter((spec) => !unsupportedInPlein(spec.id)),
  // 适配器会探测 BAILIAN_API_KEY、域名与轮询覆盖等 MCP / CLI 用的密钥名，宿主沙箱只认清单声明的
  declaredSecretsOnly: true,
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
