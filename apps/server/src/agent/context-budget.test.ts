import type { AgentContext } from '@plein/protocol'
import type { ChatMessage } from '@plein/plugin-sdk'
import { beforeEach, describe, expect, it } from 'vite-plus/test'
import type { PluginHost } from '../plugins/host'
import { runBuiltinTurn } from './builtin'
import {
  CALIBRATION_MAX,
  CALIBRATION_MIN,
  calibrationOf,
  recordUsage,
  resetCalibration,
} from './calibration'
import { COMPACT_AT, compactThreshold, planCompaction, summarizeTurns } from './compaction'
import {
  budgetMessages,
  budgetOf,
  contextWindowOf,
  DEFAULT_BUDGET,
  outputReserve,
  requestWithinBudget,
  TEXT_BYTES,
  TEXT_TOKENS,
} from './context-budget'
import type { HistoryTurn } from './turn-store'

const turn = (i: number, size = 10): HistoryTurn => ({
  createdAt: i,
  messages: [
    { role: 'user', content: `第 ${i} 轮需求` },
    { role: 'assistant', content: `第 ${i} 轮回复${'x'.repeat(size)}` },
  ],
})

describe('budgetOf', () => {
  it('uses the default budget when the model declares no context window', () => {
    for (const spec of [undefined, {}, { maxOutputTokens: 4096 }, { contextWindow: 0 }]) {
      const budget = budgetOf(spec)
      expect(budget).toEqual({ tokens: TEXT_TOKENS, bytes: TEXT_BYTES, declared: false })
      expect(budget).toBe(DEFAULT_BUDGET)
    }
  })

  it('subtracts the output reserve from the declared window', () => {
    expect(budgetOf({ contextWindow: 128000 })).toMatchObject({
      tokens: 128000 - 8192,
      declared: true,
    })
    expect(budgetOf({ contextWindow: 128000, maxOutputTokens: 64000 }).tokens).toBe(128000 - 8192)
    // 模型最大输出小于 8192 时只预留它声明的量
    expect(budgetOf({ contextWindow: 32000, maxOutputTokens: 4096 }).tokens).toBe(32000 - 4096)
  })

  it('never lets the reserve eat more than half of a tiny window', () => {
    expect(outputReserve({ contextWindow: 8192 })).toBe(4096)
    expect(budgetOf({ contextWindow: 8192 }).tokens).toBe(4096)
  })

  it('derives bytes as max(256 KiB, tokens x 4) so a large window is not capped by 256 KiB', () => {
    expect(budgetOf({ contextWindow: 32000 }).bytes).toBe(TEXT_BYTES)
    const large = budgetOf({ contextWindow: 1_000_000 })
    expect(large.bytes).toBe((1_000_000 - 8192) * 4)
  })

  it('ignores invalid declarations', () => {
    expect(contextWindowOf({ contextWindow: -1, maxOutputTokens: Number.NaN })).toEqual({})
    expect(contextWindowOf({ contextWindow: 1000.9, maxOutputTokens: 10 })).toEqual({
      contextWindow: 1000,
      maxOutputTokens: 10,
    })
  })
})

describe('request budget', () => {
  const big = (n: number): ChatMessage => ({ role: 'user', content: 'x'.repeat(n) })

  it('a larger declared budget keeps history that the default budget omits', () => {
    const history = [big(300000), { role: 'assistant' as const, content: 'ok' }, big(10)]
    const current: ChatMessage[] = [{ role: 'user', content: 'now' }]
    const small = budgetMessages('s', history, current, [])
    expect(JSON.stringify(small)).toContain('未发送')
    const large = budgetMessages('s', history, current, [], undefined, {
      budget: budgetOf({ contextWindow: 1_000_000 }),
    })
    expect(JSON.stringify(large)).not.toContain('未发送')
    expect(
      large.flatMap((m) => (typeof m.content === 'string' ? [m.content.length] : [])),
    ).toContain(300000)
  })

  it('calibration scales the estimate but cannot exceed the budget', () => {
    const messages: ChatMessage[] = [big(40000)]
    const budget = { tokens: 10010, bytes: TEXT_BYTES, declared: true }
    // 估算约 10016 token：系数 1 超预算，0.9 放得下，上限本身不变
    expect(requestWithinBudget(messages, [], budget, 1)).toBe(false)
    expect(requestWithinBudget(messages, [], budget, 0.9)).toBe(true)
    expect(requestWithinBudget([big(80000)], [], budget, 0.9)).toBe(false)
  })

  it('bytes stay a hard sanity limit regardless of calibration', () => {
    const budget = { tokens: 1_000_000, bytes: 1000, declared: true }
    expect(requestWithinBudget([big(2000)], [], budget, 0.5)).toBe(false)
  })
})

describe('planCompaction thresholds', () => {
  const turns = (n: number, size: number) => Array.from({ length: n }, (_, i) => turn(i, size))
  // 每轮约 size / 4 token；10 轮共约 25000 token
  const history = turns(10, 10000)

  it('default compactAt is 0.6 of the budget, the same as the previous constant', () => {
    expect(compactThreshold(DEFAULT_BUDGET)).toBe(COMPACT_AT)
    expect(compactThreshold(DEFAULT_BUDGET, 0.5)).toBe(48000)
  })

  it('compacts once the estimate reaches the ratio of the budget', () => {
    const budget = { tokens: 40000, bytes: TEXT_BYTES, declared: true }
    // 约 25000 token：60% = 24000 触发，70% = 28000 不触发
    expect(planCompaction('s', undefined, history, [], { budget, compactAt: 0.6 })).toBeDefined()
    expect(planCompaction('s', undefined, history, [], { budget, compactAt: 0.7 })).toBeUndefined()
    expect(planCompaction('s', undefined, history, [], { budget })).toBeDefined()
  })

  it('a lower ratio compacts earlier and keeps less verbatim', () => {
    const budget = { tokens: 60000, bytes: TEXT_BYTES, declared: true }
    const at90 = planCompaction('s', undefined, history, [], { budget, compactAt: 0.9 })
    const at30 = planCompaction('s', undefined, history, [], { budget, compactAt: 0.3 })
    expect(at90).toBeUndefined()
    expect(at30).toBeDefined()
  })

  it("'off' never compacts, even far over the budget", () => {
    const budget = { tokens: 4000, bytes: TEXT_BYTES, declared: true }
    expect(planCompaction('s', undefined, history, [], { budget, compactAt: 0.3 })).toBeDefined()
    expect(
      planCompaction('s', undefined, history, [], { budget, compactAt: 'off' }),
    ).toBeUndefined()
  })

  it('applies the calibration scale to the estimate', () => {
    const budget = { tokens: 40000, bytes: TEXT_BYTES, declared: true }
    expect(
      planCompaction('s', undefined, history, [], { budget, compactAt: 0.6, scale: 0.5 }),
    ).toBeUndefined()
    expect(
      planCompaction('s', undefined, history, [], { budget, compactAt: 0.6, scale: 1 }),
    ).toBeDefined()
  })
})

describe('summarizeTurns budget', () => {
  const host = () => {
    const seen: ChatMessage[][] = []
    return {
      seen,
      host: {
        call: async (_c: string, _m: string, input: { messages: ChatMessage[] }) => {
          seen.push(input.messages)
          return { outputs: [{ type: 'text', text: '摘要' }] }
        },
      } as unknown as PluginHost,
    }
  }
  const base = { model: 'm', ownerId: 'o', signal: new AbortController().signal }

  const toolTurn = (i: number): HistoryTurn => ({
    createdAt: i,
    messages: [
      { role: 'user', content: `第 ${i} 轮需求` },
      { role: 'tool', toolCallId: `c${i}`, toolName: 'get_canvas', content: '画'.repeat(4000) },
    ],
  })

  it('clips tool results harder to fit a smaller model budget, and refuses when nothing fits', async () => {
    const turns = Array.from({ length: 12 }, (_, i) => toolTurn(i))
    const loose = host()
    await summarizeTurns({ ...base, host: loose.host, turns })
    const tight = host()
    await summarizeTurns({
      ...base,
      host: tight.host,
      turns,
      budget: { tokens: 6000, bytes: 256 * 1024, declared: true },
    })
    const size = (h: ReturnType<typeof host>) => (h.seen[0]!.at(-1)!.content as string).length
    expect(size(tight)).toBeLessThan(size(loose))
    await expect(
      summarizeTurns({
        ...base,
        host: host().host,
        turns,
        budget: { tokens: 100, bytes: 1000, declared: true },
      }),
    ).rejects.toThrow('无法在一次请求内压缩')
  })
})

describe('calibration', () => {
  beforeEach(resetCalibration)

  it('is 1 without samples and takes the first valid sample as is', () => {
    expect(calibrationOf('m')).toBe(1)
    expect(recordUsage('m', 1000, 700)).toBe(true)
    expect(calibrationOf('m')).toBeCloseTo(0.7)
  })

  it('blends later samples with alpha 0.3', () => {
    recordUsage('m', 1000, 700)
    recordUsage('m', 1000, 900)
    expect(calibrationOf('m')).toBeCloseTo(0.7 * 0.7 + 0.9 * 0.3)
  })

  it('ignores samples outside [0.4, 2] and invalid numbers', () => {
    recordUsage('m', 1000, 700)
    for (const reported of [300, 2500, 0, Number.NaN, -5])
      expect(recordUsage('m', 1000, reported)).toBe(false)
    expect(recordUsage('m', 0, 100)).toBe(false)
    expect(calibrationOf('m')).toBeCloseTo(0.7)
  })

  it('clamps the coefficient to [0.5, 1.2]', () => {
    recordUsage('low', 1000, 420)
    expect(calibrationOf('low')).toBe(CALIBRATION_MIN)
    recordUsage('high', 1000, 1900)
    expect(calibrationOf('high')).toBe(CALIBRATION_MAX)
  })

  it('keeps models apart', () => {
    recordUsage('a', 1000, 600)
    expect(calibrationOf('b')).toBe(1)
  })
})

describe('runBuiltinTurn budget wiring', () => {
  beforeEach(resetCalibration)
  const run = async (extra: Partial<Parameters<typeof runBuiltinTurn>[0]> = {}) => {
    const contexts: AgentContext[] = []
    const calls: Array<{ maxTokens?: number }> = []
    let usageRatio = 0.7
    const host = {
      call: async (_c: string, _m: string, input: { maxTokens?: number }) => {
        calls.push(input)
        const estimated = contexts.at(-1)!.tokens! / (calibrationOf('cal') || 1)
        return {
          outputs: [{ type: 'text', text: 'ok' }],
          usage: { inputTokens: Math.round(estimated * usageRatio) },
        }
      },
    } as unknown as PluginHost
    await runBuiltinTurn({
      host,
      model: 'cal',
      ownerId: 'o',
      system: 's',
      history: [],
      prompt: '你好',
      signal: new AbortController().signal,
      tools: [],
      onText: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onContext: (c) => contexts.push(c),
      ...extra,
    })
    return { contexts, calls, setRatio: (r: number) => (usageRatio = r) }
  }

  it('reports the model budget, bytes limit, compactAt and sends the output reserve', async () => {
    const budget = budgetOf({ contextWindow: 200000, maxOutputTokens: 4096 })
    const { contexts, calls } = await run({ budget, maxTokens: 4096, compactAt: 0.7 })
    expect(calls[0]!.maxTokens).toBe(4096)
    expect(contexts[0]).toMatchObject({
      source: 'estimate',
      limit: 200000 - 4096,
      bytesLimit: budget.bytes,
      limitDeclared: true,
      compactAt: 0.7,
    })
    expect(contexts[0]!.calibration).toBeUndefined()
  })

  it('falls back to the default budget and 0.6 for an undeclared model', async () => {
    const { contexts, calls } = await run()
    expect(calls[0]!.maxTokens).toBe(8192)
    expect(contexts[0]).toMatchObject({
      limit: TEXT_TOKENS,
      bytesLimit: TEXT_BYTES,
      limitDeclared: false,
      compactAt: 0.6,
    })
  })

  it('learns the coefficient from the provider report and applies it next time', async () => {
    const first = await run()
    // 同一请求的平台用量约为估算的 0.7：系数记下，随用量一起报告
    expect(first.contexts.at(-1)).toMatchObject({ source: 'provider' })
    expect(first.contexts.at(-1)!.calibration).toBeCloseTo(0.7, 1)
    // 下次估算显示按系数折算，仍低于预算
    const second = await run()
    expect(second.contexts[0]!.calibration).toBeCloseTo(0.7, 1)
    expect(second.contexts[0]!.tokens!).toBeLessThan(first.contexts[0]!.tokens!)
  })

  it('does not learn from inconsistent reports', async () => {
    const harness = await run()
    resetCalibration()
    const odd = await (async () => {
      const contexts: AgentContext[] = []
      const host = {
        call: async () => ({ outputs: [{ type: 'text', text: 'ok' }], usage: { inputTokens: 5 } }),
      } as unknown as PluginHost
      await runBuiltinTurn({
        host,
        model: 'cal',
        ownerId: 'o',
        system: 's',
        history: [],
        prompt: '你好',
        signal: new AbortController().signal,
        tools: [],
        onText: () => {},
        onToolStart: () => {},
        onToolEnd: () => {},
        onContext: (c) => contexts.push(c),
      })
      return contexts
    })()
    expect(harness.contexts.length).toBeGreaterThan(0)
    expect(odd.at(-1)!.calibration).toBeUndefined()
    expect(calibrationOf('cal')).toBe(1)
  })
})
