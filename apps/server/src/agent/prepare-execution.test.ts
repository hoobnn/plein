import { expandShots, expandedNodes, type ShotSource } from '@plein/capabilities'
import type { Shot } from '@plein/nodes'
import { mockProvider } from '@plein/providers'
import { describe, expect, it, vi } from 'vite-plus/test'
import { addNode, bootServer, createCanvas, makeNode, mockSettings, until } from '../testing'
import { Approvals } from './approvals'
import { AgentChanges } from './changes'
import { TurnExecution } from './execution'
import { callTool } from './mcp'
import { agentTools, type ToolEnv } from './tools'

/**
 * prepare 与回合串行化：智能体工具调用（非 read）整体已在 execution.serialize 里，
 * 无需确认的路径直接执行，不再进同一队列；只有用户批准后的异步恢复入口才 serialize。
 * 哪个声明 prepare 的能力在无需确认时自己再 serialize，外层队列与内层队列就会互相等待（死锁）。
 */

const shot = (no: number): Shot => ({
  id: `shot-${no}`,
  no,
  duration: 3,
  shotSize: '中景',
  description: `画面${no}`,
  characters: [],
  emotion: '',
  lighting: '',
  sfx: '',
  dialogue: [],
  imagePrompt: `画面${no}`,
  motionPrompt: '缓缓推进',
})

async function setup(mode: 'auto' | 'rules' = 'auto') {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  const shots = [1, 2].map(shot)
  const board = addNode(doc, 'plein/storyboard', { name: '分镜', params: { shots } })
  expandShots(
    doc,
    board,
    shots.map((s) => s.id),
    makeNode,
  )
  const expanded = expandedNodes(doc, board).get('shot-1')!
  const byRole = (role: ShotSource['role']) =>
    expanded.find((el) => (el.params?.source as ShotSource)?.role === role)!.id
  const img = byRole('image')
  const vid = byRole('video')
  // 方案用例要有已有结果可沿用
  for (const n of [img, vid])
    expect(await server.runs.wait(server.runs.start(id, n, 'local'))).toBe('succeeded')

  const execution = new TurnExecution(
    'turn',
    () => true,
    () => {},
  )
  const changes = new AgentChanges('prep-exec', id, 'local', server.rooms, server.runs)
  changes.begin('t1')
  const approvals = new Approvals(() => {})
  const env: ToolEnv = {
    canvasId: id,
    ownerId: 'local',
    rooms: server.rooms,
    runs: server.runs,
    host: server.plugins,
    assets: server.assets,
    plans: server.plans,
    execution,
    onRun: (n, r) => changes.recordRun(n, r),
    onGroup: (g) => changes.recordGroup(g),
  }
  const tools = agentTools(env, { changes, approvals, mode: () => mode })
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await callTool(
      tools.find((tool) => tool.name === name)!,
      args,
    )
    const text = result.content
      .filter((block) => block.type === 'text')
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n')
    return { text, json: <T = Record<string, unknown>>() => JSON.parse(text) as T }
  }
  return { server, id, doc, board, img, vid, execution, approvals, changes, call }
}

describe('prepare 与回合串行化', () => {
  it('auto 带回合执行：run_storyboard 无需确认直接提交，不再进同一串行化队列', async () => {
    const f = await setup('auto')
    const submit = vi.spyOn(mockProvider, 'submit')
    const started = (await f.call('run_storyboard', { id: f.board, role: 'image' })).json<{
      group_id: string
    }>()
    expect(started.group_id).toBeTruthy()
    await until(
      () => f.server.runs.groupState(started.group_id, 'local')?.status === 'done',
      15_000,
    )
    // 预跑了 shot-1 的图，批次里只有 shot-2 需要生成
    expect(f.server.runs.groupState(started.group_id, 'local')!.summary?.succeeded).toBe(1)
    expect(submit).toHaveBeenCalledTimes(1)
    f.changes.release()
  })

  it('auto 带回合执行：run_node 的输入预检与执行不额外排队', async () => {
    const f = await setup('auto')
    const done = (await f.call('run_node', { id: f.img, wait_seconds: 10 })).json<{
      status: string
    }>()
    expect(done.status).toBe('succeeded')
    f.changes.release()
  })

  it('auto 带回合执行：方案卡片批准后按范围执行，跳过的步骤回 skipped_by_user', async () => {
    const f = await setup('auto')
    const prompt = String(f.doc.get(f.img)!.params!.prompt)
    const proposed = (
      await f.call('propose_edit', {
        summary: '让第一镜头更紧张',
        edits: [{ id: f.img, params: { prompt: `${prompt}，手持晃动` } }],
      })
    ).json<{ approval_id: string }>()
    expect(proposed.approval_id).toBeTruthy()
    expect(f.approvals.decide(proposed.approval_id, true, { scope: 'full', skip: [f.vid] })).toBe(
      true,
    )
    const done = (await f.call('await_approval', { approval_id: proposed.approval_id })).json<{
      status: string
      scope: string
      skipped_by_user: string[]
    }>()
    expect(done).toMatchObject({ status: 'applied', scope: 'full', skipped_by_user: [f.vid] })
    f.changes.release()
  })
})
