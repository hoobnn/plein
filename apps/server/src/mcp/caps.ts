import { CapabilityError, capabilityFor, content, type ContentBlock } from '@plein/capabilities'
import { z } from 'zod'
import type { ServerContext } from '../agent/tools'
import { McpError } from './clients'

const serverCapability = capabilityFor<ServerContext>()

const clientsOf = (ctx: ServerContext) => {
  const mcp = ctx.env.mcp
  if (!mcp) throw new CapabilityError('外部 MCP 服务只在本机模式可用')
  return mcp
}

const fail = (err: unknown): never => {
  if (err instanceof McpError) throw new CapabilityError(err.message)
  throw err
}

/** 必填参数的名字，列表里给模型一个提示 */
const requiredOf = (schema: Record<string, unknown>) =>
  Array.isArray(schema.required) ? (schema.required as string[]) : []

export const mcpListTools = serverCapability({
  name: 'mcp_list_tools',
  title: '查看外部工具',
  description:
    '列出用户在设置里添加的外部 MCP 服务和它们的工具（名称、说明、必填参数）。给了 server 时还返回每个工具完整的参数 JSON Schema。',
  group: 'run',
  where: 'server',
  effect: 'read',
  input: z.object({ server: z.string().max(100).optional().describe('服务 id；不填列出全部服务') }),
  run: async (ctx, { server }) => {
    const mcp = clientsOf(ctx)
    const servers = mcp.servers().filter((s) => !server || s.id === server)
    if (server && !servers.length) throw new CapabilityError(`没有启用的 MCP 服务 ${server}`)
    if (!servers.length) return '用户还没有添加外部 MCP 服务（在设置 → MCP 服务里添加）'
    const out = []
    for (const s of servers) {
      try {
        const tools = await mcp.tools(s.id)
        out.push({
          server: s.id,
          name: s.name,
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description?.slice(0, 300),
            ...(server ? { input_schema: t.inputSchema } : { required: requiredOf(t.inputSchema) }),
            ...(t.readOnly ? { read_only: true } : {}),
          })),
        })
      } catch (err) {
        out.push({ server: s.id, name: s.name, error: (err as Error).message })
      }
    }
    return out
  },
})

export const mcpCallTool = serverCapability({
  name: 'mcp_call_tool',
  title: '调用外部工具',
  description:
    '调用外部 MCP 服务的一个工具，返回它的文字和图片结果。参数按 mcp_list_tools 给的 Schema 填。想把这一步留在画布上反复用时，改用 create_node 建一个 plein/mcp-tool 节点。',
  group: 'run',
  where: 'server',
  // 服务声明只读的工具不用问，其余按花钱 / 有外部副作用对待
  effect: (input, ctx) =>
    ctx.env.mcp?.cachedTool(input.server, input.tool)?.readOnly ? 'read' : 'run',
  input: z.object({
    server: z.string().max(100).describe('服务 id'),
    tool: z.string().max(200),
    arguments: z.record(z.string(), z.unknown()).default({}),
  }),
  run: async (ctx, a) => {
    const mcp = clientsOf(ctx)
    const res = await mcp.call(a.server, a.tool, a.arguments).catch(fail)
    const blocks: ContentBlock[] = res.content.map((c) =>
      c.type === 'text' ? c : { type: 'image', data: c.data, mimeType: c.mimeType },
    )
    if (res.isError)
      throw new CapabilityError(
        `工具出错：${blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n')}`,
      )
    return blocks.length ? content(blocks) : '工具没有返回内容'
  },
})

export const mcpCapabilities = [mcpListTools, mcpCallTool]
