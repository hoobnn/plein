import {
  CapabilityError,
  capabilityFor,
  expandPluginTemplate,
  referenceClipboard,
} from '@plein/capabilities'
import { type ClipboardData, isClipboardData, spotAfterContent } from '@plein/doc'
import { describeNode, executionOf, withDefaultModel } from '@plein/plugin-sdk'
import { z } from 'zod'
import type { ServerContext } from './tools'

const cap = capabilityFor<ServerContext>()
export const listTemplates = cap({
  name: 'list_canvas_templates',
  title: '读取可用工作流模板',
  group: 'read',
  where: 'server',
  effect: 'read',
  description:
    '列出插件工作流模板；用户保存的模板用 list_canvas_actions 的 list_templates 查询。模板只创建结构，不运行模型。',
  input: z.object({}),
  run: (ctx) =>
    [...ctx.env.host.registry.templates.values()].map(({ def, plugin }) => ({ ...def, plugin })),
})
export const placeTemplate = cap({
  name: 'place_canvas_template',
  title: '铺设工作流模板',
  group: 'edit',
  where: 'server',
  effect: 'edit',
  description:
    '按 id 铺设插件或用户保存的工作流模板，与界面共用预检、ID/引用重映射和粘贴命令。只建不跑。source=plugin 时先 list_canvas_templates；source=saved 时先查询 list_templates 扩展操作。',
  input: z.object({
    id: z.string().min(1).max(200),
    source: z.enum(['plugin', 'saved']),
    x: z.number().finite().optional(),
    y: z.number().finite().optional(),
  }),
  run: async (ctx, a) => {
    let saved: ClipboardData | undefined
    if (a.source === 'saved') {
      if (!ctx.env.canvasApi) throw new CapabilityError('模板服务不可用')
      const response = await ctx.env.canvasApi(
        ctx.env.ownerId,
        new Request('http://plein.internal/api/templates', {
          signal: ctx.env.execution?.abort.signal,
        }),
      )
      if (!response.ok) throw new CapabilityError('无法读取模板')
      const templates = (await response.json()) as Array<{ id: string; data: unknown }>
      const data = templates.find((t) => t.id === a.id)?.data
      if (!isClipboardData(data)) throw new CapabilityError('模板不存在或内容不合法')
      saved = data
    }
    return ctx.withDoc((doc) => {
      let data = saved
      if (a.source === 'plugin') {
        const host = ctx.env.host,
          entry = host.registry.templates.get(a.id)
        if (!entry) throw new CapabilityError('插件模板不存在')
        const nodes = [...host.registry.nodes.entries()].map(([key, n]) => ({
          ...withDefaultModel(describeNode(n.def, n.plugin), (c) => host.defaultModel(c)),
          executable: executionOf(n.def) === 'inline' || host.registry.executors.has(key),
        }))
        try {
          data = expandPluginTemplate(
            {
              plugins: [
                { id: entry.plugin, status: host.registry.plugin(entry.plugin)?.status ?? 'error' },
              ],
              nodes,
            },
            { ...entry.def, plugin: entry.plugin },
            doc,
          )
        } catch (error) {
          throw new CapabilityError(error instanceof Error ? error.message : '模板预检失败')
        }
      }
      if (!data?.elements.length) throw new CapabilityError('模板没有元素')
      const root = data.elements[0]!,
        at = spotAfterContent(doc, root.w, root.h)
      const ids = referenceClipboard.paste(doc, data, {
        canvasId: ctx.env.canvasId,
        dx: Math.round((a.x ?? at.x) - root.x),
        dy: Math.round((a.y ?? at.y) - root.y),
      })
      return { ids }
    })
  },
})
export const templateCapabilities = [listTemplates, placeTemplate]
