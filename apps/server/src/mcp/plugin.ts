import { mcpArguments, mcpPlugin, mcpToolNode } from '@plein/nodes'
import {
  defineExecutor,
  defineServerPlugin,
  inputText,
  type PortValue,
  ProviderError,
} from '@plein/plugin-sdk'
import { type McpClients, McpError } from './clients'

/** MCP 工具节点的执行器：调外部服务的工具，文字进「文本」口，图片存进资产库后进「图片」口 */
export function mcpServerPlugin(clients: McpClients) {
  return defineServerPlugin(mcpPlugin, {
    executors: [
      defineExecutor(mcpToolNode, async (ctx) => {
        const { server, tool } = ctx.params
        if (!server || !tool) throw new ProviderError('invalid_input', '先选一个 MCP 服务和工具')
        let args: Record<string, unknown>
        try {
          args = mcpArguments(ctx.params.arguments, inputText(ctx.inputs, 'input'))
        } catch (err) {
          throw new ProviderError('invalid_input', (err as Error).message)
        }
        ctx.progress(0.1, '正在调用 MCP 工具')
        let res: Awaited<ReturnType<McpClients['call']>>
        try {
          res = await clients.call(server, tool, args, ctx.signal)
        } catch (err) {
          if (ctx.signal.aborted) throw new ProviderError('cancelled', '已取消')
          if (err instanceof McpError)
            throw new ProviderError('unavailable', err.message, { retryable: false })
          throw err
        }
        const text = res.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n\n')
        if (res.isError)
          throw new ProviderError('unknown', text || 'MCP 工具返回了错误', { retryable: false })
        const images: PortValue[] = []
        for (const c of res.content) {
          if (c.type !== 'image') continue
          const ref = await ctx.assets.put({
            data: new Uint8Array(Buffer.from(c.data, 'base64')),
            mime: c.mimeType,
            name: `${tool}.${c.mimeType.split('/')[1] ?? 'png'}`,
          })
          images.push({ type: 'image', ...ref })
        }
        return {
          text: text ? [{ type: 'text', text }] : [],
          images,
        }
      }),
    ],
  })
}
