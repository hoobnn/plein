import type { AssetRef, ChatMessage, ChatTool, ChatToolCall } from '@plein/plugin-sdk'
import { ProviderError } from '@plein/plugin-sdk'
import type { PluginHost } from '../plugins/host'
import { callTool, inputSchema, type McpTool, type ToolResult } from './mcp'
import type { TurnExecution } from './execution'
import type { AgentContext } from '@plein/protocol'
import { budgetMessages, TEXT_TOKENS, truncateResultText } from './context-budget'

/**
 * 内置智能体：不装 Claude Code / Codex，直接用已启用平台的对话模型（声明了 tools 特性的）驱动同一套画布能力。
 * 每一步经插件宿主调一次 text.chat（密钥裁剪、受限 fetch、限流、错误归类照旧），
 * 模型要调用工具就执行后把结果发回去，直到模型不再调用工具或达到步数上限。
 */

/** 一轮最多几步（一步 = 一次模型调用） */
export const MAX_STEPS = 30
/** 重试前的等待（毫秒），长度即最多重试次数 */
export const RETRY_DELAYS_MS: readonly number[] = [1000, 2000, 4000]

/** 剩余步数等于它时提醒模型收尾 */
const WRAP_UP_STEPS = 3
const WRAP_UP_NOTICE = `系统提示：本轮只剩 ${WRAP_UP_STEPS} 步，请停止开启新操作，汇报已完成和未完成的部分，并给出下一步建议。`

// ProviderError 按 code 给出默认值（限流、超时、暂不可用为真），平台显式标了不可重试时尊重它
const retryable = (err: unknown) => err instanceof ProviderError && err.retryable

/** 等待 ms 毫秒；signal 取消时提前结束 */
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })

export interface BuiltinModel {
  ref: string
  title: string
  vision: boolean
}

/** 驱动内置智能体的模型：默认对话模型，且声明了 tools 特性；不满足时没有 */
export function builtinModel(host: PluginHost, selected?: string): BuiltinModel | undefined {
  const models = host
    .models('text.chat', { agent: true })
    .filter((m) => m.features?.includes('tools'))
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
  /** 覆盖重试等待时间（测试用） */
  retryDelaysMs?: readonly number[]
  vision?: boolean
  saveImage?(image: { data: string; mimeType: string }): Promise<AssetRef>
  /** 模型输出的文字：step 内流式累积，同一步同一个 key */
  onText(key: string, text: string, done: boolean): void
  onToolStart(call: ChatToolCall): void
  onToolEnd(call: ChatToolCall, result: ToolResult): void
  onContext?(context: AgentContext): void
}

const resultText = (r: ToolResult) =>
  truncateResultText(
    r.content
      .map((c) =>
        c.type === 'text' ? c.text : c.type === 'image' ? '（图片内容在随后素材消息中）' : '',
      )
      .join('\n'),
  )

const MAX_IMAGES = 8
const MAX_IMAGE_BYTES = 1024 * 1024
const MAX_TOTAL_IMAGE_BYTES = 4 * 1024 * 1024

/** 编辑距离（小写比较），用来给写错的工具名找近似项 */
function distance(a: string, b: string) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++)
      row[j] = Math.min(
        prev[j]! + 1,
        row[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    prev = row
  }
  return prev[b.length]!
}

/** 最接近的 3 个工具名：互相包含的优先，其次按编辑距离 */
export function closestTools(name: string, names: string[]) {
  const n = name.toLowerCase()
  return names
    .map((x) => {
      const l = x.toLowerCase()
      return { x, rank: n && (l.includes(n) || n.includes(l)) ? 0 : 1, d: distance(n, l) }
    })
    .sort((a, b) => a.rank - b.rank || a.d - b.d)
    .slice(0, 3)
    .map((c) => c.x)
}

/** 本次工具返回的图片是否会超出预算；超出时返回原因，不改动已用量 */
function imageOverBudget(sizes: number[], used: { count: number; bytes: number }) {
  if (used.count + sizes.length > MAX_IMAGES)
    return `图片张数超限（已有 ${used.count} 张，本次再来 ${sizes.length} 张，最多 ${MAX_IMAGES} 张）`
  const big = sizes.find((n) => n > MAX_IMAGE_BYTES)
  if (big !== undefined)
    return `单张图片超限（${Math.ceil(big / 1024)} KiB，单张最多 ${MAX_IMAGE_BYTES / 1024} KiB）`
  const total = used.bytes + sizes.reduce((n, v) => n + v, 0)
  if (total > MAX_TOTAL_IMAGE_BYTES)
    return `图片总大小超限（合计 ${Math.ceil(total / 1024)} KiB，最多 ${MAX_TOTAL_IMAGE_BYTES / 1024} KiB）`
  return undefined
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
    imageBytes = 0,
    emptyRetried = false

  for (let step = 0; step < MAX_STEPS; step++) {
    if (t.signal.aborted) return
    t.execution?.assertOpen()
    const budgeted = budgetMessages(t.system, t.history, current, tools, (context) =>
      t.onContext?.({
        ...context,
        source: 'estimate',
        limit: TEXT_TOKENS,
        model: t.model,
        updatedAt: Date.now(),
      }),
    )
    // 只剩最后几步时提醒模型收尾；这条消息只进本步请求，不写入转录
    const messages: ChatMessage[] =
      MAX_STEPS - step === WRAP_UP_STEPS
        ? [...budgeted, { role: 'user', content: WRAP_UP_NOTICE }]
        : budgeted
    if (t.execution) {
      t.execution.facts.requests++
      t.execution.persist()
    }
    const key = `s${step}`
    const delays = t.retryDelaysMs ?? RETRY_DELAYS_MS
    let res: Awaited<ReturnType<PluginHost['call']>> | undefined
    for (let attempt = 0; ; attempt++) {
      let streamed = ''
      try {
        res = await t.host.call(
          'text.chat',
          t.model,
          { messages, tools, toolChoice: 'auto', temperature: 0.3, maxTokens: 8192 },
          {
            ownerId: t.ownerId,
            usage: 'agent',
            signal: t.signal,
            onDelta: (d) => {
              streamed += d
              t.onText(key, streamed, false)
            },
          },
        )
        break
      } catch (err) {
        if (t.signal.aborted) return
        if (attempt >= delays.length || !retryable(err)) throw err
        // 这一次已流式输出的半截文字作废
        if (streamed) t.onText(key, '', false)
        if (t.execution) {
          t.execution.facts.retries++
          t.execution.persist()
        }
        await sleep(delays[attempt]!, t.signal)
        if (t.signal.aborted) return
        t.execution?.assertOpen()
      }
    }
    const text = res.outputs.flatMap((o) => (o.type === 'text' ? [o.text] : [])).join('\n')
    const calls = res.outputs.flatMap((o) => (o.type === 'tool_calls' ? o.calls : []))
    if (!text.trim() && !calls.length && step === 0) {
      // 本轮第一步就空回复：重试一次，仍空则报错；有过工具调用后的空回复视为正常结束
      if (emptyRetried) throw new ProviderError('unknown', '模型没有返回内容，请重试或换一个模型')
      emptyRetried = true
      if (t.execution) {
        t.execution.facts.retries++
        t.execution.persist()
      }
      step--
      continue
    }
    if (text.trim()) t.onText(key, text, true)
    const continuation = res.outputs.find((o) => o.type === 'tool_calls')
    append({
      ...(continuation?.type === 'tool_calls' && continuation.continuation
        ? { continuation: continuation.continuation }
        : {}),
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
        : {
            content: [
              {
                type: 'text',
                text: `没有工具 ${call.name}；最接近的有：${closestTools(call.name, [...byName.keys()]).join('、')}；可用 list_canvas_capabilities 查看`,
              },
            ],
            isError: true,
          }
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
      else if (images.length) {
        const sizes = images.map((image) => Math.ceil((image.data.length * 3) / 4))
        const over = imageOverBudget(sizes, { count: imageCount, bytes: imageBytes })
        if (over)
          // 超预算是模型能自己调整的问题：把原因回给它，不让整轮失败；被拒的图片不计入用量
          result = {
            content: [
              {
                type: 'text',
                text: `media_budget_exhausted: ${over}；本次图片未发送。请少看几张，或用更小的尺寸再试。`,
              },
            ],
            isError: true,
          }
        else
          for (const [i, image] of images.entries()) {
            imageCount++
            imageBytes += sizes[i]!
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
