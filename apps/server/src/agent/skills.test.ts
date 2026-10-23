import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from '@plein/doc'
import type { AgentKind } from '@plein/protocol'
import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import type { AuthEnv } from '../auth'
import { bootServer, request, tempDir, until } from '../testing'
import { agentTurns, canvases } from '../storage/schema'
import { CodexSkillCache, codexSkillId, discoverCodexSkills } from './cli-skills'
import { agentRoutes } from './routes'
import { AgentSkills, PLEIN_SKILLS, SkillPreferences } from './skills'
import { capabilitiesOf } from './tools'

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url))
afterEach(() => {
  for (const key of [
    'FAKE_CLI_LOG',
    'FAKE_CODEX_SKILL_LOG',
    'FAKE_CODEX_SKILLS_FILE',
    'FAKE_CODEX_SKILL_ERROR',
    'FAKE_CODEX_SKILL_HANG',
    'FAKE_CODEX_SKILL_INVALID',
    'FAKE_CODEX_SKILL_WRITE_ERROR',
  ])
    delete process.env[key]
  vi.restoreAllMocks()
})
const json = (value: unknown) => ({
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(value),
})
interface FixtureRecord {
  method: string
  rpc: string
  mcpToken: string
  params: {
    input: Array<{ type: string; text: string; name: string; path: string }>
    [key: string]: unknown
  }
}
const records = (path: string): FixtureRecord[] =>
  readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as FixtureRecord)

async function setup(agent: AgentKind = 'builtin') {
  const f = await bootServer()
  f.server.db
    .insert(canvases)
    .values({ id: 'canvas', owner_id: 'local', title: 'skills', created_at: 1, updated_at: 1 })
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
  const turn = async (text: string, skill?: string, selection?: string[]) => {
    const idle = new Promise<void>((resolve) => {
      const off = f.server.agents.subscribe(session.id, (event) => {
        if (event.type === 'status' && event.status === 'idle') {
          off()
          resolve()
        }
      })
    })
    await f.server.agents.send(session.id, 'local', text, selection, 'rules', false, 'auto', skill)
    await idle
    return f.server.agents.get(session.id, 'local')!
  }
  return { ...f, session, turn }
}

function nativeFixture() {
  const dir = tempDir('plein-skills-')
  const path = join(dir, 'SKILL.md')
  writeFileSync(path, '# Fixture Skill\nNative instructions remain CLI reference data.')
  const file = join(dir, 'skills.json')
  const skill = {
    name: 'fixture-canvas',
    description: 'Native fixture',
    path,
    scope: 'user',
    enabled: true,
    interface: { displayName: '测试原生技能', shortDescription: '测试 CLI 目录' },
  }
  writeFileSync(file, JSON.stringify([skill]))
  process.env.FAKE_CODEX_SKILLS_FILE = file
  const log = join(dir, 'rpc.jsonl')
  process.env.FAKE_CODEX_SKILL_LOG = log
  return { dir, path, file, skill, log, id: codexSkillId(path) }
}

describe('Plein skill catalog and owner preferences', () => {
  it('uses the actual capability registry, and exposes five controlled guides with consistent IDs', async () => {
    const { server } = await setup()
    const catalog = await server.agents.skills('local', 'builtin')
    expect(catalog.skills.map((skill) => skill.id)).toEqual([
      'plein:canvas-audit',
      'plein:workflow',
      'plein:shot-revise',
      'plein:storyboard',
      'plein:media-edit',
    ])
    expect(catalog.capabilities.map((cap) => cap.name)).toEqual(
      capabilitiesOf(server.plugins)
        .list()
        .map((cap) => cap.name),
    )
    expect(
      catalog.capabilities.every((cap) =>
        ['read', 'edit', 'run', 'destructive', 'dynamic'].includes(cap.effect),
      ),
    ).toBe(true)
    const detail = await server.agents.skill('local', 'builtin', 'plein:shot-revise')
    expect(detail).toMatchObject({ selection: 'required', canToggle: true, source: 'plein' })
    expect(detail.instructions).toContain('propose_edit')
    expect(detail.instructions).toContain('await_approval')
    expect(JSON.stringify(catalog.skills)).not.toContain('instructions')
    expect(JSON.stringify(catalog.skills)).not.toContain('SKILL.md')
  })

  it('persists owner-isolated toggles across restart without disabling canvas capabilities', async () => {
    const f = await setup()
    const before = capabilitiesOf(f.server.plugins)
      .list()
      .map((cap) => cap.name)
    await f.server.agents.toggleSkill('local', 'builtin', 'plein:canvas-audit', false)
    expect((await f.server.agents.skills('other-owner', 'builtin')).skills[0]?.enabled).toBe(true)
    await expect(
      f.server.agents.send(
        f.session.id,
        'local',
        '检查',
        [],
        'rules',
        false,
        'auto',
        'plein:canvas-audit',
      ),
    ).rejects.toMatchObject({ code: 'disabled' })
    expect(f.server.db.select().from(agentTurns).all()).toHaveLength(0)
    expect(
      capabilitiesOf(f.server.plugins)
        .list()
        .map((cap) => cap.name),
    ).toEqual(before)
    await f.close()
    const restarted = await bootServer({ dataDir: f.dataDir })
    expect((await restarted.server.agents.skills('local', 'builtin')).skills[0]?.enabled).toBe(
      false,
    )
    await restarted.server.agents.toggleSkill('local', 'builtin', 'plein:canvas-audit', true)
    expect((await restarted.server.agents.skills('local', 'builtin')).skills[0]?.enabled).toBe(true)
  })

  it('reports corrupt preferences and refuses to overwrite them', async () => {
    const f = await setup()
    const prefs = new SkillPreferences(f.dataDir)
    mkdirSync(join(f.dataDir, 'agent-skills'), { recursive: true })
    writeFileSync(prefs.file('local'), '{broken')
    expect(await f.server.agents.skills('local', 'builtin')).toMatchObject({
      skills: [],
      error: expect.stringContaining('损坏'),
    })
    await expect(
      f.server.agents.toggleSkill('local', 'builtin', 'plein:canvas-audit', false),
    ).rejects.toMatchObject({ code: 'not_ready' })
    expect(readFileSync(prefs.file('local'), 'utf8')).toBe('{broken')
  })

  it('rejects viewer writes, invalid inputs, unknown IDs and foreign sessions', async () => {
    const f = await setup()
    const viewer = new Hono<AuthEnv>()
    viewer.use('*', async (c, next) => {
      c.set('principal', { id: 'local', role: 'viewer' })
      await next()
    })
    viewer.route('/', agentRoutes(f.server.db, f.server.agents))
    const route = '/api/agent/skills/builtin/plein%3Acanvas-audit'
    expect(
      (await viewer.request(route, { method: 'PATCH', ...json({ enabled: false }) })).status,
    ).toBe(403)
    expect(
      (await request(f.server, route, { method: 'PATCH', ...json({ enabled: 'false' }) })).status,
    ).toBe(400)
    expect((await request(f.server, '/api/agent/skills/builtin/missing')).status).toBe(404)
    expect((await request(f.server, '/api/agent/skills/not-an-agent')).status).toBe(404)
    await expect(
      f.server.agents.send(
        f.session.id,
        'other-owner',
        '检查',
        [],
        'rules',
        false,
        'auto',
        'plein:canvas-audit',
      ),
    ).rejects.toMatchObject({ code: 'not_found' })
    await expect(
      f.server.agents.send(
        f.session.id,
        'local',
        '修改',
        [],
        'rules',
        false,
        'auto',
        'plein:shot-revise',
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      f.server.agents.send(
        f.session.id,
        'local',
        '修改',
        ['missing'],
        'rules',
        false,
        'auto',
        'plein:shot-revise',
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      f.server.agents.send(f.session.id, 'local', '检查', [], 'rules', false, 'auto', 'missing'),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('keeps builtin guides available remotely and never discovers Claude filesystem skills', async () => {
    const f = await setup()
    const detect = vi.fn(async () => {
      throw new Error('must not run CLI')
    })
    const remote = new AgentSkills({
      dataDir: f.dataDir,
      host: f.server.plugins,
      localEnabled: false,
      detect,
    })
    expect((await remote.catalog('local', 'builtin')).skills).toHaveLength(5)
    expect((await remote.catalog('local', 'codex')).warnings?.[0]).toContain('本机模式')
    expect((await remote.catalog('local', 'claude')).warnings).toEqual([
      'Claude Code 自带 skill 由 CLI 管理；当前仅展示 Plein 技能',
    ])
    await expect(remote.detail('local', 'codex', 'codex:anything')).rejects.toMatchObject({
      code: 'not_found',
    })
    const local = new AgentSkills({
      dataDir: f.dataDir,
      host: f.server.plugins,
      localEnabled: true,
      detect,
    })
    expect((await local.detail('local', 'codex', 'plein:canvas-audit')).source).toBe('plein')
    await local.toggle('local', 'codex', 'plein:canvas-audit', false)
    expect(detect).not.toHaveBeenCalled()
  })
})

describe('Codex skill app-server integration using fake subprocesses', () => {
  it('handshakes, lists using exact cwd and forceReload, caches, and refreshes without starting a thread', async () => {
    const native = nativeFixture()
    const cache = new CodexSkillCache()
    const bin = join(FIXTURES, 'codex')
    const first = await cache.get(bin, native.dir, process.env)
    expect(first.skills).toEqual([
      expect.objectContaining({
        id: native.id,
        title: '测试原生技能',
        path: native.path,
        enabled: true,
        canToggle: true,
      }),
    ])
    await cache.get(bin, native.dir, process.env)
    expect(records(native.log).map((row) => row.method)).toEqual([
      'initialize',
      'initialized',
      'skills/list',
    ])
    expect(records(native.log)[2]?.params).toEqual({ cwds: [native.dir], forceReload: true })
    await cache.get(bin, native.dir, process.env, true)
    expect(records(native.log).filter((row) => row.method === 'skills/list')).toHaveLength(2)
    expect(records(native.log).some((row) => /^thread\/|^turn\//.test(row.method))).toBe(false)
  })

  it('reports failures, caches failure briefly, and allows an explicit refresh to recover', async () => {
    const native = nativeFixture()
    process.env.FAKE_CODEX_SKILL_ERROR = '1'
    const cache = new CodexSkillCache()
    const bin = join(FIXTURES, 'codex')
    expect(await cache.get(bin, native.dir, process.env)).toMatchObject({
      skills: [],
      error: 'fixture skills unavailable',
    })
    delete process.env.FAKE_CODEX_SKILL_ERROR
    expect((await cache.get(bin, native.dir, process.env)).error).toBeTruthy()
    expect((await cache.get(bin, native.dir, process.env, true)).skills).toHaveLength(1)
    process.env.FAKE_CODEX_SKILL_INVALID = '1'
    await expect(discoverCodexSkills(bin, native.dir, process.env)).rejects.toThrow('目录格式')
    delete process.env.FAKE_CODEX_SKILL_INVALID
    writeFileSync(native.file, JSON.stringify(Array.from({ length: 501 }, () => native.skill)))
    await expect(discoverCodexSkills(bin, native.dir, process.env)).rejects.toThrow('500 项上限')
    process.env.FAKE_CODEX_SKILL_HANG = '1'
    await expect(discoverCodexSkills(bin, native.dir, process.env, 150)).rejects.toThrow('超时')
  })

  it('only reads currently discovered SKILL.md files and rejects oversized or forged detail paths', async () => {
    const native = nativeFixture()
    const f = await setup('codex')
    expect((await f.server.agents.skill('local', 'codex', native.id)).instructions).toContain(
      'Native instructions',
    )
    await expect(
      f.server.agents.skill('local', 'codex', codexSkillId('/etc/passwd')),
    ).rejects.toMatchObject({ code: 'not_found' })
    writeFileSync(native.path, 'x'.repeat(65_537))
    await expect(f.server.agents.skill('local', 'codex', native.id)).rejects.toMatchObject({
      code: 'not_ready',
    })
    writeFileSync(
      native.file,
      JSON.stringify([{ ...native.skill, path: join(native.dir, 'other.txt') }]),
    )
    await f.server.agents.skills('local', 'codex', true)
    await expect(
      f.server.agents.skill('local', 'codex', codexSkillId(join(native.dir, 'other.txt'))),
    ).rejects.toMatchObject({ code: 'not_ready' })
  })

  it('uses real config RPC parameters, verifies the new state, and refuses administrator scopes', async () => {
    const native = nativeFixture()
    const f = await setup('codex')
    const route = `/api/agent/skills/codex/${native.id}`
    const res = await request(f.server, route, { method: 'PATCH', ...json({ enabled: false }) })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: native.id, enabled: false })
    expect(records(native.log).find((row) => row.method === 'skills/config/write')?.params).toEqual(
      { path: native.path, enabled: false },
    )
    await expect(
      f.server.agents.send(
        f.session.id,
        'local',
        '不会执行',
        [],
        'rules',
        false,
        'auto',
        native.id,
      ),
    ).rejects.toMatchObject({ code: 'disabled' })
    process.env.FAKE_CODEX_SKILL_WRITE_ERROR = '1'
    await expect(
      f.server.agents.toggleSkill('local', 'codex', native.id, true),
    ).rejects.toMatchObject({
      code: 'not_ready',
      message: expect.stringContaining('本机技能配置失败'),
    })
    delete process.env.FAKE_CODEX_SKILL_WRITE_ERROR
    writeFileSync(native.file, JSON.stringify([{ ...native.skill, scope: 'admin' }]))
    await f.server.agents.skills('local', 'codex', true)
    expect((await f.server.agents.skill('local', 'codex', native.id)).canToggle).toBe(false)
    const writes = records(native.log).filter((row) => row.method === 'skills/config/write').length
    await expect(
      f.server.agents.toggleSkill('local', 'codex', native.id, true),
    ).rejects.toMatchObject({ code: 'disabled' })
    expect(records(native.log).filter((row) => row.method === 'skills/config/write')).toHaveLength(
      writes,
    )
  })

  it('dispatches an explicit native typed skill input without injecting its file contents, and saves the skill badge', async () => {
    const native = nativeFixture()
    const f = await setup('codex')
    const session = await f.turn('检查当前目标', native.id)
    const input = records(native.log).find((row) => row.method === 'turn/start')!.params.input
    expect(input[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('$fixture-canvas '),
    })
    expect(input[0]!.text).not.toContain('Native instructions remain')
    expect(input[1]).toEqual({ type: 'skill', name: native.skill.name, path: native.path })
    expect(session.items.find((item) => item.type === 'user')).toMatchObject({
      text: '检查当前目标',
      skill: { id: native.id, title: '测试原生技能', name: native.skill.name, source: 'codex' },
    })
    const next = await f.turn('普通下一轮')
    expect(next.items.filter((item) => item.type === 'user').at(-1)).not.toHaveProperty('skill')
    expect(
      records(native.log)
        .filter((row) => row.method === 'turn/start')
        .at(-1)!.params.input,
    ).toHaveLength(1)
    writeFileSync(native.file, '[]')
    await expect(
      f.server.agents.send(
        f.session.id,
        'local',
        '已经失效',
        [],
        'rules',
        false,
        'auto',
        native.id,
      ),
    ).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('skill turn isolation and frozen selection', () => {
  it('retains this turn skill snapshot when another request disables the guide during CLI discovery', async () => {
    const f = await setup('codex')
    let entered!: () => void
    let release!: () => void
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const detect = f.server.agents.detect
    f.server.agents.detect = async () => {
      entered()
      await waiting
      return detect()
    }
    const pending = f.turn('检查已经选择的目标', 'plein:canvas-audit')
    await started
    await f.server.agents.toggleSkill('local', 'codex', 'plein:canvas-audit', false)
    release()
    const finished = await pending
    expect(finished.items.find((item) => item.type === 'user')).toMatchObject({
      skill: { id: 'plein:canvas-audit', title: '检查画布' },
    })
    expect(finished.lastTurn?.state).toBe('completed')
    await expect(
      f.server.agents.send(
        f.session.id,
        'local',
        '下一轮',
        [],
        'rules',
        false,
        'auto',
        'plein:canvas-audit',
      ),
    ).rejects.toMatchObject({ code: 'disabled' })
  })

  it('releases the pending-send guard if taking the initial selection snapshot fails', async () => {
    const f = await setup()
    vi.spyOn(f.server.rooms, 'withDoc').mockImplementationOnce(() => {
      throw new Error('snapshot unavailable')
    })
    await expect(
      f.server.agents.send(
        f.session.id,
        'local',
        '检查',
        ['missing'],
        'rules',
        false,
        'auto',
        'plein:canvas-audit',
      ),
    ).rejects.toThrow('snapshot unavailable')
    expect((await f.turn('读取现在的画布', 'plein:canvas-audit')).lastTurn?.state).toBe('completed')
  })

  it.each(['stop', 'delete', 'close'] as const)(
    '%s invalidates an in-flight skill resolution before it can begin a turn',
    async (action) => {
      const f = await setup()
      let release!: () => void
      let entered!: () => void
      const waiting = new Promise<void>((resolve) => {
        release = resolve
      })
      const started = new Promise<void>((resolve) => {
        entered = resolve
      })
      vi.spyOn(AgentSkills.prototype, 'resolve').mockImplementation(async () => {
        entered()
        await waiting
        return { ...PLEIN_SKILLS[0]! }
      })
      const pending = f.server.agents.send(
        f.session.id,
        'local',
        '取消前不得开始',
        [],
        'rules',
        false,
        'auto',
        'plein:canvas-audit',
      )
      const check = expect(pending).rejects.toMatchObject({
        code: action === 'delete' ? 'not_found' : 'busy',
      })
      await started
      if (action === 'stop') f.server.agents.stop(f.session.id)
      if (action === 'delete') f.server.agents.delete(f.session.id, 'local')
      if (action === 'close') f.server.agents.close()
      release()
      await check
      expect(f.server.db.select().from(agentTurns).all()).toHaveLength(0)
    },
  )

  it('freezes selected IDs before async validation and passes the same selection to the tool environment', async () => {
    const f = await setup('codex')
    const [first, second] = f.server.rooms.withDoc('canvas', (doc) => [
      createElement(doc, { kind: 'markdown', x: 0, y: 0, w: 200, h: 100, text: 'first' }),
      createElement(doc, { kind: 'markdown', x: 400, y: 0, w: 200, h: 100, text: 'second' }),
    ]) as [string, string]
    const log = join(tempDir(), 'turn.jsonl')
    process.env.FAKE_CLI_LOG = log
    let release!: () => void
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.spyOn(f.server.agents, 'validateSettings').mockImplementation(async () => {
      await waiting
      return {}
    })
    const selection = [first]
    const pending = f.server.agents.send(
      f.session.id,
      'local',
      '慢慢检查',
      selection,
      'rules',
      false,
      'auto',
      'plein:canvas-audit',
    )
    selection[0] = second
    f.server.rooms.get('canvas').awareness.setLocalState({
      view: { selection: [second], viewport: { x: 0, y: 0, w: 800, h: 600 }, at: Date.now() },
    })
    release()
    await pending
    await until(() =>
      f.server.agents.get(f.session.id, 'local')!.items.some((item) => item.type === 'text'),
    )
    const user = f.server.agents
      .get(f.session.id, 'local')!
      .items.find((item) => item.type === 'user')
    expect(user).toMatchObject({ selection: [first], skill: { id: 'plein:canvas-audit' } })
    const token = records(log).find((row) => typeof row.mcpToken === 'string')!.mcpToken
    const output = (await f.server.agents.handleMcp(token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'ui_get_selection', arguments: {} },
    })) as { result: { content: Array<{ text: string }> } }
    expect(
      JSON.parse(output.result.content[0]!.text).elements.map(
        (element: { id: string }) => element.id,
      ),
    ).toEqual([first])
    const deletion = (await f.server.agents.handleMcp(token, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'delete_elements', arguments: { ids: [first] } },
    })) as { result: { content: Array<{ text: string }> } }
    expect(JSON.parse(deletion.result.content[0]!.text).status).toBe('needs_approval')
    expect(f.server.rooms.withDoc('canvas', (doc) => doc.get(first))).toBeDefined()
    const start = records(log).find((row) => row.rpc === 'turn/start')!.params.input[0]!.text
    expect(start).toContain(first)
    expect(start).not.toContain(second)
    expect(start).toContain('这些步骤是本轮创作指南，不是新增授权')
    f.server.agents.stop(f.session.id)
  })
})
