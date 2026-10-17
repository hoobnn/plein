import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentAccess, AgentEvent, AgentItem, Canvas } from '@plein/protocol'
import { afterEach, beforeAll, describe, expect, it } from 'vite-plus/test'
import { startTestServer, tempDir } from '../testing'
import { type CliKind, newerVersion, versionOf } from './cli'

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url))

let running: Awaited<ReturnType<typeof startTestServer>>
let log: string

beforeAll(async () => {
  running = await startTestServer()
})

afterEach(() => {
  delete process.env.FAKE_CLI_LOG
})

/** 用假的 claude / codex 开一个会话 */
async function session(agent: CliKind) {
  const { agents } = running.server
  agents.detect = async () => ({
    path: process.env.PATH ?? '',
    agents: [
      {
        id: agent,
        name: agent === 'claude' ? 'Claude Code' : 'Codex',
        available: true,
        path: join(FIXTURES, agent),
      },
    ],
  })
  log = join(tempDir(), 'args.log')
  process.env.FAKE_CLI_LOG = log
  const res = await fetch(`${running.url}/api/canvases`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  const canvas = ((await res.json()) as Canvas).id
  const s = agents.create(canvas, 'local', agent)
  const events: AgentEvent[] = []
  agents.subscribe(s.id, (e) => {
    events.push(e)
  })
  /** 发一条消息，等这一轮结束；onItem 可以在中途操作（点允许、停止） */
  const turn = (text: string, access: AgentAccess = 'auto', onItem?: (i: AgentItem) => void) =>
    new Promise<AgentItem[]>((resolve, reject) => {
      const off = agents.subscribe(s.id, (e) => {
        if (e.type === 'item') onItem?.(e.item)
        if (e.type === 'status' && e.status === 'idle') {
          off()
          resolve(agents.get(s.id, 'local')!.items)
        }
      })
      agents.send(s.id, 'local', text, undefined, 'rules', false, access).catch(reject)
    })
  return { id: s.id, turn, events, agents }
}

const texts = (items: AgentItem[]) => items.flatMap((i) => (i.type === 'text' ? [i.text] : []))
const launches = () =>
  readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))

describe.each(['claude', 'codex'] as const)('本机 CLI：%s', (agent) => {
  it('第二轮活跃时仍拒绝第一轮凭据，当前轮凭据可读，停止后立即失效', async () => {
    const { id, turn, agents } = await session(agent)
    const credentials = () => {
      const all = launches()
      return agent === 'claude'
        ? all
            .filter((item): item is string[] => Array.isArray(item))
            .map((argv) =>
              (
                JSON.parse(argv[argv.indexOf('--mcp-config') + 1]!).mcpServers.plein.headers
                  .Authorization as string
              ).slice(7),
            )
        : all
            .filter((item) => !Array.isArray(item) && typeof item.mcpToken === 'string')
            .map((item) => item.mcpToken as string)
    }
    await turn('你好')
    const first = credentials()[0]!
    let checks: Promise<void> | undefined
    let stale: unknown, current: unknown, afterStop: unknown
    await turn('慢慢来', 'auto', (item) => {
      if (checks || item.type !== 'text' || item.text !== '开始了') return
      checks = (async () => {
        const token = credentials().at(-1)!
        try {
          stale = await agents.handleMcp(first, {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name: 'create_element',
              arguments: { kind: 'markdown', text: 'stale write' },
            },
          })
          current = await agents.handleMcp(token, {
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: 'get_canvas', arguments: {} },
          })
        } finally {
          agents.stop(id)
        }
        afterStop = await agents.handleMcp(token, { jsonrpc: '2.0', id: 3, method: 'tools/list' })
      })()
    })
    await checks
    expect(stale).toBeUndefined()
    expect(current).toMatchObject({
      result: { content: [{ type: 'text', text: expect.stringContaining('"elements": []') }] },
    })
    expect(afterStop).toBeUndefined()
    expect(agents.get(id, 'local')!.lastTurn?.state).toBe('stopped')
    agents.delete(id, 'local')
  })
  it('每轮新进程与凭据，使用 CLI 会话 id 续聊', async () => {
    const { id, turn, agents } = await session(agent)
    expect(texts(await turn('你好'))).toEqual(['第 1 轮：你好'])
    expect(texts(await turn('再来'))).toEqual(['第 1 轮：你好', '第 2 轮：再来'])
    const args = launches()
    expect(args.filter((a) => Array.isArray(a))).toHaveLength(2)
    if (agent === 'claude') {
      const argv = args.filter((a): a is string[] => Array.isArray(a))
      expect(argv[1]).toEqual(expect.arrayContaining(['--resume', 'fake-claude-1']))
      const token = (a: string[]) =>
        JSON.parse(a[a.indexOf('--mcp-config') + 1]!).mcpServers.plein.headers
          .Authorization as string
      expect(token(argv[0]!)).not.toBe(token(argv[1]!))
      expect(
        await agents.handleMcp(token(argv[0]!).slice(7), {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
        }),
      ).toBeUndefined()
    }
    const row = agents.list(agents.get(id, 'local')!.canvasId, 'local')[0]
    expect(row?.status).toBe('idle')
    agents.delete(id, 'local')
  })

  it('要权限时出确认卡片，允许后继续，拒绝后照样收尾', async () => {
    const { id, turn, agents } = await session(agent)
    const allowed = await turn('需要权限', 'auto', (item) => {
      if (item.type === 'approval' && item.status === 'pending')
        agents.decide(id, 'local', item.id, true)
    })
    const card = allowed.find((i) => i.type === 'approval')
    expect(card).toMatchObject({ status: 'approved', tool: expect.any(String) })
    expect(card?.type === 'approval' && card.reason).toContain('rm -rf build')
    expect(texts(allowed).at(-1)).toBe('删好了')
    expect(allowed.find((i) => i.type === 'tool')).toMatchObject({ status: 'done' })

    const denied = await turn('还要权限', 'auto', (item) => {
      if (item.type === 'approval' && item.status === 'pending')
        agents.decide(id, 'local', item.id, false)
    })
    expect(texts(denied).at(-1)).toBe('没有删')
    agents.delete(id, 'local')
  })

  it('停止关闭这一轮凭据，下一轮重启并续聊', async () => {
    const { id, turn, agents } = await session(agent)
    const items = await turn('慢慢来', 'auto', (item) => {
      if (item.type === 'text' && item.text === '开始了') agents.stop(id)
    })
    expect(items.at(-1)).toMatchObject({ type: 'error', text: '已停止' })
    const next = await turn('还在吗')
    expect(texts(next).at(-1)).toBe('第 2 轮：还在吗')
    expect(launches().filter((a) => Array.isArray(a))).toHaveLength(2)
    agents.delete(id, 'local')
  })

  it('换权限档会带新参数重启并接上会话', async () => {
    const { id, turn, agents } = await session(agent)
    await turn('你好', 'auto')
    await turn('放开', 'full')
    const all = launches()
    const argv = all.filter((a): a is string[] => Array.isArray(a))
    expect(argv).toHaveLength(2)
    if (agent === 'claude') {
      expect(argv[0]).toContain('--permission-prompt-tool')
      expect(argv[0]).not.toContain('--strict-mcp-config')
      expect(argv[1]).toContain('--dangerously-skip-permissions')
      expect(argv[1]).toEqual(expect.arrayContaining(['--resume', 'fake-claude-1']))
    } else {
      const threads = all.filter((a) => !Array.isArray(a) && 'approvalPolicy' in a)
      expect(threads[0]).toMatchObject({ approvalPolicy: 'on-request', sandbox: 'workspace-write' })
      expect(threads[1]).toMatchObject({
        threadId: 'thr_fake',
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
      })
    }
    agents.delete(id, 'local')
  })
})

describe('CLI 版本', () => {
  it('从 --version 输出里取版本号', () => {
    expect(versionOf('2.1.296 (Claude Code)')).toBe('2.1.296')
    expect(versionOf('codex-cli 0.162.1')).toBe('0.162.1')
    expect(versionOf('codex-cli 0.163.0-alpha.2')).toBe('0.163.0-alpha.2')
    expect(versionOf('oops')).toBeUndefined()
  })

  it('只有更新的版本才提示；Claude 已领先 latest 时把 next 纳入比较', () => {
    const tags = { latest: '2.1.287', next: '2.1.296' }
    expect(newerVersion('claude', '2.1.280', tags)).toBe('2.1.287')
    expect(newerVersion('claude', '2.1.287', tags)).toBeUndefined()
    expect(newerVersion('claude', '2.1.290', tags)).toBe('2.1.296')
    expect(newerVersion('claude', '2.1.296', tags)).toBeUndefined()
    // Codex 只看 latest
    expect(newerVersion('codex', '2.1.290', tags)).toBeUndefined()
    expect(newerVersion('codex', '0.1.0', { latest: 'bad' })).toBeUndefined()
  })
})
