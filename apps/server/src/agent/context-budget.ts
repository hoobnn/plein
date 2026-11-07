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
/** Complete user-led rounds only; current tool exchanges are never cut apart. */
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
  for (;;) {
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      ...(omitted
        ? [
            {
              role: 'system' as const,
              content: `较早的 ${omitted} 组完整历史未发送，记录仍保留。不要假装记得省略的信息；必要时读取画布和任务。`,
            },
          ]
        : []),
      ...groups.slice(omitted).flat(),
      ...current,
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
    if (omitted >= groups.length)
      throw new CapabilityError(
        'context_budget_exhausted: 当前需求和工具交换已达到处理预算，已完成的操作保留，请缩小范围后继续',
      )
    omitted++
  }
}
