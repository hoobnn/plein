import Database from 'better-sqlite3'
import type { ChatMessage, ProviderOutput } from '@plein/plugin-sdk'
import { describe, expect, it } from 'vite-plus/test'
import type { PluginHost } from '../plugins/host'
import { wrapDb } from '../storage/db'
import { agentSessions, agentTurns, canvases } from '../storage/schema'
import { TurnExecution } from './execution'
import { TurnStore } from './turn-store'
import { runBuiltinTurn } from './builtin'
import { budgetMessages, RESULT_BYTES, TEXT_TOKENS } from './context-budget'
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
  it('refuses the ninth image before another model request', async () => {
    let requests = 0,
      saved = 0
    const host = {
      call: async () => {
        requests++
        return {
          outputs: [{ type: 'tool_calls', calls: [{ id: 'nine', name: 'images', arguments: {} }] }],
        }
      },
    } as unknown as PluginHost
    await expect(
      runBuiltinTurn({
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
            name: 'images',
            description: '',
            input: z.object({}),
            run: () => ({
              content: Array.from({ length: 9 }, () => ({
                type: 'image' as const,
                data: 'AQID',
                mimeType: 'image/png',
              })),
            }),
          },
        ],
        onText: () => {},
        onToolStart: () => {},
        onToolEnd: () => {},
      }),
    ).rejects.toThrow('media_budget_exhausted')
    expect(requests).toBe(1)
    expect(saved).toBe(8)
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
  it('keeps oversized tool JSON valid and explicitly rejects unsupported vision', async () => {
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
    expect(JSON.parse(messages[0]!.content as string)).toMatchObject({
      error: 'tool_result_too_large',
    })
    expect(messages[1]!.content).toContain('vision_unsupported')
  })
})
