/**
 * OpenAI 兼容对话接口的共用实现（Vercel AI SDK）：消息转换、结构化输出与 JSON Schema 校验、
 * 流式读取、用量归一化都在这里；鉴权、端点和各家错误码归类仍由适配器通过 fetch 包装提供。
 */
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import {
  type AssetRef,
  type CapabilityInput,
  type ChatMessage,
  type ChatToolCall,
  type ProviderContext,
  ProviderError,
  type ProviderOutput,
} from '@plein/plugin-sdk'
import { jsonSchema, type ModelMessage, Output, streamText, tool } from 'ai'
import { z } from 'zod'

// AI SDK 默认把“平台不支持某功能”的提示打到控制台；json_object 降级是有意的，不刷屏
;(globalThis as { AI_SDK_LOG_WARNINGS?: unknown }).AI_SDK_LOG_WARNINGS ??= false

/** extra 里不允许覆盖的请求字段：模型、输入、流式开关和工具由这里决定 */
const RESERVED = new Set([
  'model',
  'messages',
  'stream',
  'stream_options',
  'tools',
  'tool_choice',
  'response_format',
])

export interface ChatOptions {
  ctx: Pick<ProviderContext, 'signal' | 'stream'>
  /** 平台名，用在报错里（如“百炼”） */
  label: string
  /** 到 /chat/completions 之前的那一段，如 https://dashscope.aliyuncs.com/compatible-mode/v1 */
  baseURL: string
  /**
   * 适配器提供的 fetch：带上鉴权头、走插件受限的 ctx.fetch，HTTP 失败直接抛归类好的 ProviderError
   * （AI SDK 只当它是普通 fetch）
   */
  fetch: typeof globalThis.fetch
  model: string
  input: CapabilityInput<'text.chat'>
  /** 把图片资产换成平台能读的 URL（通常是 data URL） */
  image(ref: AssetRef): Promise<string>
  /**
   * json_schema：平台支持严格结构化输出，Schema 随请求发送；
   * json_object：只要求输出 JSON，Schema 写进系统提示
   */
  structured: 'json_schema' | 'json_object'
  /** 流里收到的错误帧（{ message, code } 一类的对象）按平台规则归类并脱敏 */
  streamError(error: Record<string, unknown>): ProviderError
}

async function toMessages(opts: ChatOptions): Promise<ModelMessage[]> {
  const text = (content: ChatMessage['content']) =>
    typeof content === 'string'
      ? content
      : content.map((p) => (p.type === 'text' ? p.text : '')).join('')
  const messages = await Promise.all(
    opts.input.messages.map(async (m): Promise<ModelMessage> => {
      if (m.role === 'system') return { role: 'system', content: text(m.content) }
      if (m.role === 'tool')
        return {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: m.toolCallId ?? '',
              toolName: m.toolName ?? '',
              output: { type: 'text', value: text(m.content) },
            },
          ],
        }
      if (m.role === 'assistant') {
        const said = text(m.content)
        if (!m.toolCalls?.length) return { role: 'assistant', content: said }
        return {
          role: 'assistant',
          content: [
            ...(said ? [{ type: 'text' as const, text: said }] : []),
            ...m.toolCalls.map((c) => ({
              type: 'tool-call' as const,
              toolCallId: c.id,
              toolName: c.name,
              input: c.arguments,
            })),
          ],
        }
      }
      if (typeof m.content === 'string') return { role: 'user', content: m.content }
      return {
        role: 'user',
        content: await Promise.all(
          m.content.map(async (p) =>
            p.type === 'text' ? p : { type: 'image' as const, image: await opts.image(p.image) },
          ),
        ),
      }
    }),
  )
  if (opts.input.jsonSchema && opts.structured === 'json_object')
    messages.unshift({
      role: 'system',
      content: `Return only JSON matching this schema: ${JSON.stringify(opts.input.jsonSchema)}`,
    })
  return messages
}

/** 平台返回的结构化结果按请求里的 JSON Schema 校验 */
function outputSchema(schema: Record<string, unknown>) {
  let validator: z.ZodType | null = null
  try {
    validator = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0])
  } catch {
    // Schema 用了 zod 不支持的写法时只检查是不是 JSON
  }
  return jsonSchema(schema, {
    validate: (value) => {
      if (!validator) return { success: true, value }
      const r = validator.safeParse(value)
      return r.success ? { success: true, value: r.data } : { success: false, error: r.error }
    },
  })
}

/** 适配器 fetch 里抛的 ProviderError 会被 AI SDK 包一层，这里取回来 */
function providerError(error: unknown): ProviderError | null {
  for (let e = error; e && typeof e === 'object'; e = (e as { cause?: unknown }).cause) {
    if (e instanceof ProviderError) return e
  }
  return null
}

/**
 * SSE 响应必须以 data: [DONE] 结束，否则视为中断：AI SDK 不检查这一点，
 * 半截回答会被当成完整结果
 */
export function requireSseDone(res: Response, error: () => ProviderError): Response {
  if (!res.body || !res.headers.get('content-type')?.includes('text/event-stream')) return res
  const decoder = new TextDecoder()
  let tail = ''
  let done = false
  const body = res.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        tail = (tail + decoder.decode(chunk, { stream: true })).slice(-64)
        if (/data:\s*\[DONE\]/.test(tail)) done = true
        controller.enqueue(chunk)
      },
      flush(controller) {
        if (!done) controller.error(error())
      },
    }),
  )
  return new Response(body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  })
}

/** 发一次对话（流式读取），返回 text.chat 的结果；提交不重试（远端可能已计费） */
export async function chatCompletion(opts: ChatOptions) {
  const { input, label } = opts
  const provider = createOpenAICompatible({
    name: 'plein',
    baseURL: opts.baseURL,
    fetch: opts.fetch,
    includeUsage: true,
    supportsStructuredOutputs: opts.structured === 'json_schema',
  })
  const extra = Object.fromEntries(
    Object.entries(input.extra ?? {}).filter(([k]) => !RESERVED.has(k)),
  ) as Record<string, never>
  const messages = await toMessages(opts)

  let failure: unknown = null
  const result = streamText({
    model: provider.chatModel(opts.model),
    messages,
    allowSystemInMessages: true,
    temperature: input.temperature,
    maxOutputTokens: input.maxTokens,
    maxRetries: 0,
    abortSignal: opts.ctx.signal,
    providerOptions: { plein: extra },
    ...(input.jsonSchema
      ? { output: Output.object({ schema: outputSchema(input.jsonSchema), name: 'plein_output' }) }
      : {}),
    // 工具只声明不执行：模型要调用时把调用交回宿主，由智能体循环执行后再发下一轮
    ...(input.tools?.length
      ? {
          tools: Object.fromEntries(
            input.tools.map((t) => [
              t.name,
              tool({ description: t.description, inputSchema: jsonSchema(t.parameters) }),
            ]),
          ),
          toolChoice: input.toolChoice ?? 'auto',
        }
      : {}),
    onChunk: ({ chunk }) => {
      if (chunk.type === 'text-delta' && chunk.text) opts.ctx.stream?.({ text: chunk.text })
    },
    onError: ({ error }) => {
      failure ??= error
    },
  })

  const fail = (thrown: unknown) => {
    const cause = failure ?? thrown
    const known = providerError(cause)
    if (known) return known
    // 流里的错误帧：AI SDK 包成 AI_StreamProviderError（带 message / code / type），也可能是原对象
    if (cause instanceof Error && cause.name === 'AI_StreamProviderError') {
      const { code, type } = cause as Error & { code?: unknown; type?: unknown }
      return opts.streamError({ message: cause.message, code, type })
    }
    if (cause && typeof cause === 'object' && !(cause instanceof Error))
      return opts.streamError(cause as Record<string, unknown>)
    if (opts.ctx.signal.aborted)
      return new ProviderError('cancelled', `${label}对话已取消`, { cause })
    // 其余是 AI SDK 自己的解析错误：原始信息只留在 cause 里，不进报错文案
    return new ProviderError('unknown', `${label}返回的对话数据无法解析；请勿自动重新提交`, {
      cause,
    })
  }
  let text: string
  let finishReason: string
  let usage: { inputTokens?: number; outputTokens?: number }
  let calls: ChatToolCall[]
  try {
    text = await result.text
    finishReason = await result.finishReason
    usage = await result.usage
    calls = (await result.toolCalls).map((c) => ({
      id: c.toolCallId,
      name: c.toolName,
      arguments: (c.input ?? {}) as Record<string, unknown>,
    }))
  } catch (e) {
    throw fail(e)
  }
  if (failure) throw fail(failure)
  if (finishReason === 'content-filter')
    throw new ProviderError('content_policy', `${label}拒绝生成此内容`)
  if (!text && !calls.length) throw new ProviderError('unknown', `${label}响应缺少对话内容`)
  if (input.jsonSchema && finishReason === 'length')
    throw new ProviderError('unknown', '结构化输出被 token 上限截断')
  let outputs: ProviderOutput[] = [
    ...(text ? [{ type: 'text' as const, text }] : []),
    ...(calls.length ? [{ type: 'tool_calls' as const, calls }] : []),
  ]
  if (input.jsonSchema) {
    try {
      outputs = [{ type: 'json', value: await result.output }]
    } catch (cause) {
      throw new ProviderError('unknown', `${label}返回的结构化内容不是有效 JSON 或不符合 Schema`, {
        cause,
      })
    }
  }
  return {
    state: 'succeeded' as const,
    outputs,
    usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
  }
}
