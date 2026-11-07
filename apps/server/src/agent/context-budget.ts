import type { ChatMessage, ChatTool, ModelSpec } from '@plein/plugin-sdk'
import { CapabilityError } from '@plein/capabilities'

const encoder = new TextEncoder()
/** 未声明上下文窗口的模型使用的请求文本字节上限 */
export const TEXT_BYTES = 256 * 1024
export const RESULT_BYTES = 32 * 1024
// 内置智能体带上全部画布能力，工具清单本身就占三万多 token；
// 预算要留得下这份清单，再给对话留出余量。
/** 未声明上下文窗口的模型使用的请求 token 预算（长期兜底） */
export const TEXT_TOKENS = 96000
/** runBuiltinTurn 发给模型的输出上限，也是为输出预留的上限 */
export const OUTPUT_TOKENS = 8192

/** 一次请求的预算：tokens 为输入可用的 token，bytes 只是请求文本的健全性上限 */
export interface ContextBudget {
  tokens: number
  bytes: number
  /** 模型是否声明了上下文窗口；false 时按默认预算 */
  declared: boolean
}
export const DEFAULT_BUDGET: ContextBudget = {
  tokens: TEXT_TOKENS,
  bytes: TEXT_BYTES,
  declared: false,
}

const positive = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0

/** 模型声明里与上下文预算有关的两项（来自 modelbay 的模型声明） */
export type ModelWindow = Pick<ModelSpec, 'contextWindow' | 'maxOutputTokens'>

/**
 * 读模型声明的上下文窗口（一次请求能接受的输入加输出 token）和最大输出 token。
 * 只认正数；自动发现、自定义的模型没有声明，返回空。
 */
export function contextWindowOf(spec: ModelWindow | undefined): ModelWindow {
  const { contextWindow, maxOutputTokens } = spec ?? {}
  return {
    ...(positive(contextWindow) ? { contextWindow: Math.floor(contextWindow) } : {}),
    ...(positive(maxOutputTokens) ? { maxOutputTokens: Math.floor(maxOutputTokens) } : {}),
  }
}

/** 为输出预留的 token：模型最大输出与 8192 取小；窗口很小时最多占一半，免得输入预算为零 */
export function outputReserve(window: ModelWindow) {
  const reserve = Math.min(window.maxOutputTokens ?? OUTPUT_TOKENS, OUTPUT_TOKENS)
  return window.contextWindow ? Math.min(reserve, Math.floor(window.contextWindow / 2)) : reserve
}

/**
 * 按模型声明推出请求预算：tokens = 窗口 − 输出预留。
 * 字节上限只做健全性检查（没有平台侧的请求体限制），取 256 KiB 与 tokens × 4 的较大者，
 * 不让大窗口模型被它卡住。未声明窗口的模型沿用默认预算。
 */
export function budgetOf(spec: ModelWindow | undefined): ContextBudget {
  const window = contextWindowOf(spec)
  if (!window.contextWindow) return DEFAULT_BUDGET
  const tokens = window.contextWindow - outputReserve(window)
  return { tokens, bytes: Math.max(TEXT_BYTES, tokens * 4), declared: true }
}
export function textCost(value: unknown) {
  const text = JSON.stringify(value)
  let ascii = 0
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) < 128) ascii++
  return {
    bytes: encoder.encode(text).byteLength,
    tokens: Math.ceil(ascii / 4 + (text.length - ascii) * 2),
  }
}
/**
 * 工具结果超过上限时保留开头：按 UTF-8 字节截断（不切坏多字节字符），末尾追加一行说明。
 * 截断后的总长（含说明）不超过 limit，所以重复调用是幂等的；limit 传 Infinity 关闭。
 */
export function truncateResultText(text: string, limit = RESULT_BYTES): string {
  const buf = Buffer.from(text)
  if (buf.byteLength <= limit) return text
  const note = `\n结果已截断（原 ${Math.ceil(buf.byteLength / 1024)} KiB，保留前 ${Math.floor(limit / 1024)} KiB）；需要完整内容请用 get_canvas_page / get_element_field 等分页工具`
  let end = Math.max(0, limit - Buffer.byteLength(note))
  // buf[end] 是第一个被丢弃的字节；它若是续字节，说明切在字符中间，退回到该字符开头
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--
  return buf.subarray(0, end).toString('utf8') + note
}
/**
 * 请求是否在预算内。scale 是估算校准系数（平台真实用量 / 本地估算），只改变估算，不改变预算上限。
 */
export function requestWithinBudget(
  messages: ChatMessage[],
  tools: ChatTool[],
  budget: ContextBudget = DEFAULT_BUDGET,
  scale = 1,
) {
  const cost = textCost({ messages, tools })
  return cost.bytes <= budget.bytes && (cost.tokens + messages.length * 16) * scale <= budget.tokens
}
/** 压缩本轮内容时保留原样的最近 tool 消息条数 */
const KEEP_RECENT_TOOLS = 2

const contentLength = (m: ChatMessage) =>
  typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length

/**
 * Complete user-led rounds only; history is never cut apart.
 * system 可传多段（系统指令、较早对话的摘要），依次作为开头的 system 消息，始终发送、不参与省略。
 * 历史丢完仍超预算时，从本轮最早的 tool 消息起把内容换成一行占位（消息本身保留，tool_call 与结果仍成对），
 * 最近 2 条 tool 消息与 assistant / user 消息不动。返回新数组，不改传入的消息。
 */
export function budgetMessages(
  system: string | readonly string[],
  history: ChatMessage[],
  current: ChatMessage[],
  tools: ChatTool[],
  report?: (context: {
    tokens: number
    bytes: number
    messages: number
    omittedRounds: number
  }) => void,
  limits: { budget?: ContextBudget; scale?: number } = {},
) {
  const { budget = DEFAULT_BUDGET, scale = 1 } = limits
  const groups: ChatMessage[][] = []
  for (const message of history) {
    // Execution facts and images are supplementary user messages, not separate rounds.
    if (
      (message.role === 'user' &&
        typeof message.content === 'string' &&
        !message.content.startsWith('系统执行记录')) ||
      !groups.length
    )
      groups.push([])
    groups.at(-1)!.push(message)
  }
  const preamble = (typeof system === 'string' ? [system] : system).map((content): ChatMessage => ({
    role: 'system',
    content,
  }))
  let omitted = 0
  let cur = current
  const compressible = current
    .flatMap((m, i) => (m.role === 'tool' ? [i] : []))
    .slice(0, -KEEP_RECENT_TOOLS)
  let compressed = 0
  for (;;) {
    // 省略说明紧挨在保留下来的第一条历史之前：没有丢弃时它不存在，system 之后的前缀也就不变
    const messages: ChatMessage[] = [
      ...preamble,
      ...(omitted
        ? [
            {
              role: 'system' as const,
              // 文案固定、不含丢弃组数：丢弃组数不变时，system 之后的请求前缀逐字节稳定（利于提示缓存）；
              // 组数仍通过 report 的 omittedRounds 给界面
              content:
                '较早的若干组完整历史未发送，记录仍保留。不要假装记得省略的信息；必要时读取画布和任务。',
            },
          ]
        : []),
      ...groups.slice(omitted).flat(),
      ...cur,
    ]
    if (requestWithinBudget(messages, tools, budget, scale)) {
      const cost = textCost({ messages, tools })
      report?.({
        ...cost,
        tokens: cost.tokens + messages.length * 16,
        messages: messages.length,
        omittedRounds: omitted,
      })
      return messages
    }
    if (omitted < groups.length) {
      omitted++
      continue
    }
    if (compressed >= compressible.length)
      throw new CapabilityError(
        'context_budget_exhausted: 当前需求和工具交换已达到处理预算，已完成的操作保留，请缩小范围后继续',
      )
    const index = compressible[compressed++]!
    const old = cur[index]!
    cur = cur.slice()
    cur[index] = {
      ...old,
      content: `[较早的工具结果已省略以节省上下文：${old.toolName ?? '未知工具'}，原 ${contentLength(old)} 字符；需要时重新调用读取]`,
    }
  }
}
