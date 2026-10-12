import { z } from 'zod'

/**
 * 极简 MCP 服务端（Streamable HTTP，无状态，只用 JSON 响应）：
 * 只实现工具相关的方法（initialize、tools/list、tools/call、ping），够 Claude Code / Codex 当客户端用。
 * 不引入官方 SDK：它的 HTTP 传输绑定 Node req/res，而这里跑在 Hono 上。
 */

export type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

export interface ToolResult {
  content: ToolContent[]
  isError?: boolean
}

export interface McpTool<S extends z.ZodObject = z.ZodObject> {
  name: string
  /** 给模型看的说明 */
  description: string
  input: S
  run(args: z.output<S>): Promise<ToolResult | string> | ToolResult | string
}

export function defineTool<S extends z.ZodObject>(tool: McpTool<S>): McpTool {
  return tool as unknown as McpTool
}

/** 工具执行中可预期的错误：原样告诉模型，让它换个做法 */
export class ToolError extends Error {}

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

interface RpcRequest {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: Record<string, unknown>
}

type RpcResponse =
  | { jsonrpc: '2.0'; id: string | number | null; result: unknown }
  | { jsonrpc: '2.0'; id: string | number | null; error: { code: number; message: string } }

export class McpServer {
  private tools = new Map<string, McpTool>()

  constructor(
    private info: { name: string; version: string; instructions?: string },
    tools: McpTool[],
  ) {
    for (const t of tools) this.tools.set(t.name, t)
  }

  /** 处理一次 POST 的消息体；全是通知时返回 null（应答 202） */
  async handle(body: unknown): Promise<RpcResponse | RpcResponse[] | null> {
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map((m) => this.one(m)))).filter(
        (r): r is RpcResponse => r !== null,
      )
      return out.length ? out : null
    }
    return this.one(body)
  }

  private async one(msg: unknown): Promise<RpcResponse | null> {
    const req = msg as RpcRequest
    if (!req || typeof req !== 'object' || typeof req.method !== 'string') {
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }
    }
    // 通知不应答
    if (req.id === undefined) return null
    const id = req.id
    try {
      return { jsonrpc: '2.0', id, result: await this.dispatch(req) }
    } catch (err) {
      const code = err instanceof RpcError ? err.code : -32603
      return { jsonrpc: '2.0', id, error: { code, message: (err as Error).message } }
    }
  }

  private async dispatch(req: RpcRequest): Promise<unknown> {
    switch (req.method) {
      case 'initialize': {
        const asked = String(req.params?.protocolVersion ?? '')
        return {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: this.info.name, version: this.info.version },
          instructions: this.info.instructions,
        }
      }
      case 'ping':
        return {}
      case 'tools/list':
        return {
          tools: [...this.tools.values()].map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: inputSchema(t.input),
          })),
        }
      case 'tools/call':
        return this.call(req.params ?? {})
      default:
        throw new RpcError(-32601, `Method not found: ${req.method}`)
    }
  }

  private async call(params: Record<string, unknown>): Promise<ToolResult> {
    const tool = this.tools.get(String(params.name))
    if (!tool) throw new RpcError(-32602, `Unknown tool: ${String(params.name)}`)
    const parsed = tool.input.safeParse(params.arguments ?? {})
    if (!parsed.success) {
      return {
        content: [{ type: 'text', text: `参数不对：${z.prettifyError(parsed.error)}` }],
        isError: true,
      }
    }
    try {
      const out = await tool.run(parsed.data)
      return typeof out === 'string' ? { content: [{ type: 'text', text: out }] } : out
    } catch (err) {
      if (!(err instanceof ToolError)) console.warn(`[agent] 工具 ${tool.name} 出错：`, err)
      return { content: [{ type: 'text', text: (err as Error).message }], isError: true }
    }
  }
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message)
  }
}

function inputSchema(schema: z.ZodObject): Record<string, unknown> {
  const { $schema: _, ...rest } = z.toJSONSchema(schema, {
    io: 'input',
    unrepresentable: 'any',
  }) as Record<string, unknown>
  return rest
}
