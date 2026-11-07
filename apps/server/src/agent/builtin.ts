import type { AssetRef, ChatMessage, ChatTool, ChatToolCall } from '@plein/plugin-sdk'
import { ProviderError } from '@plein/plugin-sdk'
import type { PluginHost } from '../plugins/host'
import { callTool, inputSchema, type McpTool, type ToolResult } from './mcp'
import type { TurnExecution, TurnStep } from './execution'
import type { AgentContext, CompactAt } from '@plein/protocol'
import { builtinToolset, markLoaded } from './builtin-tools'
import { calibrated, calibrationOf, recordUsage } from './calibration'
import {
  budgetMessages,
  type ContextBudget,
  contextWindowOf,
  DEFAULT_BUDGET,
  OUTPUT_TOKENS,
  truncateResultText,
} from './context-budget'

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
  /** 模型声明的上下文窗口（输入加输出的 token）；未声明为 undefined */
  contextWindow?: number
  /** 模型声明的单次最大输出 token */
  maxOutputTokens?: number
}

/** 驱动内置智能体的模型：默认对话模型，且声明了 tools 特性；不满足时没有 */
export function builtinModel(host: PluginHost, selected?: string): BuiltinModel | undefined {
  const models = host
    .models('text.chat', { agent: true })
    .filter((m) => m.features?.includes('tools'))
  const ref = selected ?? host.defaultModel('text.chat')
  const m = models.find((x) => x.ref === ref) ?? (selected ? undefined : models[0])
  return m?.features?.includes('tools')
    ? {
        ref: m.ref,
        title: m.title,
        vision: m.features.includes('vision'),
        ...contextWindowOf(m),
      }
    : undefined
}

export interface BuiltinTurn {
  host: PluginHost
  model: string
  ownerId: string
  system: string
  /** 之前几轮的对话（只留文字） */
  history: ChatMessage[]
  /** 更早对话压缩成的摘要（已带抬头），紧跟系统指令发送，不参与省略 */
  summary?: string
  /** 这一轮用户说的话（含选区说明） */
  prompt: string
  tools: McpTool[]
  /** 已加载的非核心工具名（按加载先后）；会话内存里跨轮保留，缺省为空 */
  loaded?: string[]
  signal: AbortSignal
  execution?: TurnExecution
  /** 覆盖重试等待时间（测试用） */
  retryDelaysMs?: readonly number[]
  vision?: boolean
  /** 模型的请求预算；缺省按默认预算（模型未声明上下文窗口） */
  budget?: ContextBudget
  /** 每步发给模型的输出上限（token），缺省 8192 */
  maxTokens?: number
  /** 自动压缩阈值，只用于在上下文统计里显示；缺省 0.6 */
  compactAt?: CompactAt
  saveImage?(image: { data: string; mimeType: string }): Promise<AssetRef>
  /** 模型输出的文字：step 内流式累积，同一步同一个 key */
  onText(key: string, text: string, done: boolean): void
  onToolStart(call: ChatToolCall): void
  onToolEnd(call: ChatToolCall, result: ToolResult): void
  onContext?(context: AgentContext): void
  /** 取走用户在运行中排队的消息；每个 step 开始前调用，返回的提示词作为 user 消息追加进本轮 */
  takeQueued?(): string[]
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

/** 只读工具（按注册表 effect 推出的 readOnlyHint）；未知工具、需按参数判定等级的工具按非只读处理 */
const isReadOnly = (tool: McpTool | undefined) => tool?.annotations?.readOnlyHint === true

/** 把一次回复里的调用切成批：连续的只读调用同批并发，其余各自一批，批间保持原顺序 */
export function toolBatches(calls: ChatToolCall[], byName: Map<string, McpTool>): ChatToolCall[][] {
  const batches: ChatToolCall[][] = []
  let reading = false
  for (const call of calls) {
    const read = isReadOnly(byName.get(call.name))
    if (read && reading) batches.at(-1)!.push(call)
    else batches.push([call])
    reading = read
  }
  return batches
}

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

/** 画布能力转成对话模型的工具定义 */
export const chatTools = (tools: McpTool[]): ChatTool[] =>
  tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: inputSchema(tool.input),
  }))

/** 跑一轮；模型调用失败时抛 ProviderError，取消时静默结束 */
export async function runBuiltinTurn(t: BuiltinTurn): Promise<void> {
  const toolset = builtinToolset(t.tools, t.loaded ?? [], closestTools)
  const byName = new Map(toolset.all.map((tool) => [tool.name, tool]))
  const current = t.execution?.transcript ?? [{ role: 'user' as const, content: t.prompt }]
  const append = (message: ChatMessage) => {
    if (t.execution) t.execution.append(message)
    else current.push(message)
  }
  const runCall = async (call: ChatToolCall): Promise<ToolResult> => {
    const tool = byName.get(call.name)
    if (!tool)
      return {
        content: [
          {
            type: 'text',
            text: `没有工具 ${call.name}；最接近的有：${closestTools(call.name, [...byName.keys()]).join('、')}；可用 list_canvas_capabilities 查看`,
          },
        ],
        isError: true,
      }
    // 模型直接调用了存在但未加载的工具：照常执行，并从下一步起带上它的定义
    markLoaded(toolset.loader, [call.name])
    return callTool(tool, call.arguments, { callId: call.id })
  }
  let imageCount = 0,
    imageBytes = 0,
    emptyRetried = false
  let estimate:
    | { tokens: number; bytes: number; messages: number; omittedRounds: number }
    | undefined
  const budget = t.budget ?? DEFAULT_BUDGET
  const maxTokens = t.maxTokens ?? OUTPUT_TOKENS
  /** 预算相关的上下文字段：窗口推出的预算、字节上限、生效的压缩阈值和校准系数 */
  const limits = () => ({
    limit: budget.tokens,
    bytesLimit: budget.bytes,
    limitDeclared: budget.declared,
    compactAt: t.compactAt ?? 0.6,
    ...(calibrated(t.model) ? { calibration: calibrationOf(t.model) } : {}),
  })

  for (let step = 0; step < MAX_STEPS; step++) {
    if (t.signal.aborted) return
    t.execution?.assertOpen()
    for (const queued of t.takeQueued?.() ?? []) append({ role: 'user', content: queued })
    // 每步取一次校准系数：同一步内预算判断与显示口径一致
    const scale = calibrationOf(t.model)
    const tools = chatTools(toolset.send())
    const budgeted = budgetMessages(
      t.summary ? [t.system, t.summary] : t.system,
      t.history,
      current,
      tools,
      (context) => {
        estimate = context
        t.onContext?.({
          ...context,
          // 显示按校准系数折算后的估算；原始估算留在 estimate 里，用来和平台用量配对
          tokens: Math.ceil(context.tokens * scale),
          source: 'estimate',
          ...limits(),
          model: t.model,
          updatedAt: Date.now(),
        })
      },
      { budget, scale },
    )
    // 只剩最后几步时提醒模型收尾；这条消息只进本步请求，不写入转录
    const messages: ChatMessage[] =
      MAX_STEPS - step === WRAP_UP_STEPS
        ? [...budgeted, { role: 'user', content: WRAP_UP_NOTICE }]
        : budgeted
    const record: TurnStep = { startedAt: Date.now(), durationMs: 0, retries: 0 }
    if (t.execution) {
      t.execution.facts.requests++
      t.execution.facts.steps.push(record)
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
          { messages, tools, toolChoice: 'auto', temperature: 0.3, maxTokens },
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
        record.durationMs = Date.now() - record.startedAt
        if (t.signal.aborted) return
        if (attempt >= delays.length || !retryable(err)) {
          const failure = {
            code: err instanceof ProviderError ? err.code : 'unknown',
            message: (err as Error).message,
            retryable: err instanceof ProviderError && err.retryable,
          }
          record.error = failure
          if (t.execution) {
            t.execution.facts.error = failure
            t.execution.persist()
          }
          throw err
        }
        // 这一次已流式输出的半截文字作废
        if (streamed) t.onText(key, '', false)
        record.retries++
        if (t.execution) {
          t.execution.facts.retries++
          t.execution.persist()
        }
        await sleep(delays[attempt]!, t.signal)
        if (t.signal.aborted) return
        t.execution?.assertOpen()
      }
    }
    record.durationMs = Date.now() - record.startedAt
    const finish = (res as { finishReason?: unknown }).finishReason
    if (typeof finish === 'string') record.finish = finish
    const usage = res.usage
    if (usage && (usage.inputTokens !== undefined || usage.outputTokens !== undefined))
      record.usage = {
        ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
        ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
      }
    // 平台报告了真实输入 token 时，用它替换本步的估算（输入 token 即这次请求占用的上下文）
    if (usage?.inputTokens !== undefined && estimate) {
      // 真实输入与同一请求的原始估算配对，校准之后几步的预算判断
      recordUsage(t.model, estimate.tokens, usage.inputTokens)
      t.onContext?.({
        ...estimate,
        source: 'provider',
        tokens: usage.inputTokens,
        ...limits(),
        model: t.model,
        updatedAt: Date.now(),
      })
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
    // 连续的只读调用并发执行；写入、运行、删除等保持原顺序串行（一批只含一个调用）
    for (const batch of toolBatches(calls, byName)) {
      if (t.signal.aborted) return
      for (const call of batch) t.onToolStart(call)
      const raw = await Promise.all(batch.map((call) => runCall(call)))
      if (t.signal.aborted) return
      // 图片预算、素材入库与转录写入按原调用顺序串行做，不受并发完成先后影响
      for (const [i, call] of batch.entries()) {
        let result = raw[i]!
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
    }
    if (media.length) append({ role: 'user', content: media })
  }
  throw new ProviderError(
    'unknown',
    `这一轮已经走了 ${MAX_STEPS} 步还没结束，先停下来；可以继续说“接着做”`,
  )
}
