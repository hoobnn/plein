import {
  type CapabilityContext,
  type CapabilityDefinition,
  CapabilityError,
  type CapabilityRegistry,
  isContent,
} from '@plein/capabilities'
import { z } from 'zod'
import { classifyError, type ErrorCode, statusCode } from './error-codes'
import { RESULT_BYTES } from './context-budget'

/**
 * 极简 MCP 服务端（Streamable HTTP，无状态，只用 JSON 响应）：
 * 实现 initialize、tools/list、tools/call、ping；提供了 provider 时再带上 resources/*、prompts/*。
 * 响应默认是 JSON；客户端带 progressToken 且调用方提供 notify 时，由路由层改用 SSE 推进度通知。
 * 不引入官方 SDK：它的 HTTP 传输绑定 Node req/res，而这里跑在 Hono 上。
 */

export type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | {
      type: 'resource_link'
      uri: string
      name: string
      mimeType?: string
      description?: string
    }

export interface ToolResult {
  content: ToolContent[]
  isError?: boolean
  /** 机器可读的补充：错误结果带 { error: { code, message } }，需要调用方处理的状态带 { code } */
  structuredContent?: Record<string, unknown>
}

// ── 协议块：工具标注与调用上下文 ─────────────────────────────

/** MCP 工具标注（客户端据此决定是否要用户确认；规范要求客户端视其为不可信提示） */
export interface ToolAnnotations {
  title?: string
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

/** 一次调用的上下文：进度通知、调用方身份 */
export interface CallContext {
  /** 客户端带了 progressToken 时才有；progress 必须递增 */
  progress?(progress: number, total?: number, message?: string): void
  /** 本次请求的授权对象（由路由层认证后传入，McpServer 不解释它） */
  auth?: unknown
}

export interface McpTool<S extends z.ZodObject = z.ZodObject> {
  name: string
  /** 给模型看的说明 */
  description: string
  input: S
  /** 给人看的名称 */
  title?: string
  annotations?: ToolAnnotations
  run(args: z.output<S>, call?: CallContext): Promise<ToolResult | string> | ToolResult | string
}

export function defineTool<S extends z.ZodObject>(tool: McpTool<S>): McpTool {
  return tool as unknown as McpTool
}

/** 工具执行中可预期的错误：原样告诉模型，让它换个做法 */
export const ToolError = CapabilityError

/** 带明确错误码的可预期错误（权限不够、被限额拦下等）；其余错误由消息归类 */
export class CodedToolError extends CapabilityError {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message)
  }
}

// ── 协议块：能力 effect → 工具标注 ───────────────────────────

/** 除 run 外也会调用外部平台 / 模型的能力 */
const OPEN_WORLD = new Set(['rewrite_prompt', 'plan_analysis', 'extract_cast', 'review_candidate'])

export function annotationsOf(cap: CapabilityDefinition<z.ZodObject, never>): ToolAnnotations {
  // 按参数才能判定等级的能力取最坏情形：可能改动、可能破坏
  const effect = typeof cap.effect === 'function' ? 'dynamic' : cap.effect
  const openWorld = effect === 'run' || cap.group === 'plugin' || OPEN_WORLD.has(cap.name)
  return {
    title: cap.title,
    readOnlyHint: effect === 'read',
    destructiveHint: effect === 'destructive' || effect === 'dynamic',
    idempotentHint: effect === 'read',
    openWorldHint: openWorld,
  }
}

/**
 * 能力的返回值转成 MCP 工具结果。
 * 文本超过上限（与内置智能体同口径 32 KiB）时不返回原文，提示改用分页工具；limit 传 Infinity 关闭。
 */
export function toToolResult(out: unknown, limit = RESULT_BYTES): ToolResult | string {
  const result: ToolResult | string = isContent(out)
    ? { content: out.content }
    : typeof out === 'string'
      ? out
      : JSON.stringify(out, null, 1)
  const texts =
    typeof result === 'string'
      ? [result]
      : result.content.flatMap((c) => (c.type === 'text' ? [c.text] : []))
  const bytes = texts.reduce((n, t) => n + Buffer.byteLength(t), 0)
  if (bytes <= limit) return result
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          error: 'tool_result_too_large',
          message: `结果 ${Math.ceil(bytes / 1024)} KiB，超过 ${Math.floor(limit / 1024)} KiB 上限，未返回。读取类请用 get_canvas_page / get_element_field 等分页工具；若这是修改类调用，修改已经生效，请用读取工具核对。`,
        }),
      },
    ],
  }
}

/**
 * 调用前的关卡（确认策略）：返回 null 放行；返回结果则不执行、把它交给模型。
 * run 是放行后的原调用，批准后可以稍后再执行。
 */
export type ToolGate<C extends CapabilityContext> = (
  cap: CapabilityDefinition<z.ZodObject, C>,
  args: Record<string, unknown>,
  run: () => Promise<ToolResult | string>,
) => ToolResult | string | null | Promise<ToolResult | string | null>

/** 把能力注册表转成 MCP 工具：输入 schema 同一份，结果按 MCP content 序列化 */
export function capabilityTools<C extends CapabilityContext>(
  registry: CapabilityRegistry<C>,
  ctx: C,
  gate?: ToolGate<C>,
): McpTool[] {
  return registry.list().map((cap) => ({
    name: cap.name,
    title: cap.title,
    description: cap.description,
    input: cap.input,
    annotations: annotationsOf(cap as never),
    run: async (args) => {
      const run = async () => toToolResult(await registry.invoke(cap.name, ctx, args))
      return (await gate?.(cap, args, run)) ?? run()
    },
  }))
}

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

interface RpcRequest {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: Record<string, unknown>
}

type RpcResponse =
  | { jsonrpc: '2.0'; id: string | number | null; result: unknown }
  | {
      jsonrpc: '2.0'
      id: string | number | null
      error: { code: number; message: string; data?: unknown }
    }

// ── 协议块：resources / prompts 提供方 ────────────────────────

export interface McpResource {
  uri: string
  name: string
  title?: string
  description?: string
  mimeType?: string
}

export interface McpResourceTemplate {
  uriTemplate: string
  name: string
  title?: string
  description?: string
  mimeType?: string
}

export interface McpResourceContents {
  uri: string
  mimeType: string
  text: string
}

export interface McpPrompt {
  name: string
  title?: string
  description?: string
  arguments?: Array<{ name: string; description?: string; required?: boolean }>
}

export interface McpPromptResult {
  description?: string
  messages: Array<{ role: 'user' | 'assistant'; content: { type: 'text'; text: string } }>
}

/** 工具之外的协议面。auth 是路由层认证后随请求传入的对象，McpServer 不解释它 */
export interface McpProvider {
  /** tools/list 里这个工具对当前授权是否可见 */
  visible?(tool: McpTool, auth: unknown): boolean
  resources?: {
    list(auth: unknown, cursor?: string): { resources: McpResource[]; nextCursor?: string }
    templates(): McpResourceTemplate[]
    /** 找不到时抛 RpcError(-32602, ..., { uri }) */
    read(auth: unknown, uri: string): McpResourceContents[] | Promise<McpResourceContents[]>
  }
  prompts?: {
    list(): McpPrompt[]
    get(name: string, args: Record<string, string>): McpPromptResult
  }
}

/** 一次 POST 的请求上下文 */
export interface RequestContext {
  auth?: unknown
  /** 推一条服务端通知（进度）；只有响应走 SSE 时才有 */
  notify?(message: { jsonrpc: '2.0'; method: string; params: unknown }): void
}

/** 请求里的 progressToken（字符串或整数） */
export function progressTokenOf(req: unknown): string | number | undefined {
  const t = (req as RpcRequest | null)?.params?._meta as { progressToken?: unknown } | undefined
  return typeof t?.progressToken === 'string' || typeof t?.progressToken === 'number'
    ? t.progressToken
    : undefined
}

export class McpServer {
  private tools = new Map<string, McpTool>()

  constructor(
    private info: { name: string; version: string; instructions?: string },
    tools: McpTool[],
    private provider: McpProvider = {},
    /** 错误结果的文字里也带上错误码（外部客户端模型多半只看文字） */
    private codeInText = false,
  ) {
    for (const t of tools) this.tools.set(t.name, t)
  }

  /** 处理一次 POST 的消息体；全是通知时返回 null（应答 202） */
  async handle(
    body: unknown,
    rc: RequestContext = {},
  ): Promise<RpcResponse | RpcResponse[] | null> {
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map((m) => this.one(m, rc)))).filter(
        (r): r is RpcResponse => r !== null,
      )
      return out.length ? out : null
    }
    return this.one(body, rc)
  }

  private async one(msg: unknown, rc: RequestContext): Promise<RpcResponse | null> {
    const req = msg as RpcRequest
    if (!req || typeof req !== 'object' || typeof req.method !== 'string') {
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }
    }
    // 通知不应答
    if (req.id === undefined) return null
    const id = req.id
    try {
      return { jsonrpc: '2.0', id, result: await this.dispatch(req, rc) }
    } catch (err) {
      const code = err instanceof RpcError ? err.code : -32603
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code,
          message: (err as Error).message,
          ...(err instanceof RpcError && err.data !== undefined ? { data: err.data } : {}),
        },
      }
    }
  }

  private async dispatch(req: RpcRequest, rc: RequestContext): Promise<unknown> {
    const { resources, prompts } = this.provider
    switch (req.method) {
      case 'initialize': {
        const asked = String(req.params?.protocolVersion ?? '')
        return {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: {
            tools: { listChanged: false },
            ...(resources ? { resources: { subscribe: false, listChanged: false } } : {}),
            ...(prompts ? { prompts: { listChanged: false } } : {}),
          },
          serverInfo: { name: this.info.name, version: this.info.version },
          instructions: this.info.instructions,
        }
      }
      case 'ping':
        return {}
      case 'tools/list':
        return {
          tools: [...this.tools.values()]
            .filter((t) => this.provider.visible?.(t, rc.auth) ?? true)
            .map((t) => ({
              name: t.name,
              ...(t.title ? { title: t.title } : {}),
              description: t.description,
              inputSchema: inputSchema(t.input),
              ...(t.annotations ? { annotations: t.annotations } : {}),
            })),
        }
      case 'tools/call':
        return this.call(req, rc)
      case 'resources/list':
        if (!resources) break
        return resources.list(rc.auth, cursorOf(req))
      case 'resources/templates/list':
        if (!resources) break
        return { resourceTemplates: resources.templates() }
      case 'resources/read': {
        if (!resources) break
        const uri = req.params?.uri
        if (typeof uri !== 'string') throw new RpcError(-32602, 'resources/read 需要 uri')
        return { contents: await resources.read(rc.auth, uri) }
      }
      case 'prompts/list':
        if (!prompts) break
        return { prompts: prompts.list() }
      case 'prompts/get': {
        if (!prompts) break
        const name = req.params?.name
        if (typeof name !== 'string') throw new RpcError(-32602, 'prompts/get 需要 name')
        const raw = (req.params?.arguments ?? {}) as Record<string, unknown>
        const args = Object.fromEntries(
          Object.entries(raw).filter(([, v]) => typeof v === 'string'),
        ) as Record<string, string>
        return prompts.get(name, args)
      }
    }
    throw new RpcError(-32601, `Method not found: ${req.method}`)
  }

  private async call(req: RpcRequest, rc: RequestContext): Promise<ToolResult> {
    const params = req.params ?? {}
    const tool = this.tools.get(String(params.name))
    if (!tool) throw new RpcError(-32602, `Unknown tool: ${String(params.name)}`)
    const token = progressTokenOf(req)
    let last = 0
    const call: CallContext = {
      auth: rc.auth,
      ...(token !== undefined && rc.notify
        ? {
            progress: (progress, total, message) => {
              // 规范要求 progress 单调递增
              last = Math.max(last + 1e-6, progress)
              rc.notify!({
                jsonrpc: '2.0',
                method: 'notifications/progress',
                params: {
                  progressToken: token,
                  progress: last,
                  ...(total !== undefined ? { total } : {}),
                  ...(message ? { message } : {}),
                },
              })
            },
          }
        : {}),
    }
    return callTool(tool, params.arguments ?? {}, call, this.codeInText)
  }
}

const cursorOf = (req: RpcRequest) =>
  typeof req.params?.cursor === 'string' ? req.params.cursor : undefined

// ── 协议块：工具调用的公共出口（错误码在这里统一给）──────────────

function errorResult(
  message: string,
  code: ErrorCode,
  inText: boolean,
  extra: Record<string, unknown> = {},
): ToolResult {
  return {
    content: [{ type: 'text', text: inText ? `${message}\n（错误码：${code}）` : message }],
    isError: true,
    structuredContent: { error: { code, message, ...extra } },
  }
}

/** 执行一次工具调用：参数不对、可预期的错误都变成给模型看的错误结果，不抛出 */
export async function callTool(
  tool: McpTool,
  args: unknown,
  call?: CallContext,
  codeInText = false,
): Promise<ToolResult> {
  const parsed = tool.input.safeParse(args)
  if (!parsed.success)
    return errorResult(`参数不对：${z.prettifyError(parsed.error)}`, 'invalid_params', codeInText, {
      issues: parsed.error.issues.map((i) => ({
        path: i.path.map(String).join('.'),
        message: i.message,
      })),
    })
  try {
    const out = await tool.run(parsed.data, call)
    const result =
      typeof out === 'string' ? { content: [{ type: 'text' as const, text: out }] } : out
    if (result.isError) {
      // 已经是错误结果（预检拦下、结果过大）：补上错误码
      if (result.structuredContent?.error) return result
      const text = result.content.find((c) => c.type === 'text')
      const message = text?.type === 'text' ? text.text : '失败'
      const code = /tool_result_too_large/.test(message) ? 'too_large' : classifyBlocked(message)
      return { ...result, ...errorResult(message, code, codeInText), content: result.content }
    }
    const first = result.content[0]
    const code = first?.type === 'text' ? statusCode(first.text) : undefined
    return code && !result.structuredContent ? { ...result, structuredContent: { code } } : result
  } catch (err) {
    // 可预期的错误原样告诉调用方；真实的服务端异常（数据库、ffmpeg…）细节只写日志
    if (!(err instanceof ToolError)) {
      console.warn(`[agent] 工具 ${tool.name} 出错：`, err)
      return errorResult('服务端内部错误，请稍后重试；细节见服务端日志', 'internal', codeInText)
    }
    const message = (err as Error).message
    return errorResult(
      message,
      err instanceof CodedToolError ? err.code : classifyError(message),
      codeInText,
    )
  }
}

/** 返回值本身标成错误的结果（预检拦下）：能分类就分类，否则算被阻断 */
function classifyBlocked(message: string): ErrorCode {
  const code = classifyError(message)
  return code === 'failed' ? 'blocked' : code
}

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message)
  }
}

/** 工具参数的 JSON Schema（MCP 和内置智能体共用） */
export function inputSchema(schema: z.ZodObject): Record<string, unknown> {
  const { $schema: _, ...rest } = z.toJSONSchema(schema, {
    io: 'input',
    unrepresentable: 'any',
  }) as Record<string, unknown>
  return rest
}
