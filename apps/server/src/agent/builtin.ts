import type { ChatMessage, ChatTool, ChatToolCall } from '@plein/plugin-sdk'
import { ProviderError } from '@plein/plugin-sdk'
import type { PluginHost } from '../plugins/host'
import { callTool, inputSchema, type McpTool, type ToolResult } from './mcp'

/**
 * 内置智能体：不装 Claude Code / Codex，直接用已启用平台的对话模型（声明了 tools 特性的）驱动同一套画布能力。
 * 每一步经插件宿主调一次 text.chat（密钥裁剪、受限 fetch、限流、错误归类照旧），
 * 模型要调用工具就执行后把结果发回去，直到模型不再调用工具或达到步数上限。
 */

/** 一轮最多几步（一步 = 一次模型调用） */
export const MAX_STEPS = 30
/** 工具结果发回模型时的长度上限：画布大时 get_canvas 可能很长 */
const MAX_RESULT_CHARS = 12_000

export interface BuiltinModel {
  ref: string
  title: string
}

/** 可以驱动内置智能体的对话模型：声明了 tools 特性的 */
export function builtinModels(host: PluginHost): BuiltinModel[] {
  return host
    .models('text.chat')
    .filter((m) => m.features?.includes('tools'))
    .map((m) => ({ ref: m.ref, title: m.title }))
}

export interface BuiltinTurn {
  host: PluginHost
  model: string
  ownerId: string
  system: string
  /** 之前几轮的对话（只留文字） */
  history: ChatMessage[]
  /** 这一轮用户说的话（含选区说明） */
  prompt: string
  tools: McpTool[]
  signal: AbortSignal
  /** 模型输出的文字：step 内流式累积，同一步同一个 key */
  onText(key: string, text: string, done: boolean): void
  onToolStart(call: ChatToolCall): void
  onToolEnd(call: ChatToolCall, result: ToolResult): void
}

const resultText = (r: ToolResult) => {
  const text = r.content
    .map((c) => (c.type === 'text' ? c.text : '（图片：当前模型看不到图片内容）'))
    .join('\n')
  return text.length > MAX_RESULT_CHARS
    ? `${text.slice(0, MAX_RESULT_CHARS)}\n…（结果太长已截断，用更具体的查询缩小范围）`
    : text
}

/** 跑一轮；模型调用失败时抛 ProviderError，取消时静默结束 */
export async function runBuiltinTurn(t: BuiltinTurn): Promise<void> {
  const tools: ChatTool[] = t.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: inputSchema(tool.input),
  }))
  const byName = new Map(t.tools.map((tool) => [tool.name, tool]))
  const messages: ChatMessage[] = [
    { role: 'system', content: t.system },
    ...t.history,
    { role: 'user', content: t.prompt },
  ]

  for (let step = 0; step < MAX_STEPS; step++) {
    if (t.signal.aborted) return
    const key = `s${step}`
    let streamed = ''
    let res: Awaited<ReturnType<PluginHost['call']>>
    try {
      res = await t.host.call(
        'text.chat',
        t.model,
        { messages, tools, toolChoice: 'auto', temperature: 0.3 },
        {
          ownerId: t.ownerId,
          signal: t.signal,
          onDelta: (d) => {
            streamed += d
            t.onText(key, streamed, false)
          },
        },
      )
    } catch (err) {
      if (t.signal.aborted) return
      throw err
    }
    const text = res.outputs.flatMap((o) => (o.type === 'text' ? [o.text] : [])).join('\n')
    const calls = res.outputs.flatMap((o) => (o.type === 'tool_calls' ? o.calls : []))
    if (text.trim()) t.onText(key, text, true)
    messages.push({
      role: 'assistant',
      content: text,
      ...(calls.length ? { toolCalls: calls } : {}),
    })
    if (!calls.length) return

    for (const call of calls) {
      if (t.signal.aborted) return
      t.onToolStart(call)
      const tool = byName.get(call.name)
      const result: ToolResult = tool
        ? await callTool(tool, call.arguments)
        : { content: [{ type: 'text', text: `没有工具 ${call.name}` }], isError: true }
      t.onToolEnd(call, result)
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        toolName: call.name,
        content: (result.isError ? '出错：' : '') + resultText(result),
      })
    }
  }
  throw new ProviderError(
    'unknown',
    `这一轮已经走了 ${MAX_STEPS} 步还没结束，先停下来；可以继续说“接着做”`,
  )
}
