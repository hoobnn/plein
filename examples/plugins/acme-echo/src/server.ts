import {
  defineExecutor,
  defineNode,
  definePlugin,
  definePromptPreset,
  defineProvider,
  defineServerPlugin,
  inputText,
  PluginManifest,
  ProviderError,
} from '@plein/plugin-sdk'
import { servePlugin } from '@plein/plugin-sdk/child'
import { z } from 'zod'
import manifest from '../plein-plugin.json' with { type: 'json' }

/** 文本节点：不调模型，把输入喊出来 */
const shout = defineNode({
  type: 'acme/shout',
  version: 1,
  title: '大声说',
  description: '把文字变成大写，后面加感叹号',
  category: 'text',
  inputs: [{ id: 'text', label: '文本', type: 'text' }],
  outputs: [{ id: 'text', label: '文本', type: 'text' }],
  execution: 'job',
  params: z.object({
    text: z.string().default('').meta({ title: '文本', widget: 'textarea' }),
    marks: z.number().int().min(1).max(5).default(1).meta({ title: '感叹号个数' }),
  }),
})

/** 调对话模型的节点：经宿主的 providers.call */
const ask = defineNode({
  type: 'acme/ask',
  version: 1,
  title: '问一句',
  category: 'text',
  capability: 'text.chat',
  inputs: [],
  outputs: [{ id: 'text', label: '回答', type: 'text' }],
  params: z.object({
    model: z.string().default('').meta({ title: '模型', widget: 'model' }),
    prompt: z.string().default('').meta({ title: '问题', widget: 'textarea' }),
  }),
})

/** 对话平台：请求一个本机 HTTP 服务（只能访问清单声明的域名，由宿主代发） */
const echo = defineProvider({
  id: 'acme/echo',
  title: 'Acme 回声',
  settings: z.object({
    baseUrl: z.string().default('http://localhost:8787').meta({ title: '服务地址' }),
  }),
  secrets: [{ name: 'ACME_ECHO_KEY', title: 'API Key', required: true }],
  models: [{ id: 'echo-1', title: '回声 1', capabilities: ['text.chat'] }],
  testScope: 'connection',
  async test(ctx) {
    const res = await ctx.fetch(`${ctx.settings.baseUrl}/ping`)
    if (!res.ok) throw new ProviderError('unavailable', `HTTP ${res.status}`)
  },
  async submit(req, ctx) {
    const input = req.input as { messages: Array<{ content: unknown }> }
    const res = await ctx.fetch(`${ctx.settings.baseUrl}/echo`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ctx.secret('ACME_ECHO_KEY')}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ text: String(input.messages.at(-1)?.content ?? '') }),
    })
    if (res.status === 401) throw new ProviderError('auth', 'API Key 不对')
    if (!res.ok) throw new ProviderError('unavailable', `HTTP ${res.status}`)
    const data = (await res.json()) as { text: string }
    return { state: 'succeeded', outputs: [{ type: 'text', text: data.text }] }
  },
})

const plugin = definePlugin({
  manifest: PluginManifest.parse(manifest),
  nodes: [shout, ask],
  prompts: [
    definePromptPreset({
      id: 'acme/cheer',
      title: '加油',
      template: '给【谁】写一句加油的话',
      appliesTo: ['acme/ask'],
    }),
  ],
})

servePlugin(
  defineServerPlugin(plugin, {
    providers: [echo],
    executors: [
      defineExecutor(shout, async ({ params, inputs }) => {
        const text = inputText(inputs, 'text') ?? params.text
        return {
          text: [{ type: 'text', text: `${text.toUpperCase()}${'!'.repeat(params.marks)}` }],
        }
      }),
      defineExecutor(ask, async ({ params, providers }) => {
        const r = await providers.call('text.chat', params.model, {
          messages: [{ role: 'user', content: params.prompt }],
        })
        const text = r.outputs.flatMap((o) => (o.type === 'text' ? [o.text] : [])).join('')
        return { text: [{ type: 'text', text }] }
      }),
    ],
  }),
)
