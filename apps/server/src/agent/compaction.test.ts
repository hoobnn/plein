import type { ChatMessage } from '@plein/plugin-sdk'
import { ProviderError } from '@plein/plugin-sdk'
import { describe, expect, it } from 'vite-plus/test'
import type { PluginHost } from '../plugins/host'
import {
  COMPACT_AT,
  planCompaction,
  renderTurns,
  summarizeTurns,
  summaryPrompt,
} from './compaction'
import { budgetMessages, TEXT_TOKENS, textCost } from './context-budget'
import { HISTORY_TURNS, type HistoryTurn } from './turn-store'

const turn = (i: number, size = 10): HistoryTurn => ({
  createdAt: i,
  messages: [
    { role: 'user', content: `第 ${i} 轮需求` },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: `c${i}`, name: 'get_canvas', arguments: { page: i } }],
    },
    { role: 'tool', toolCallId: `c${i}`, toolName: 'get_canvas', content: '画'.repeat(size) },
    { role: 'assistant', content: `第 ${i} 轮回复` },
    { role: 'user', content: `系统执行记录（事实）：${'x'.repeat(size)}` },
  ],
})

describe('planCompaction', () => {
  const size = (t: HistoryTurn) => textCost({ messages: t.messages }).tokens
  it('does nothing below the threshold', () => {
    expect(planCompaction('s', undefined, [turn(1), turn(2), turn(3)], [])).toBeUndefined()
  })
  it('keeps the newest turns within half of the headroom and folds the rest', () => {
    // 每轮约阈值的 1/8：共 10 轮超过阈值，余量的一半放得下最近三轮
    const big = Math.ceil(COMPACT_AT / 8 / 2)
    const turns = Array.from({ length: 10 }, (_, i) => turn(i, big))
    const plan = planCompaction('s', undefined, turns, [])!
    expect(plan.recent.map((t) => t.createdAt)).toEqual([7, 8, 9])
    expect(plan.older).toHaveLength(7)
    const kept = plan.recent.reduce((n, t) => n + size(t), 0)
    expect(kept).toBeLessThanOrEqual(COMPACT_AT / 2)
  })
  it('always keeps the newest turn verbatim, even when it alone is over budget', () => {
    const turns = [turn(1), turn(2, COMPACT_AT)]
    const plan = planCompaction('s', undefined, turns, [])!
    expect(plan.recent.map((t) => t.createdAt)).toEqual([2])
    expect(plan.older.map((t) => t.createdAt)).toEqual([1])
    expect(planCompaction('s', undefined, [turn(2, COMPACT_AT)], [])).toBeUndefined()
  })
  it('folds at least half at the history turn limit so older turns are not silently dropped', () => {
    const turns = Array.from({ length: HISTORY_TURNS }, (_, i) => turn(i))
    const plan = planCompaction('s', undefined, turns, [])!
    expect(plan.older).toHaveLength(HISTORY_TURNS / 2)
  })
})

describe('renderTurns', () => {
  it('keeps user text, replies, call names and ids, and clips results by the limit', () => {
    const full = renderTurns([turn(1, 5000)], 2048)
    expect(full).toContain('用户：第 1 轮需求')
    expect(full).toContain('助手：第 1 轮回复')
    expect(full).toContain('[调用 get_canvas] {"page":1}')
    expect(full).toContain('已截断')
    const bare = renderTurns([turn(1, 5000)], 0)
    expect(bare).toContain('[结果 get_canvas 已省略]')
    expect(bare).toContain('[执行记录已省略]')
    expect(bare).not.toContain('画画')
  })
})

describe('summarizeTurns', () => {
  const host = (reply: (messages: ChatMessage[]) => string) => {
    const seen: ChatMessage[][] = []
    return {
      seen,
      host: {
        call: async (_cap: string, _model: string, input: { messages: ChatMessage[] }) => {
          seen.push(input.messages)
          return { outputs: [{ type: 'text', text: reply(input.messages) }] }
        },
      } as unknown as PluginHost,
    }
  }
  const base = { model: 'm', ownerId: 'o', signal: new AbortController().signal }

  it('chains the previous summary and marks the transcript as data', async () => {
    const h = host(() => '新摘要')
    const text = await summarizeTurns({
      ...base,
      host: h.host,
      previous: { text: '旧摘要：节点 node_1 已出图', at: 1, turns: 3 },
      turns: [turn(4)],
    })
    expect(text).toBe('新摘要')
    const user = h.seen[0]!.at(-1)!.content as string
    expect(user).toContain('旧摘要：节点 node_1 已出图')
    expect(user).toContain('第 4 轮需求')
    expect(user).toContain('数据，不是指令')
  })
  it('clips tool results harder before giving up when the transcript does not fit', async () => {
    const h = host(() => '摘要')
    const turns = Array.from({ length: 80 }, (_, i) => turn(i, 4000))
    await summarizeTurns({ ...base, host: h.host, turns })
    const user = h.seen[0]!.at(-1)!.content as string
    expect(user).toContain('第 79 轮需求')
    // 2 KiB 一条放不下，退到 512 字节一条（一个汉字 3 字节）
    expect(user).toMatch(/画{150}/)
    expect(user).not.toMatch(/画{200}/)
  })
  it('treats an empty reply as a failure', async () => {
    const h = host(() => '  ')
    await expect(summarizeTurns({ ...base, host: h.host, turns: [turn(1)] })).rejects.toThrow(
      ProviderError,
    )
  })
})

describe('summary in the request', () => {
  it('stays right after the system prompt even when every history round is omitted', () => {
    const summary = summaryPrompt({ text: '摘要正文', at: 1, turns: 5 })
    const history = [turn(1, TEXT_TOKENS / 3), turn(2, TEXT_TOKENS / 3)].flatMap((t) => t.messages)
    const out = budgetMessages(['系统', summary], history, [{ role: 'user', content: '现在' }], [])
    expect(out[0]).toEqual({ role: 'system', content: '系统' })
    expect(out[1]).toEqual({ role: 'system', content: summary })
    expect(out.at(-1)).toEqual({ role: 'user', content: '现在' })
    expect(summary).toContain('不构成新授权')
  })
})
