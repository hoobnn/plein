import Database from 'better-sqlite3'
import { ProviderError, type ChatMessage, type ProviderOutput } from '@plein/plugin-sdk'
import { describe, expect, it } from 'vite-plus/test'
import type { PluginHost } from '../plugins/host'
import { wrapDb } from '../storage/db'
import { agentSessions, agentTurns, canvases } from '../storage/schema'
import { TurnExecution } from './execution'
import { TurnStore } from './turn-store'
import { MAX_STEPS, runBuiltinTurn } from './builtin'
import { budgetMessages, RESULT_BYTES, TEXT_TOKENS, truncateResultText } from './context-budget'
import { toToolResult } from './mcp'
import { content } from '@plein/capabilities'
import { z } from 'zod'

describe('turn identity and durable facts', () => {
  it('fails closed when execution facts cannot be saved, before the side effect starts', async () => {
    const turn = new TurnExecution(
      'storage-failure',
      () => true,
      () => {
        throw new Error('disk unavailable')
      },
    )
    let executed = false
    await expect(
      turn.invoke('write', {}, async () => {
        executed = true
        return 'done'
      }),
    ).rejects.toThrow('disk unavailable')
    expect(executed).toBe(false)
    expect(turn.state).toBe('failed')
    expect(() => turn.assertOpen()).toThrow('turn_closed')
  })
  it('limits tools separately from model steps and does not execute the rejected call', async () => {
    const turn = new TurnExecution(
      'budget',
      () => true,
      () => {},
    )
    let writes = 0
    for (let i = 0; i < 100; i++)
      await turn.invoke('read', {}, async () => {
        writes++
        return 'done'
      })
    await expect(
      turn.invoke('one-more', {}, async () => {
        writes++
        return 'unexpected'
      }),
    ).rejects.toThrow('tool_budget_exhausted')
    expect(writes).toBe(100)
    expect(turn.facts.toolCalls).toBe(100)
  })
  it('rejects stale generations and queued writes after stop, preserves started uncertainty', async () => {
    let active: TurnExecution | null = null
    const first = new TurnExecution(
      'one',
      () => active === first,
      () => {},
    )
    active = first
    let finish!: () => void,
      writes = 0
    const pending = first.serialize(() =>
      first.invoke('write', {}, async () => {
        await new Promise<void>((resolve) => {
          finish = resolve
        })
        first.assertOpen()
        writes++
        return 'done'
      }),
    )
    await Promise.resolve()
    await Promise.resolve()
    first.close('stopped')
    const second = new TurnExecution(
      'two',
      () => active === second,
      () => {},
    )
    active = second
    expect(first.token).not.toBe(second.token)
    finish()
    await expect(pending).rejects.toThrow('turn_closed')
    expect(writes).toBe(0)
    expect(first.facts.calls[0]?.status).toBe('outcome_unknown')
    expect(() => first.assertOpen()).toThrow('turn_closed')
    second.assertOpen()
  })
  it('reconciles interrupted exchanges without executing work, keeps references and approval facts', () => {
    const db = wrapDb(new Database(':memory:'))
    db.insert(canvases)
      .values({ id: 'canvas', owner_id: 'local', title: 'test', created_at: 1, updated_at: 1 })
      .run()
    db.insert(agentSessions)
      .values({
        id: 'session',
        canvas_id: 'canvas',
        owner_id: 'local',
        agent: 'builtin',
        title: 'test',
        items: '[]',
        created_at: 1,
        updated_at: 1,
      })
      .run()
    const store = new TurnStore(db)
    const turn = new TurnExecution(
      'turn',
      () => true,
      (t) => store.save(t),
    )
    store.begin('session', turn)
    turn.append({ role: 'user', content: '只改文字' })
    turn.append({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call', name: 'create_node', arguments: {} }],
    })
    turn.facts.calls.push({ id: 'call', name: 'create_node', args: {}, status: 'started' })
    turn.facts.approvals.push({
      id: 'approval',
      tool: 'propose_edit',
      status: 'approved',
      choice: { scope: 'text', skip: ['video'] },
    })
    turn.facts.runs.push({ nodeId: 'n', runId: 'existing' })
    turn.persist()
    store.reconcile()
    expect(store.last('session')).toMatchObject({
      state: 'interrupted',
      runs: [{ nodeId: 'n', runId: 'existing' }],
    })
    const history = store.history('session')
    const historicalId = history.find((m) => m.role === 'tool')?.toolCallId
    expect(historicalId).toMatch(/^call_[a-f0-9]{32}$/)
    expect(historicalId).toBe(history.find((m) => m.toolCalls?.length)?.toolCalls?.[0]?.id)
    expect(JSON.stringify(history)).toContain('interrupted_outcome_unknown')
    expect(JSON.stringify(history)).toContain('video')
    expect(db.select().from(agentTurns).all()).toHaveLength(1)
    db.$client.close()
  })
})

describe('builtin context and media', () => {
  it('returns an over-budget image call as a tool error and does not count rejected images', async () => {
    let requests = 0,
      saved = 0
    const seen: ChatMessage[][] = []
    const host = {
      call: async (_c: string, _m: string, input: { messages: ChatMessage[] }) => {
        requests++
        seen.push(structuredClone(input.messages))
        return {
          outputs:
            requests <= 2
              ? [
                  {
                    type: 'tool_calls',
                    calls: [
                      { id: `c${requests}`, name: requests === 1 ? 'nine' : 'one', arguments: {} },
                    ],
                  },
                ]
              : [{ type: 'text', text: 'done' }],
        }
      },
    } as unknown as PluginHost
    const image = { type: 'image' as const, data: 'AQID', mimeType: 'image/png' }
    await runBuiltinTurn({
      host,
      model: 'vision',
      ownerId: 'local',
      system: '',
      history: [],
      prompt: 'look',
      signal: new AbortController().signal,
      vision: true,
      saveImage: async () => {
        saved++
        return { assetId: 'preview', kind: 'image' }
      },
      tools: [
        {
          name: 'nine',
          description: '',
          input: z.object({}),
          run: () => ({ content: Array.from({ length: 9 }, () => image) }),
        },
        { name: 'one', description: '', input: z.object({}), run: () => ({ content: [image] }) },
      ],
      onText: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
    })
    // 第一个调用被整体拒绝且不计入用量，所以紧接着的单张图片仍然可以通过
    expect(requests).toBe(3)
    expect(saved).toBe(1)
    const rejected = seen[1]!.find((m) => m.role === 'tool')!
    expect(rejected.content).toContain('media_budget_exhausted')
    expect(rejected.content).toContain('出错：')
    expect(rejected.content).toContain('9 张')
    expect(seen[2]!.some((m) => m.role === 'user' && Array.isArray(m.content))).toBe(true)
  })
  it('reports oversized single images and totals as tool errors', async () => {
    const big = 'A'.repeat(Math.ceil((1024 * 1024 * 4) / 3) + 8)
    const seen: ChatMessage[][] = []
    const host = {
      call: async (_c: string, _m: string, input: { messages: ChatMessage[] }) => {
        seen.push(structuredClone(input.messages))
        return {
          outputs:
            seen.length === 1
              ? [{ type: 'tool_calls', calls: [{ id: 'b', name: 'big', arguments: {} }] }]
              : [{ type: 'text', text: 'done' }],
        }
      },
    } as unknown as PluginHost
    await runBuiltinTurn({
      ...quietTurn(host),
      vision: true,
      saveImage: async () => ({ assetId: 'preview', kind: 'image' }),
      tools: [
        {
          name: 'big',
          description: '',
          input: z.object({}),
          run: () => ({ content: [{ type: 'image', data: big, mimeType: 'image/png' }] }),
        },
      ],
    })
    expect(seen[1]!.find((m) => m.role === 'tool')!.content).toContain('单张图片超限')
  })
  it('answers unknown tools with the closest names', async () => {
    const seen: ChatMessage[][] = []
    const host = {
      call: async (_c: string, _m: string, input: { messages: ChatMessage[] }) => {
        seen.push(structuredClone(input.messages))
        return {
          outputs:
            seen.length === 1
              ? [{ type: 'tool_calls', calls: [{ id: 'u', name: 'get_canvs', arguments: {} }] }]
              : [{ type: 'text', text: 'done' }],
        }
      },
    } as unknown as PluginHost
    const tool = (name: string) => ({
      name,
      description: '',
      input: z.object({}),
      run: () => 'x',
    })
    await runBuiltinTurn(
      quietTurn(host, {
        tools: [
          'get_canvas',
          'get_canvas_page',
          'list_canvases',
          'delete_elements',
          'run_node',
        ].map(tool),
      }),
    )
    const text = seen[1]!.find((m) => m.role === 'tool')!.content as string
    expect(text).toContain('没有工具 get_canvs；最接近的有：get_canvas、')
    expect(text).toContain('list_canvas_capabilities')
    expect(text).not.toContain('delete_elements')
  })
  it('drops only complete older history and rejects oversized current exchanges', () => {
    // 旧历史要撑破预算才会被丢掉；大小跟着预算走，不写死数字
    const big = 'old'.repeat(TEXT_TOKENS)
    const history: ChatMessage[] = [
      { role: 'user', content: big },
      { role: 'assistant', content: '', toolCalls: [{ id: 'old', name: 'x', arguments: {} }] },
      { role: 'tool', toolCallId: 'old', toolName: 'x', content: 'done' },
    ]
    const current: ChatMessage[] = [{ role: 'user', content: 'new' }]
    const result = budgetMessages('system', history, current, [])
    expect(result.some((m) => m.toolCallId === 'old')).toBe(false)
    expect(result.at(-1)).toEqual(current[0])
    expect(() =>
      budgetMessages('', [], [{ role: 'user', content: '中'.repeat(TEXT_TOKENS) }], []),
    ).toThrow('context_budget_exhausted')
  })
  it('sends vision images after the entire tool group and persists refs rather than base64', async () => {
    const sent: ChatMessage[][] = []
    const host = {
      call: async (_cap: string, _model: string, input: { messages: ChatMessage[] }) => {
        sent.push(structuredClone(input.messages))
        const outputs: ProviderOutput[] =
          sent.length === 1
            ? [
                {
                  type: 'tool_calls',
                  calls: [
                    { id: 'image', name: 'view_media', arguments: {} },
                    { id: 'read', name: 'read', arguments: {} },
                  ],
                },
              ]
            : [{ type: 'text', text: 'done' }]
        return { outputs }
      },
    } as unknown as PluginHost
    const t = new TurnExecution(
      'vision',
      () => true,
      () => {},
    )
    t.append({ role: 'user', content: 'look' })
    await runBuiltinTurn({
      host,
      model: 'vision',
      ownerId: 'local',
      system: '',
      history: [],
      prompt: 'look',
      execution: t,
      signal: t.abort.signal,
      vision: true,
      saveImage: async () => ({ assetId: 'preview', kind: 'image' }),
      tools: [
        {
          name: 'view_media',
          description: '',
          input: z.object({}),
          run: () => ({
            content: [
              { type: 'text', text: 'source_asset_id=source; 1.0 秒' },
              { type: 'image', data: 'AQID', mimeType: 'image/png' },
            ],
          }),
        },
        { name: 'read', description: '', input: z.object({}), run: () => 'other' },
      ],
      onText: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
    })
    const second = sent[1]!
    expect(second.slice(-3).map((m) => m.role)).toEqual(['tool', 'tool', 'user'])
    expect(JSON.stringify(second)).toContain('preview')
    expect(JSON.stringify(t.transcript)).not.toContain('AQID')
    expect(JSON.stringify(t.transcript)).toContain('1.0 秒')
  })
  it('truncates oversized tool results instead of dropping them and rejects unsupported vision', async () => {
    const captured: ChatMessage[][] = []
    const host = {
      call: async (_c: string, _m: string, input: { messages: ChatMessage[] }) => {
        captured.push(structuredClone(input.messages))
        return {
          outputs:
            captured.length === 1
              ? [
                  {
                    type: 'tool_calls',
                    calls: [
                      { id: 'large', name: 'large', arguments: {} },
                      { id: 'image', name: 'image', arguments: {} },
                    ],
                  },
                ]
              : [{ type: 'text', text: 'done' }],
        }
      },
    } as unknown as PluginHost
    await runBuiltinTurn({
      host,
      model: 'text',
      ownerId: 'local',
      system: '',
      history: [],
      prompt: 'look',
      signal: new AbortController().signal,
      tools: [
        {
          name: 'large',
          description: '',
          input: z.object({}),
          run: () => JSON.stringify({ text: 'x'.repeat(RESULT_BYTES + 100) }),
        },
        {
          name: 'image',
          description: '',
          input: z.object({}),
          run: () => ({ content: [{ type: 'image', data: 'AQID', mimeType: 'image/png' }] }),
        },
      ],
      onText: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
    })
    const messages = captured[1]!.filter((m) => m.role === 'tool')
    const large = messages[0]!.content as string
    expect(large).toContain('结果已截断')
    expect(large).toContain('get_canvas_page')
    expect(Buffer.byteLength(large)).toBeLessThanOrEqual(RESULT_BYTES)
    expect(large.startsWith('{"text":"xxx')).toBe(true)
    expect(messages[1]!.content).toContain('vision_unsupported')
  })
})

const quietTurn = (host: unknown, extra: Partial<Parameters<typeof runBuiltinTurn>[0]> = {}) =>
  ({
    host: host as PluginHost,
    model: 'm',
    ownerId: 'local',
    system: '',
    history: [],
    prompt: 'go',
    signal: new AbortController().signal,
    tools: [],
    retryDelaysMs: [1, 1, 1],
    onText: () => {},
    onToolStart: () => {},
    onToolEnd: () => {},
    ...extra,
  }) satisfies Parameters<typeof runBuiltinTurn>[0]

describe('builtin model call retry', () => {
  it('retries rate limits, clears streamed text and counts retries in facts', async () => {
    let calls = 0
    const texts: string[] = []
    const host = {
      call: async (_c: string, _m: string, _i: unknown, o: { onDelta: (d: string) => void }) => {
        calls++
        if (calls < 3) {
          o.onDelta('半截')
          throw new ProviderError('rate_limit', '限流')
        }
        return { outputs: [{ type: 'text', text: 'ok' }] as ProviderOutput[] }
      },
    } as unknown as PluginHost
    const t = new TurnExecution(
      'retry',
      () => true,
      () => {},
    )
    t.append({ role: 'user', content: 'go' })
    await runBuiltinTurn(quietTurn(host, { execution: t, onText: (_k, text) => texts.push(text) }))
    expect(calls).toBe(3)
    expect(t.facts.retries).toBe(2)
    expect(texts).toEqual(['半截', '', '半截', '', 'ok'])
    expect(JSON.parse(JSON.stringify(t.facts)).retries).toBe(2)
  })
  it('retries retryable errors but not auth, and gives up after three retries', async () => {
    let calls = 0
    const always = (err: ProviderError) =>
      ({
        call: async () => {
          calls++
          throw err
        },
      }) as unknown as PluginHost
    await expect(
      runBuiltinTurn(quietTurn(always(new ProviderError('auth', '密钥无效')))),
    ).rejects.toThrow('密钥无效')
    expect(calls).toBe(1)
    calls = 0
    await expect(
      runBuiltinTurn(quietTurn(always(new ProviderError('unknown', '抖动', { retryable: true })))),
    ).rejects.toThrow('抖动')
    expect(calls).toBe(4)
  })
  it('stops waiting when the signal aborts', async () => {
    const abort = new AbortController()
    let calls = 0
    const host = {
      call: async () => {
        calls++
        abort.abort()
        throw new ProviderError('timeout', '超时')
      },
    } as unknown as PluginHost
    await runBuiltinTurn(quietTurn(host, { signal: abort.signal, retryDelaysMs: [60_000] }))
    expect(calls).toBe(1)
  })
})

describe('tool result truncation', () => {
  it('cuts on a character boundary, stays within the limit and is idempotent', () => {
    const text = '中'.repeat(RESULT_BYTES)
    const out = truncateResultText(text)
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(RESULT_BYTES)
    expect(out).not.toContain('\ufffd')
    expect(out).toContain(`原 ${Math.ceil((RESULT_BYTES * 3) / 1024)} KiB，保留前 32 KiB`)
    expect(truncateResultText(out)).toBe(out)
    expect(truncateResultText('short')).toBe('short')
  })
  it('toToolResult truncates strings and content blocks, keeping images', () => {
    const big = 'a'.repeat(RESULT_BYTES + 10)
    expect(String(toToolResult(big))).toContain('结果已截断')
    const r = toToolResult(
      content([
        { type: 'text', text: big },
        { type: 'image', data: 'AQID', mimeType: 'image/png' },
      ]),
    ) as { isError?: boolean; content: Array<{ type: string; text?: string }> }
    expect(r.isError).toBeUndefined()
    expect(r.content[0]!.text).toContain('结果已截断')
    expect(r.content[1]!.type).toBe('image')
    expect(toToolResult(big, Infinity)).toBe(big)
  })
})

describe('builtin empty replies and wrap-up', () => {
  const textOut = (text: string): ProviderOutput[] => [{ type: 'text', text }]
  const scripted = (...replies: ProviderOutput[][]) => {
    let i = 0
    return {
      requests: () => i,
      host: {
        call: async () => ({ outputs: replies[Math.min(i++, replies.length - 1)] }),
      } as unknown as PluginHost,
    }
  }
  it('retries an empty first reply once, then fails with a readable error', async () => {
    const ok = scripted([], textOut('好'))
    await runBuiltinTurn(quietTurn(ok.host))
    expect(ok.requests()).toBe(2)
    const bad = scripted([], [])
    await expect(runBuiltinTurn(quietTurn(bad.host))).rejects.toMatchObject({
      code: 'unknown',
      message: '模型没有返回内容，请重试或换一个模型',
    })
    expect(bad.requests()).toBe(2)
  })
  it('treats an empty reply after tool calls as a normal finish', async () => {
    const s = scripted(
      [{ type: 'tool_calls', calls: [{ id: 'a', name: 'read', arguments: {} }] }],
      [],
    )
    await runBuiltinTurn(
      quietTurn(s.host, {
        tools: [{ name: 'read', description: '', input: z.object({}), run: () => 'x' }],
      }),
    )
    expect(s.requests()).toBe(2)
  })
  it('warns with three steps left, only in that request, and keeps the step limit error', async () => {
    const sent: ChatMessage[][] = []
    let n = 0
    const host = {
      call: async (_c: string, _m: string, input: { messages: ChatMessage[] }) => {
        sent.push(structuredClone(input.messages))
        return {
          outputs: [
            { type: 'tool_calls', calls: [{ id: `c${n++}`, name: 'read', arguments: {} }] },
          ] as ProviderOutput[],
        }
      },
    } as unknown as PluginHost
    const t = new TurnExecution(
      'steps',
      () => true,
      () => {},
    )
    t.append({ role: 'user', content: 'go' })
    await expect(
      runBuiltinTurn(
        quietTurn(host, {
          execution: t,
          signal: t.abort.signal,
          tools: [{ name: 'read', description: '', input: z.object({}), run: () => 'x' }],
        }),
      ),
    ).rejects.toThrow('接着做')
    expect(sent).toHaveLength(MAX_STEPS)
    const warned = sent.flatMap((m, i) =>
      m.at(-1)?.content?.toString().startsWith('系统提示：') ? [i] : [],
    )
    expect(warned).toEqual([MAX_STEPS - 3])
    expect(JSON.stringify(t.transcript)).not.toContain('系统提示：')
  })
})

describe('budgetMessages in-turn compression', () => {
  const exchange = (id: string, size: number): ChatMessage[] => [
    { role: 'assistant', content: '', toolCalls: [{ id, name: 'read', arguments: {} }] },
    { role: 'tool', toolCallId: id, toolName: 'read', content: id + '中'.repeat(size) },
  ]
  it('replaces earliest tool results one at a time, keeping pairs, recent tools and inputs intact', () => {
    const per = 15000
    const current: ChatMessage[] = [
      { role: 'user', content: 'go' },
      ...exchange('a', per),
      ...exchange('b', per),
      ...exchange('c', per),
      ...exchange('d', per),
    ]
    const snapshot = structuredClone(current)
    const out = budgetMessages('s', [], current, [])
    expect(current).toEqual(snapshot)
    const tools = out.filter((m) => m.role === 'tool')
    expect(tools).toHaveLength(4)
    expect(tools[0]!.content).toBe(
      `[较早的工具结果已省略以节省上下文：read，原 ${per + 1} 字符；需要时重新调用读取]`,
    )
    expect(tools[0]!.toolCallId).toBe('a')
    // 每替换一条就重新评估，够用就停：b 仍是原文；最近两条、assistant 与 user 消息原样保留
    expect(tools.slice(1).map((m) => (m.content as string).length)).toEqual([
      per + 1,
      per + 1,
      per + 1,
    ])
    expect(out.filter((m) => m.role === 'assistant')).toHaveLength(4)
    expect(out.find((m) => m.role === 'user')!.content).toBe('go')
  })
  it('still throws when nothing more can be compressed', () => {
    // 最近两条 tool 消息本身就超预算，压缩更早的也救不回来
    const current: ChatMessage[] = [
      { role: 'user', content: 'go' },
      ...exchange('a', TEXT_TOKENS),
      ...exchange('b', TEXT_TOKENS),
      ...exchange('c', TEXT_TOKENS),
    ]
    expect(() => budgetMessages('s', [], current, [])).toThrow('context_budget_exhausted')
  })
})
