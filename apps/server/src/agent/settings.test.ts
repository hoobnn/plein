import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import type { AgentContext, AgentEvent, AgentKind, AgentSession } from '@plein/protocol'
import type { ChatMessage, ChatTool } from '@plein/plugin-sdk'
import type { AuthEnv } from '../auth'
import { bootServer, request, tempDir } from '../testing'
import { agentSessions, agentTurns, canvases, jobs } from '../storage/schema'
import { budgetMessages, textCost } from './context-budget'
import { discoverCodexModels } from './models'
import { agentRoutes } from './routes'

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url))
afterEach(() => {
  delete process.env.FAKE_CLI_LOG
  delete process.env.FAKE_CODEX_MODEL_ERROR
  delete process.env.FAKE_CODEX_MODEL_HANG
  vi.restoreAllMocks()
})

async function setup(agent: AgentKind = 'builtin') {
  const f = await bootServer()
  f.server.db
    .insert(canvases)
    .values({ id: 'canvas', owner_id: 'local', title: 'test', created_at: 1, updated_at: 1 })
    .run()
  f.server.agents.setMcpUrl('http://127.0.0.1:8787/mcp')
  f.server.agents.detect = async () => ({
    path: process.env.PATH ?? '',
    agents: ['claude', 'codex'].map((id) => ({
      id: id as 'claude' | 'codex',
      name: id,
      available: true,
      path: join(FIXTURES, id),
    })),
  })
  const session = f.server.agents.create('canvas', 'local', agent)
  const turn = async (text: string) => {
    const idle = new Promise<void>((resolve) => {
      const off = f.server.agents.subscribe(session.id, (e) => {
        if (e.type === 'status' && e.status === 'idle') {
          off()
          resolve()
        }
      })
    })
    await f.server.agents.send(session.id, 'local', text)
    await idle
    return f.server.agents.get(session.id, 'local')!
  }
  return { ...f, session, turn }
}

const json = (value: unknown) => ({
  body: JSON.stringify(value),
  headers: { 'content-type': 'application/json' },
})

describe('agent model and context management', () => {
  it('lists only enabled tool models and remains available when the global default has no tools', async () => {
    const { server } = await setup()
    server.plugins.configs.setDefaultModel('text.chat', 'plein/mock:chat')
    expect((await server.agents.status()).agents[0]).toMatchObject({
      available: true,
      model: 'Mock 智能体',
    })
    expect((await server.agents.models('builtin')).models.map((m) => m.id)).toEqual([
      'plein/mock:agent',
      'plein/mock:agent-vision',
    ])
    server.plugins.configs.update('plein/mock', { enabled: false })
    expect((await server.agents.models('builtin')).models).toEqual([])
    expect((await server.agents.status()).agents[0]?.available).toBe(false)
  })

  it('persists settings and context across restart; empty PATCH restores defaults', async () => {
    const f = await setup()
    const route = `/api/agent/sessions/${f.session.id}`
    const saved = await request(f.server, route, {
      method: 'PATCH',
      ...json({ model: 'plein/mock:agent-vision' }),
    })
    expect(saved.status).toBe(200)
    const fresh = await f.turn('只看现在有哪些元素')
    expect(fresh.settings).toEqual({ model: 'plein/mock:agent-vision' })
    expect(fresh.context).toMatchObject({
      source: 'estimate',
      model: 'plein/mock:agent-vision',
      limit: 32000,
      tokens: expect.any(Number),
      bytes: expect.any(Number),
    })
    await f.close()
    const restarted = await bootServer({ dataDir: f.dataDir })
    const loaded = (await (await request(restarted.server, route)).json()) as AgentSession
    expect(loaded.settings).toEqual(fresh.settings)
    expect(loaded.context).toEqual(fresh.context)
    const cleared = (await (
      await request(restarted.server, route, { method: 'PATCH', ...json({}) })
    ).json()) as AgentSession
    expect(cleared.settings).toEqual({})
    expect(cleared.context?.source).toBe('unavailable')
    expect(cleared.context?.tokens).toBeUndefined()
  })

  it('reset retains records and execution facts but never reintroduces legacy history, including after restart', async () => {
    const f = await setup()
    await f.turn('画一张 unique-old-context')
    const prior = f.server.agents.get(f.session.id, 'local')!
    const facts = f.server.db.select().from(agentTurns).all()
    const canvas = f.server.rooms.withDoc('canvas', (doc) => [...doc.elements()])
    const tasks = f.server.db.select().from(jobs).all()
    expect(canvas.length).toBeGreaterThan(0)
    expect(tasks.length).toBeGreaterThan(0)
    const res = await request(f.server, `/api/agent/sessions/${f.session.id}/context/reset`, {
      method: 'POST',
    })
    expect(res.status).toBe(200)
    const reset = (await res.json()) as AgentSession
    expect(reset.items.slice(0, prior.items.length)).toEqual(prior.items)
    expect(reset.items.at(-1)).toMatchObject({ type: 'notice' })
    expect(reset.context).toMatchObject({
      source: 'unavailable',
      messages: 0,
      resetAt: expect.any(Number),
    })
    expect(f.server.db.select().from(agentTurns).all()).toEqual(facts)
    expect(f.server.rooms.withDoc('canvas', (doc) => [...doc.elements()])).toEqual(canvas)
    expect(f.server.db.select().from(jobs).all()).toEqual(tasks)
    await f.close()
    const restarted = await bootServer({ dataDir: f.dataDir })
    const calls = vi.spyOn(restarted.server.plugins, 'call')
    const idle = new Promise<void>((resolve) => {
      const off = restarted.server.agents.subscribe(f.session.id, (e) => {
        if (e.type === 'status' && e.status === 'idle') {
          off()
          resolve()
        }
      })
    })
    await restarted.server.agents.send(f.session.id, 'local', 'new-context-only')
    await idle
    const input = calls.mock.calls.find((args) => args[0] === 'text.chat')![2] as {
      messages: ChatMessage[]
    }
    expect(JSON.stringify(input.messages)).not.toContain('unique-old-context')
    expect(JSON.stringify(input.messages)).toContain('new-context-only')
    const after = restarted.server.agents.get(f.session.id, 'local')!
    for (const item of reset.items)
      expect(after.items.some((saved) => saved.id === item.id)).toBe(true)
    expect(
      after.items.some((item) => item.type === 'user' && item.text === 'new-context-only'),
    ).toBe(true)
    expect(restarted.server.db.select().from(agentTurns).all()).toHaveLength(2)
    expect(restarted.server.db.select().from(agentSessions).get()?.cli_session).toBeNull()
  })

  it('rejects busy, missing, viewer and invalid model changes before they mutate the session', async () => {
    const f = await setup('claude')
    const id = f.session.id
    expect(
      (
        await request(f.server, `/api/agent/sessions/${id}`, {
          method: 'PATCH',
          ...json({ model: 'missing' }),
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await request(f.server, `/api/agent/sessions/${id}`, {
          method: 'PATCH',
          ...json({ model: 'sonnet', reasoningEffort: 'high' }),
        })
      ).status,
    ).toBe(400)
    expect(
      (await request(f.server, '/api/agent/sessions/missing/context/reset', { method: 'POST' }))
        .status,
    ).toBe(404)
    const viewer = new Hono<AuthEnv>()
    viewer.use('*', async (c, next) => {
      c.set('principal', { id: 'local', role: 'viewer' })
      await next()
    })
    viewer.route('/', agentRoutes(f.server.db, f.server.agents))
    expect(
      (
        await viewer.request(`/api/agent/sessions/${id}`, {
          method: 'PATCH',
          ...json({ model: 'sonnet' }),
        })
      ).status,
    ).toBe(403)
    expect(
      (await viewer.request(`/api/agent/sessions/${id}/context/reset`, { method: 'POST' })).status,
    ).toBe(403)
    await expect(f.server.agents.update(id, 'other-owner', {})).rejects.toMatchObject({
      code: 'not_found',
    })
    expect(() => f.server.agents.resetContext(id, 'other-owner')).toThrow('会话不存在')
    const started = new Promise<void>((resolve) => {
      const off = f.server.agents.subscribe(id, (e) => {
        if (e.type === 'item' && e.item.type === 'text') {
          off()
          resolve()
        }
      })
    })
    await f.server.agents.send(id, 'local', '慢慢来')
    await started
    expect(
      (
        await request(f.server, `/api/agent/sessions/${id}`, {
          method: 'PATCH',
          ...json({ model: 'sonnet' }),
        })
      ).status,
    ).toBe(409)
    expect(
      (await request(f.server, `/api/agent/sessions/${id}/context/reset`, { method: 'POST' }))
        .status,
    ).toBe(409)
    f.server.agents.stop(id)
  })

  it('reports the exact budgeted local request and omitted complete rounds', () => {
    const reports: AgentContext[] = []
    const history: ChatMessage[] = [
      { role: 'user', content: 'x'.repeat(131000) },
      { role: 'assistant', content: 'previous' },
      { role: 'user', content: 'recent' },
    ]
    const tools: ChatTool[] = []
    const result = budgetMessages(
      'system',
      history,
      [{ role: 'user', content: 'now' }],
      tools,
      (context) => reports.push({ ...context, source: 'estimate' }),
    )
    const cost = textCost({ messages: result, tools })
    expect(reports).toEqual([
      {
        source: 'estimate',
        messages: result.length,
        bytes: cost.bytes,
        tokens: cost.tokens + result.length * 16,
        omittedRounds: 1,
      },
    ])
    expect(JSON.stringify(result)).toContain('未发送')
    expect(JSON.stringify(result)).not.toContain('previous')
  })
})

describe('real driver parameter boundaries with fake subprocesses', () => {
  it('discovers paginated Codex models lazily, caches them, validates effort, and passes model/effort to thread and turn', async () => {
    const f = await setup('codex')
    const log = join(tempDir(), 'codex.log')
    process.env.FAKE_CLI_LOG = log
    const catalog = await f.server.agents.models('codex')
    expect(catalog).toMatchObject({
      defaultModel: 'fixture-thinking',
      models: [
        { id: 'fixture-thinking', reasoningEfforts: ['medium', 'high'] },
        { id: 'fixture-fast', reasoningEfforts: ['low'] },
      ],
    })
    await f.server.agents.models('codex')
    const records = () =>
      readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((s) => JSON.parse(s) as Record<string, unknown>)
    expect(records().filter((r) => r.rpc === 'model/list')).toHaveLength(2)
    expect(records().some((r) => r.rpc === 'turn/start')).toBe(false)
    await expect(
      f.server.agents.update(f.session.id, 'local', { reasoningEffort: 'high' }),
    ).rejects.toMatchObject({ code: 'invalid_input', message: '请先选择具体模型再设置推理强度' })
    await expect(
      f.server.agents.update(f.session.id, 'local', {
        model: 'fixture-fast',
        reasoningEffort: 'high',
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await f.server.agents.update(f.session.id, 'local', {
      model: 'fixture-thinking',
      reasoningEffort: 'high',
    })
    const events: AgentEvent[] = []
    f.server.agents.subscribe(f.session.id, (e) => events.push(e))
    const result = await f.turn('查看用量')
    expect(records().find((r) => 'approvalPolicy' in r)).toMatchObject({
      model: 'fixture-thinking',
      reasoningEffort: 'high',
    })
    expect(records().find((r) => r.rpc === 'turn/start')).toMatchObject({
      params: { model: 'fixture-thinking', effort: 'high' },
    })
    expect(result.context).toMatchObject({
      source: 'provider',
      tokens: 1200,
      limit: 10000,
      model: 'fixture-thinking',
    })
    expect(
      events.filter((e) => e.type === 'configuration' && e.context.tokens === 99999),
    ).toHaveLength(0)
    await f.server.agents.update(f.session.id, 'local', { model: 'fixture-fast' })
    expect(f.server.agents.get(f.session.id, 'local')!.context).toMatchObject({
      source: 'unavailable',
      model: 'fixture-fast',
    })
    expect(f.server.agents.get(f.session.id, 'local')!.context?.tokens).toBeUndefined()
    f.server.agents.resetContext(f.session.id, 'local')
    await f.turn('new thread')
    const threads = records().filter((r) => 'approvalPolicy' in r)
    expect(threads).toHaveLength(2)
    expect(threads[1]).not.toHaveProperty('threadId')
    expect(
      records()
        .filter((r) => r.rpc === 'turn/start')
        .at(-1),
    ).toMatchObject({ params: { model: 'fixture-fast', effort: 'low' } })
    const defaults = await f.server.agents.update(f.session.id, 'local', {})
    expect(defaults.items.at(-1)).toMatchObject({
      type: 'notice',
      text: expect.stringContaining('重新开始 CLI 上下文'),
    })
    expect(f.server.db.select().from(agentSessions).get()?.cli_session).toBeNull()
    await f.turn('follow cli defaults')
    const defaultThread = records()
      .filter((r) => 'approvalPolicy' in r)
      .at(-1)
    expect(defaultThread).not.toHaveProperty('threadId')
    expect(defaultThread).not.toHaveProperty('model')
    expect(defaultThread).not.toHaveProperty('reasoningEffort')
    const defaultTurn = records()
      .filter((r) => r.rpc === 'turn/start')
      .at(-1)?.params
    expect(defaultTurn).not.toHaveProperty('model')
    expect(defaultTurn).not.toHaveProperty('effort')
  })

  it('passes Claude alias with --model and uses per-request input/cache tokens instead of cumulative result usage', async () => {
    const f = await setup('claude')
    const log = join(tempDir(), 'claude.log')
    process.env.FAKE_CLI_LOG = log
    await f.server.agents.update(f.session.id, 'local', { model: 'opus' })
    const result = await f.turn('查看用量')
    const argv = JSON.parse(readFileSync(log, 'utf8').trim().split('\n')[0]!) as string[]
    expect(argv.slice(argv.indexOf('--model'), argv.indexOf('--model') + 2)).toEqual([
      '--model',
      'opus',
    ])
    expect(result.context).toMatchObject({
      source: 'provider',
      tokens: 450,
      model: 'fixture-claude',
    })
    expect(result.context?.limit).toBeUndefined()
    expect((await f.turn('你好')).context).toMatchObject({ source: 'unavailable' })
    const previous = f.server.db.select().from(agentSessions).get()?.cli_session
    await f.server.agents.update(f.session.id, 'local', { model: 'sonnet' })
    expect(f.server.db.select().from(agentSessions).get()?.cli_session).toBe(previous)
    await f.turn('explicit switch retains context')
    const launches = () =>
      readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string[])
    expect(launches().at(-1)).toEqual(
      expect.arrayContaining(['--resume', 'fake-claude-1', '--model', 'sonnet']),
    )
    await f.server.agents.update(f.session.id, 'local', {})
    expect(f.server.db.select().from(agentSessions).get()?.cli_session).toBeNull()
    await f.turn('follow cli defaults')
    expect(launches().at(-1)).not.toContain('--resume')
    expect(launches().at(-1)).not.toContain('--model')
  })

  it('returns explicit directory failure and bounds model discovery timeout without any turn request', async () => {
    const f = await setup('codex')
    process.env.FAKE_CODEX_MODEL_ERROR = '1'
    expect(await f.server.agents.models('codex', true)).toEqual({
      models: [],
      error: 'fixture catalog unavailable',
    })
    await expect(
      f.server.agents.update(f.session.id, 'local', { model: 'fixture-thinking' }),
    ).rejects.toMatchObject({ code: 'not_ready' })
    delete process.env.FAKE_CODEX_MODEL_ERROR
    process.env.FAKE_CODEX_MODEL_HANG = '1'
    await expect(
      discoverCodexModels(join(FIXTURES, 'codex'), f.dataDir, process.env, 100),
    ).rejects.toThrow('超时')
  })
})

describe('pending directory queries cannot revive canceled sessions', () => {
  it.each(['stop', 'delete', 'close'] as const)(
    '%s cancels a send that is still validating its model',
    async (action) => {
      const f = await setup('codex')
      let release!: () => void
      const waiting = new Promise<void>((resolve) => {
        release = resolve
      })
      vi.spyOn(f.server.agents, 'validateSettings').mockImplementation(async () => {
        await waiting
        return {}
      })
      const send = f.server.agents.send(f.session.id, 'local', 'must not start')
      const checked = expect(send).rejects.toMatchObject({
        code: action === 'delete' ? 'not_found' : 'busy',
      })
      if (action === 'stop') f.server.agents.stop(f.session.id)
      if (action === 'delete') f.server.agents.delete(f.session.id, 'local')
      if (action === 'close') f.server.agents.close()
      release()
      await checked
      expect(f.server.db.select().from(agentTurns).all()).toHaveLength(0)
    },
  )

  it.each(['reset', 'delete'] as const)(
    '%s wins against an older pending PATCH',
    async (action) => {
      const f = await setup('codex')
      let release!: () => void
      const waiting = new Promise<void>((resolve) => {
        release = resolve
      })
      vi.spyOn(f.server.agents, 'validateSettings').mockImplementation(async () => {
        await waiting
        return {}
      })
      const pending = f.server.agents.update(f.session.id, 'local', { model: 'stale' })
      const checked = expect(pending).rejects.toMatchObject({
        code: action === 'reset' ? 'busy' : 'not_found',
      })
      if (action === 'reset') f.server.agents.resetContext(f.session.id, 'local')
      else f.server.agents.delete(f.session.id, 'local')
      release()
      await checked
      if (action === 'reset') {
        expect(f.server.agents.get(f.session.id, 'local')!.settings).toEqual({})
        expect(
          f.server.db.select().from(agentSessions).where(eq(agentSessions.id, f.session.id)).get()
            ?.context_reset_at,
        ).toBeTypeOf('number')
      } else expect(f.server.agents.get(f.session.id, 'local')).toBeNull()
    },
  )
})
