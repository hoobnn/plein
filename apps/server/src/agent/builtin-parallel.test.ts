import type { ChatMessage, ProviderOutput } from '@plein/plugin-sdk'
import { describe, expect, it } from 'vite-plus/test'
import { z } from 'zod'
import type { PluginHost } from '../plugins/host'
import { runBuiltinTurn, toolBatches } from './builtin'
import { TurnExecution } from './execution'
import { defineTool, type McpTool } from './mcp'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 第一次回复给出这些调用，之后回复文字 */
const scripted = (calls: Array<{ id: string; name: string }>) => {
  let n = 0
  return {
    call: async (): Promise<{ outputs: ProviderOutput[] }> =>
      n++ === 0
        ? {
            outputs: [{ type: 'tool_calls', calls: calls.map((c) => ({ ...c, arguments: {} })) }],
          }
        : { outputs: [{ type: 'text', text: 'done' }] },
  } as unknown as PluginHost
}

const turn = (host: PluginHost, tools: McpTool[], extra = {}) => ({
  host,
  model: 'm',
  ownerId: 'local',
  system: '',
  history: [],
  prompt: 'go',
  signal: new AbortController().signal,
  tools,
  onText: () => {},
  onToolStart: () => {},
  onToolEnd: () => {},
  ...extra,
})

const tool = (name: string, readOnly: boolean, run: () => Promise<string>) =>
  defineTool({
    name,
    description: '',
    input: z.object({}),
    ...(readOnly ? { annotations: { readOnlyHint: true } } : {}),
    run,
  })

describe('builtin parallel read-only tools', () => {
  it('runs consecutive read-only calls concurrently', async () => {
    const slow = tool('slow', true, async () => {
      await wait(150)
      return 'ok'
    })
    const started = Date.now()
    await runBuiltinTurn(
      turn(
        scripted([
          { id: 'a', name: 'slow' },
          { id: 'b', name: 'slow' },
          { id: 'c', name: 'slow' },
        ]),
        [slow],
      ),
    )
    // 三个串行要 450ms；并发约等于单个
    expect(Date.now() - started).toBeLessThan(300)
  })

  it('never overlaps a write with reads and keeps batches in order', async () => {
    const log: string[] = []
    let active = 0
    let writeOverlap = false
    const read = (name: string) =>
      tool(name, true, async () => {
        log.push(`start ${name}`)
        active++
        await wait(60)
        active--
        log.push(`end ${name}`)
        return name
      })
    const write = tool('write', false, async () => {
      log.push('start write')
      if (active > 0) writeOverlap = true
      active++
      await wait(30)
      active--
      log.push('end write')
      return 'w'
    })
    await runBuiltinTurn(
      turn(
        scripted([
          { id: '1', name: 'r1' },
          { id: '2', name: 'r2' },
          { id: '3', name: 'write' },
          { id: '4', name: 'r3' },
          { id: '5', name: 'unknown_tool' },
        ]),
        [read('r1'), read('r2'), write, read('r3')],
      ),
    )
    expect(writeOverlap).toBe(false)
    // r1 与 r2 同批并发；写入在它们都结束后才开始；r3 在写入结束后才开始
    expect(log.indexOf('start r2')).toBeLessThan(log.indexOf('end r1'))
    expect(log.indexOf('start write')).toBeGreaterThan(log.indexOf('end r2'))
    expect(log.indexOf('start r3')).toBeGreaterThan(log.indexOf('end write'))
  })

  it('appends results in tool call order even when the first call finishes last', async () => {
    const delays: Record<string, number> = { first: 120, second: 10, third: 60 }
    const tools = Object.keys(delays).map((name) =>
      tool(name, true, async () => {
        await wait(delays[name]!)
        return `result-${name}`
      }),
    )
    const t = new TurnExecution(
      'order',
      () => true,
      () => {},
    )
    t.append({ role: 'user', content: 'go' })
    const started: string[] = []
    const ended: string[] = []
    await runBuiltinTurn(
      turn(
        scripted([
          { id: 'x1', name: 'first' },
          { id: 'x2', name: 'second' },
          { id: 'x3', name: 'third' },
        ]),
        tools,
        {
          execution: t,
          onToolStart: (c: { id: string }) => started.push(c.id),
          onToolEnd: (c: { id: string }) => ended.push(c.id),
        },
      ),
    )
    const results = t.transcript.filter((m: ChatMessage) => m.role === 'tool')
    expect(results.map((m) => m.toolCallId)).toEqual(['x1', 'x2', 'x3'])
    expect(results.map((m) => m.content)).toEqual(['result-first', 'result-second', 'result-third'])
    expect(started).toEqual(['x1', 'x2', 'x3'])
    expect(ended).toEqual(['x1', 'x2', 'x3'])
  })

  it('treats unknown tools as non-read-only', () => {
    const byName = new Map(
      [tool('r', true, async () => ''), tool('w', false, async () => '')].map((x) => [x.name, x]),
    )
    const c = (name: string, id: string) => ({ id, name, arguments: {} })
    const batches = toolBatches(
      [
        c('r', '1'),
        c('r', '2'),
        c('nope', '3'),
        c('r', '4'),
        c('w', '5'),
        c('w', '6'),
        c('r', '7'),
      ],
      byName,
    )
    expect(batches.map((b) => b.map((x) => x.name))).toEqual([
      ['r', 'r'],
      ['nope'],
      ['r'],
      ['w'],
      ['w'],
      ['r'],
    ])
  })

  it('records facts under the right call id when invocations overlap', async () => {
    const t = new TurnExecution(
      'facts',
      () => true,
      () => {},
    )
    await Promise.all([
      t.invoke('slow', {}, async () => (await wait(40), 'a'), 'id-slow'),
      t.invoke('fast', {}, async () => 'b', 'id-fast'),
    ])
    expect(t.facts.calls.map((c) => [c.id, c.name, c.status])).toEqual([
      ['id-slow', 'slow', 'done'],
      ['id-fast', 'fast', 'done'],
    ])
  })
})
