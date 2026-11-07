import type { ChatMessage, ChatTool } from '@plein/plugin-sdk'
import { CapabilityError } from '@plein/capabilities'

const encoder = new TextEncoder()
export const TEXT_BYTES = 256 * 1024
export const RESULT_BYTES = 32 * 1024
// 内置智能体带上全部画布能力，工具清单本身就占三万多 token；
// 预算要留得下这份清单，再给对话留出余量。
export const TEXT_TOKENS = 96000
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
export function requestWithinBudget(messages: ChatMessage[], tools: ChatTool[]) {
  const cost = textCost({ messages, tools })
  return cost.bytes <= TEXT_BYTES && cost.tokens + messages.length * 16 <= TEXT_TOKENS
}
/** 压缩本轮内容时保留原样的最近 tool 消息条数 */
const KEEP_RECENT_TOOLS = 2

const contentLength = (m: ChatMessage) =>
  typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length

/**
 * Complete user-led rounds only; history is never cut apart.
 * 历史丢完仍超预算时，从本轮最早的 tool 消息起把内容换成一行占位（消息本身保留，tool_call 与结果仍成对），
 * 最近 2 条 tool 消息与 assistant / user 消息不动。返回新数组，不改传入的消息。
 */
export function budgetMessages(
  system: string,
  history: ChatMessage[],
  current: ChatMessage[],
  tools: ChatTool[],
  report?: (context: {
    tokens: number
    bytes: number
    messages: number
    omittedRounds: number
  }) => void,
) {
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
  let omitted = 0
  let cur = current
  const compressible = current
    .flatMap((m, i) => (m.role === 'tool' ? [i] : []))
    .slice(0, -KEEP_RECENT_TOOLS)
  let compressed = 0
  for (;;) {
    // 省略说明紧挨在保留下来的第一条历史之前：没有丢弃时它不存在，system 之后的前缀也就不变
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
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
    if (requestWithinBudget(messages, tools)) {
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
