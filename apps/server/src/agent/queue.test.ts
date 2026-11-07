import type { AgentItem, AgentSession } from '@plein/protocol'
import { describe, expect, it } from 'vite-plus/test'
import type { ChatMessage, ProviderOutput } from '@plein/plugin-sdk'
import { z } from 'zod'
import type { PluginHost } from '../plugins/host'
import { runBuiltinTurn } from './builtin'
import { defineTool } from './mcp'
import { bootServer, createCanvas, request, until } from '../testing'

type User = Extract<AgentItem, { type: 'user' }>

async function setup() {
  const f = await bootServer()
  const { id: canvasId } = await createCanvas(f.server)
  const created = await request(f.server, `/api/canvases/${canvasId}/agent/sessions`, {
    method: 'POST',
    body: JSON.stringify({ agent: 'builtin' }),
  })
  const session = (await created.json()) as AgentSession
  const path = `/api/agent/sessions/${session.id}`
  const send = (text: string) =>
    request(f.server, `${path}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text, approval: 'always' }),
    })
  const read = () => f.server.agents.get(session.id, 'local')!
  const users = () => read().items.filter((i): i is User => i.type === 'user')
  // 画图这句会停在运行确认上，方便在这一轮运行期间插话
  const startWaiting = async () => {
    expect((await send('画一张雨夜天台')).status).toBe(202)
    return until(() => read().items.find((i) => i.type === 'approval' && i.status === 'pending'))
  }
  return { ...f, canvasId, session, path, send, read, users, startWaiting }
}

describe('运行中插话', () => {
  it('排队显示为已排队，下一步注入本轮后去掉标记，不再报 busy', async () => {
    const f = await setup()
    try {
      const approval = await f.startWaiting()
      const res = await f.send('顺便说声谢谢')
      expect(res.status).toBe(202)
      const queued = f.users().find((u) => u.text === '顺便说声谢谢')!
      expect(queued.queued).toBe(true)
      // 跳过确认后本轮继续到下一步，排队的话被注入
      await request(f.server, `${f.path}/approvals/${approval.id}`, {
        method: 'POST',
        body: JSON.stringify({ allow: false }),
      })
      await until(() => f.read().status === 'idle')
      const after = f.read()
      expect(f.users().find((u) => u.id === queued.id)?.queued).toBeUndefined()
      expect(after.items).toContainEqual(
        expect.objectContaining({ type: 'text', text: expect.stringContaining('顺便说声谢谢') }),
      )
      // 仍是同一轮：只有一条运行记录
      expect(f.users().map((u) => u.text)).toEqual(['画一张雨夜天台', '顺便说声谢谢'])
    } finally {
      await f.close()
    }
  })

  it('停止时丢弃还没注入的排队消息并提示', async () => {
    const f = await setup()
    try {
      await f.startWaiting()
      expect((await f.send('再问一句')).status).toBe(202)
      expect(f.users().some((u) => u.queued)).toBe(true)
      await request(f.server, `${f.path}/stop`, { method: 'POST' })
      await until(() => f.read().status === 'idle')
      const after = f.read()
      expect(f.users().some((u) => u.text === '再问一句')).toBe(false)
      expect(after.items).toContainEqual(
        expect.objectContaining({ type: 'notice', text: expect.stringContaining('1 条排队') }),
      )
    } finally {
      await f.close()
    }
  })

  it('本轮最后一次模型调用期间排队的消息，在本轮结束后自动作为下一轮', async () => {
    const f = await setup()
    try {
      const host = (f.server.agents as unknown as { deps: { host: { call: Function } } }).deps.host
      const original = host.call.bind(host)
      let injected = false
      host.call = async (...args: unknown[]) => {
        const result = (await original(...args)) as { outputs: Array<{ type: string }> }
        if (!injected && !result.outputs.some((o) => o.type === 'tool_calls')) {
          injected = true
          expect((await f.send('再问一句')).status).toBe(202)
        }
        return result
      }
      expect((await f.send('你好')).status).toBe(202)
      await until(() => f.users().length === 2 && f.read().status === 'idle')
      const second = f.users()[1]!
      expect(second.text).toBe('再问一句')
      expect(second.queued).toBeUndefined()
      expect(f.read().items).toContainEqual(
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('看过画布了：再问一句'),
        }),
      )
    } finally {
      await f.close()
    }
  })

  it('排队消息超过上限时报 busy', async () => {
    const f = await setup()
    try {
      await f.startWaiting()
      for (let i = 0; i < 5; i++) expect((await f.send(`m${i}`)).status).toBe(202)
      expect((await f.send('m5')).status).toBe(409)
    } finally {
      await f.close()
    }
  })
})

describe('runBuiltinTurn 注入排队消息', () => {
  it('在下一次模型调用前追加为 user 消息，只注入一次', async () => {
    const seen: ChatMessage[][] = []
    const replies: ProviderOutput[][] = [
      [{ type: 'tool_calls', calls: [{ id: 'a', name: 't', arguments: {} }] }],
      [{ type: 'text', text: 'done' }],
    ]
    const host = {
      call: async (_c: string, _m: string, input: { messages: ChatMessage[] }) => {
        seen.push(structuredClone(input.messages))
        return { outputs: replies[seen.length - 1]! }
      },
    } as unknown as PluginHost
    let pending = ['先别删东西']
    await runBuiltinTurn({
      host,
      model: 'm',
      ownerId: 'local',
      system: '',
      history: [],
      prompt: 'go',
      signal: new AbortController().signal,
      tools: [defineTool({ name: 't', description: '', input: z.object({}), run: () => 'x' })],
      // 第一步开始前没有排队；工具执行期间用户插话，第二步前注入
      takeQueued: () => (seen.length === 0 ? [] : pending.splice(0)),
      onText: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
    })
    expect(seen).toHaveLength(2)
    expect(seen[0]!.some((m) => m.content === '先别删东西')).toBe(false)
    const second = seen[1]!
    expect(second.at(-1)).toEqual({ role: 'user', content: '先别删东西' })
    expect(second.at(-2)!.role).toBe('tool')
    expect(pending).toEqual([])
  })
})
