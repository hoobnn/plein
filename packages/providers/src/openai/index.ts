import { createOpenAIAdapter, models as openaiModels } from 'modelbay/openai'
import { editMask } from 'modelbay/openai/node'
import { definePlugin, defineServerPlugin, PLUGIN_API_VERSION } from '@plein/plugin-sdk'
import { z } from 'zod'
import { adapterToProvider, toAdapterContext } from '../bridge'

const adapter = createOpenAIAdapter(openaiModels, { editMask })

/** 官方渠道没有非敏感设置：地址固定，模型目录来自 modelbay 声明。 */
const settings = z.object({})

export const openaiProvider = adapterToProvider(adapter, {
  channel: 'openai',
  description: 'OpenAI 官方 API：对话、内置 Agent、图片生成与蒙版编辑。',
  settings,
  secrets: [{ name: 'OPENAI_API_KEY', title: 'API Key', required: true }],
  poll: false,
  // /models 不提供接口与能力信息，目录外条目仅展示，不自动当作对话模型提交。
  remoteModelsScope: [],
  async listRemoteModels(ctx) {
    const list = await adapter.native!('listModels', {}, toAdapterContext(ctx))
    return (list as Array<{ id: string }>).map((model) => ({
      ...model,
      features: ['structured' as const],
    }))
  },
  async test(ctx) {
    await adapter.native!('listModels', {}, toAdapterContext(ctx))
  },
})

export const openaiPlugin = defineServerPlugin(
  definePlugin({
    manifest: {
      id: 'openai/api',
      version: PLUGIN_API_VERSION,
      name: 'OpenAI',
      engines: { plein: `^${PLUGIN_API_VERSION}` },
      contributes: { providers: ['openai/api'] },
      permissions: { network: ['api.openai.com'], secrets: ['OPENAI_API_KEY'], assets: 'read' },
    },
  }),
  { providers: [openaiProvider] },
)
