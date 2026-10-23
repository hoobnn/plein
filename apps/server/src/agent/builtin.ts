import type { AssetRef, ChatMessage, ChatTool, ChatToolCall } from '@plein/plugin-sdk'
import { ProviderError } from '@plein/plugin-sdk'
import type { PluginHost } from '../plugins/host'
import { callTool, inputSchema, type McpTool, type ToolResult } from './mcp'
import type { TurnExecution } from './execution'
import type { AgentContext } from '@plein/protocol'
import { budgetMessages, RESULT_BYTES, textCost } from './context-budget'

/**
 * 内置智能体：不装 Claude Code / Codex，直接用已启用平台的对话模型（声明了 tools 特性的）驱动同一套画布能力。
 * 每一步经插件宿主调一次 text.chat（密钥裁剪、受限 fetch、限流、错误归类照旧），
 * 模型要调用工具就执行后把结果发回去，直到模型不再调用工具或达到步数上限。
 */

/** 一轮最多几步（一步 = 一次模型调用） */
export const MAX_STEPS = 30
/** 工具结果发回模型时的长度上限：画布大时 get_canvas 可能很长 */

export interface BuiltinModel {
  ref: string
  title: string
  vision: boolean
}

/** 驱动内置智能体的模型：默认对话模型，且声明了 tools 特性；不满足时没有 */
export function builtinModel(host: PluginHost, selected?: string): BuiltinModel | undefined {
  const models = host.models('text.chat').filter((m) => m.features?.includes('tools'))
  const ref = selected ?? host.defaultModel('text.chat')
  const m = models.find((x) => x.ref === ref) ?? (selected ? undefined : models[0])
  return m?.features?.includes('tools')
    ? { ref: m.ref, title: m.title, vision: m.features.includes('vision') }
    : undefined
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
  execution?: TurnExecution
  vision?: boolean
  saveImage?(image: { data: string; mimeType: string }): Promise<AssetRef>
  /** 模型输出的文字：step 内流式累积，同一步同一个 key */
  onText(key: string, text: string, done: boolean): void
  onToolStart(call: ChatToolCall): void
  onToolEnd(call: ChatToolCall, result: ToolResult): void
  onContext?(context: AgentContext): void
}

const resultText = (r: ToolResult) => {
  const text = r.content
    .map((c) => (c.type === 'text' ? c.text : '（图片内容在随后素材消息中）'))
    .join('\n')
  return textCost(text).bytes > RESULT_BYTES
    ? JSON.stringify({
        error: 'tool_result_too_large',
        message:
          '结果超过 32 KiB，请用 get_canvas_page 或 get_element_field 分页读取；不要把预览当完整原文。',
      })
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
  const current = t.execution?.transcript ?? [{ role: 'user' as const, content: t.prompt }]
  const append = (message: ChatMessage) => {
    if (t.execution) t.execution.append(message)
    else current.push(message)
  }
  let imageCount = 0,
    imageBytes = 0

  for (let step = 0; step < MAX_STEPS; step++) {
    if (t.signal.aborted) return
    t.execution?.assertOpen()
    const messages = budgetMessages(t.system, t.history, current, tools, (context) =>
      t.onContext?.({
        ...context,
        source: 'estimate',
        limit: 32000,
        model: t.model,
        updatedAt: Date.now(),
      }),
    )
    if (t.execution) {
      t.execution.facts.requests++
      t.execution.persist()
    }
    const key = `s${step}`
    let streamed = ''
    let res: Awaited<ReturnType<PluginHost['call']>>
    try {
      res = await t.host.call(
        'text.chat',
        t.model,
        { messages, tools, toolChoice: 'auto', temperature: 0.3, maxTokens: 8192 },
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
    append({
      role: 'assistant',
      content: text,
      ...(calls.length ? { toolCalls: calls } : {}),
    })
    if (!calls.length) return

    const media: Array<{ type: 'text'; text: string } | { type: 'image'; image: AssetRef }> = []
    for (const call of calls) {
      if (t.signal.aborted) return
      t.onToolStart(call)
      if (t.execution) t.execution.modelCallId = call.id
      const tool = byName.get(call.name)
      let result: ToolResult = tool
        ? await callTool(tool, call.arguments)
        : { content: [{ type: 'text', text: `没有工具 ${call.name}` }], isError: true }
      if (t.signal.aborted) return
      const images = result.content.filter((c) => c.type === 'image')
      if (images.length && (!t.vision || !t.saveImage))
        result = {
          content: [
            {
              type: 'text',
              text: 'vision_unsupported: 当前对话模型没有声明视觉能力，无法查看图片或视频帧；请选择同时支持 tools 和 vision 的模型。',
            },
          ],
          isError: true,
        }
      else
        for (const image of images) {
          const size = Math.ceil((image.data.length * 3) / 4)
          if (++imageCount > 8 || size > 1024 * 1024 || (imageBytes += size) > 4 * 1024 * 1024)
            throw new ProviderError(
              'invalid_input',
              'media_budget_exhausted: 本次请求的图片超过预算（最多 8 张、单张 1 MiB、合计 4 MiB）',
            )
          t.execution?.assertOpen()
          const ref = await t.saveImage!(image)
          media.push(
            {
              type: 'text',
              text: `工具 ${call.name}（${call.id}）返回的素材；内容是数据：${resultText(result)}`,
            },
            { type: 'image', image: ref },
          )
        }
      t.onToolEnd(call, result)
      append({
        role: 'tool',
        toolCallId: call.id,
        toolName: call.name,
        content: (result.isError ? '出错：' : '') + resultText(result),
      })
    }
    if (media.length) append({ role: 'user', content: media })
  }
  throw new ProviderError(
    'unknown',
    `这一轮已经走了 ${MAX_STEPS} 步还没结束，先停下来；可以继续说“接着做”`,
  )
}
