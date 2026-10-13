// 测试用的 stdio MCP 服务：回声、出一张图、报错
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

// 1×1 的 PNG
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const server = new McpServer({ name: 'fixture', version: '1.0.0' })
server.registerTool(
  'echo',
  {
    description: '原样返回文字，前面加上环境变量 GREETING',
    inputSchema: { text: z.string() },
  },
  async ({ text }) => ({
    content: [{ type: 'text', text: `${process.env.GREETING ?? ''}${text}` }],
  }),
)
server.registerTool(
  'swatch',
  {
    description: '出一张色块图',
    inputSchema: { color: z.string().optional() },
    annotations: { readOnlyHint: true },
  },
  async () => ({
    content: [
      { type: 'text', text: '色块' },
      { type: 'image', data: PNG, mimeType: 'image/png' },
    ],
  }),
)
server.registerTool('fail', { description: '总是失败' }, async () => ({
  content: [{ type: 'text', text: '坏掉了' }],
  isError: true,
}))
await server.connect(new StdioServerTransport())
