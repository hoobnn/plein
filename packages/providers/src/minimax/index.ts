import { minimaxAdapter as adapter, minimaxVoiceClone, minimaxVoiceDesign } from 'modelbay/minimax'
import {
  definePlugin,
  defineServerPlugin,
  PLUGIN_API_VERSION,
  type RemoteModel,
} from '@plein/plugin-sdk'
import { z } from 'zod'
import { adapterToProvider, toAdapterContext } from '../bridge'

/** 请求构造、校验、响应解析、轮询、声音复刻 / 设计都在 modelbay；这里只留宿主侧的设置、密钥、连接检查与插件声明。 */

const settings = z.object({
  region: z.enum(['cn', 'global']).default('cn').meta({ title: 'API 地区' }),
  voice: z.string().min(1).default('male-qn-qingse').meta({ title: '默认音色 ID' }),
})

export const minimaxProvider = adapterToProvider(adapter, {
  id: 'minimax/api',
  title: 'MiniMax',
  docsUrl: 'https://platform.minimax.cn/console/keys?tab=api-keys',
  description: '对话、图片、H3 音画视频、语音和音乐；生成使用按量 API Key',
  settings,
  secrets: [
    {
      name: 'MINIMAX_API_KEY',
      title: 'API Key',
      required: true,
      help: '密钥须与 API 地区一致；H3 使用按量接口',
    },
  ],
  limits: { concurrency: 2 },
  // 宿主语义：MiniMax 对话不接受 plein 传入的 extra（官方对话参数由适配器决定）
  prepareRequest(request) {
    if (request.capability !== 'text.chat') return request
    const { extra: _ignored, ...input } = request.input as Record<string, unknown>
    return { ...request, input } as typeof request
  },
  // 官方 /v1/models 是 OpenAI 兼容的对话模型列表，不覆盖图片 / 视频 / 语音 / 音乐
  remoteModelsScope: ['text.chat'],
  // 切换地区后列表不同，地域参与缓存键
  remoteModelsSettings: ['region'],
  async test(ctx) {
    await adapter.native!('listModels', {}, toAdapterContext(ctx))
  },
  async listRemoteModels(ctx) {
    // modelbay 的列表已含 structured 声明与业务错误脱敏
    return (await adapter.native!('listModels', {}, toAdapterContext(ctx))) as RemoteModel[]
  },
  voiceClone: minimaxVoiceClone,
  voiceDesign: minimaxVoiceDesign,
})

export const minimaxPlugin = defineServerPlugin(
  definePlugin({
    manifest: {
      id: 'minimax/api',
      version: '0.1.0',
      name: 'MiniMax',
      engines: { plein: `^${PLUGIN_API_VERSION}` },
      contributes: { providers: ['minimax/api'] },
      permissions: {
        network: [
          'api.minimax.cn',
          'api.minimax.io',
          '*.hailuoai.com',
          '*.minimax.cn',
          '*.minimax.io',
          '*.minimax.chat',
          '*.minimaxi.com',
          'hailuo-image-algeng-data.oss-cn-wulanchabu.aliyuncs.com',
          'algeng-video-infer.oss-cn-shanghai.aliyuncs.com',
        ],
        secrets: ['MINIMAX_API_KEY'],
        assets: 'read',
      },
    },
  }),
  { providers: [minimaxProvider] },
)
