import { expandShots, expandedNodes, type ShotSource } from '@plein/capabilities'
import { addResults, currentResult, SCHEMA_VERSION, setParams } from '@plein/doc'
import type { Shot } from '@plein/nodes'
import { API, type AgentApprovalMode, type StoryboardBatchPlan } from '@plein/protocol'
import { mockProvider } from '@plein/providers'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import {
  addNode,
  bootServer,
  createCanvas,
  makeNode,
  mockSettings,
  request,
  until,
} from '../testing'
import { StoryboardBatches, storyboardBatchesOf } from '../runs/storyboard-batch'
import { Approvals, type Approval } from './approvals'
import { AgentChanges } from './changes'
import { TurnExecution } from './execution'
import { callTool, type McpTool } from './mcp'
import { AgentPlan } from './plan'
import { agentTools, canvasTools } from './tools'

afterEach(() => vi.restoreAllMocks())

async function setup(mode: AgentApprovalMode = 'rules', withExecution = false) {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  const shots: Shot[] = [1, 2].map((no) => ({
    id: `shot-${no}`,
    no,
    duration: 3,
    shotSize: '中景',
    description: `画面${no}`,
    characters: [],
    emotion: '',
    lighting: '',
    sfx: '脚步声',
    dialogue: [{ id: `line-${no}`, character: '小林', line: `台词${no}` }],
    imagePrompt: `画面${no}`,
    motionPrompt: '缓缓推进',
  }))
  const board = addNode(doc, 'plein/storyboard', { params: { shots } })
  expandShots(
    doc,
    board,
    shots.map((shot) => shot.id),
    makeNode,
  )
  const node = (index: number, role = 'image') =>
    expandedNodes(doc, board)
      .get(shots[index]!.id)!
      .find((el) => (el.params?.source as ShotSource)?.role === role)!.id
  const env = {
    canvasId: id,
    ownerId: 'local',
    rooms: server.rooms,
    runs: server.runs,
    host: server.plugins,
    assets: server.assets,
    library: server.library,
  }
  const changes = new AgentChanges('batch-test', id, 'local', server.rooms, server.runs)
  changes.begin('turn')
  const approvals = new Approvals((approval) => {
    if (!observed.some((item) => item.id === approval.id)) observed.push(approval)
  })
  const observed: Approval[] = []
  const execution = withExecution
    ? new TurnExecution(
        'turn',
        () => true,
        () => {},
      )
    : undefined
  const tools = agentTools({ ...env, execution }, { changes, approvals, mode: () => mode })
  const call = (name: string, args: Record<string, unknown>) => invoke(tools, name, args)
  const wait = async (group: string) => {
    await until(() => server.runs.groupState(group, 'local')?.status === 'done', 15_000)
    return server.runs.groupState(group, 'local')!
  }
  return {
    server,
    id,
    doc,
    shots,
    board,
    node,
    env,
    changes,
    approvals,
    observed,
    execution,
    tools,
    call,
    wait,
  }
}

async function invoke(tools: McpTool[], name: string, args: Record<string, unknown>) {
  const result = await callTool(
    tools.find((tool) => tool.name === name)!,
    args,
  )
  const text = result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
  return { result, text, json: <T = Record<string, unknown>>() => JSON.parse(text) as T }
}

const hold = () => {
  let release!: () => void, enter!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  return { entered, enter, waiting, release }
}

describe('Agent 与 UI 共用批量清单', () => {
  it('计划模式允许只读预检，但尚未批准计划时不执行生成', async () => {
    const f = await setup()
    const plan = new AgentPlan(() => {})
    plan.begin(true)
    const tools = agentTools(f.env, {
      changes: f.changes,
      approvals: f.approvals,
      mode: () => 'rules',
      plan,
    })
    const input = { id: f.board, role: 'image' }
    expect(
      (await invoke(tools, 'run_storyboard', { ...input, preview_only: true })).json().status,
    ).toBe('ready_for_review')
    expect((await invoke(tools, 'run_storyboard', input)).text).toContain('计划模式')
    expect(f.observed).toHaveLength(0)
    expect(f.server.runs.list(f.id).groups).toHaveLength(0)
    f.changes.release()
  })
  it('只读预检零提交，与 HTTP 清单一致；HTTP token 可由 Agent 批准原范围', async () => {
    const f = await setup()
    const submit = vi.spyOn(mockProvider, 'submit')
    const args = { id: f.board, role: 'image' }
    const preview = (await f.call('run_storyboard', { ...args, preview_only: true })).json<{
      status: string
      plan: StoryboardBatchPlan
    }>()
    expect(preview.status).toBe('ready_for_review')
    expect(f.observed).toHaveLength(0)
    expect(submit).not.toHaveBeenCalled()
    const http = await request(f.server, API.storyboardBatchPreview(f.id, f.board), {
      method: 'POST',
      body: JSON.stringify(preview.plan.request),
    })
    const plan = (await http.json()) as StoryboardBatchPlan
    expect(plan.summary).toEqual(preview.plan.summary)
    expect(
      plan.rows.map((row) => [
        row.nodeId,
        row.action,
        row.reason,
        row.input?.prompt,
        row.input?.inputHash,
      ]),
    ).toEqual(
      preview.plan.rows.map((row) => [
        row.nodeId,
        row.action,
        row.reason,
        row.input?.prompt,
        row.input?.inputHash,
      ]),
    )
    const pending = (await f.call('run_storyboard', { ...args, token: plan.token })).json<{
      approval_id: string
      plan: Record<string, unknown>
    }>()
    expect(pending.plan).not.toHaveProperty('token')
    expect(f.observed[0]!.storyboardBatch).not.toHaveProperty('token')
    expect(f.observed[0]!.storyboardBatch?.rows).toHaveLength(2)
    expect(submit).not.toHaveBeenCalled()
    expect(f.approvals.decide(pending.approval_id, true)).toBe(true)
    const started = (
      await f.call('await_approval', { approval_id: pending.approval_id, wait_seconds: 0 })
    ).json<{ group_id: string }>()
    expect((await f.wait(started.group_id)).summary?.succeeded).toBe(2)
    expect(submit).toHaveBeenCalledTimes(2)
    const again = (
      await f.call('await_approval', { approval_id: pending.approval_id, wait_seconds: 0 })
    ).json()
    expect(again.group_id).toBe(started.group_id)
    expect(f.approvals.decide(pending.approval_id, true)).toBe(false)
    expect(f.server.runs.list(f.id).groups).toHaveLength(1)
    f.changes.release()
  })

  it('批准期间输入变化只返回新清单，不消费新版授权或提交；新清单须再次确认', async () => {
    const f = await setup()
    const submit = vi.spyOn(mockProvider, 'submit')
    const args = { id: f.board, role: 'image' }
    const pending = (await f.call('run_storyboard', args)).json<{ approval_id: string }>()
    setParams(f.doc, f.node(0), { prompt: '用户修改的镜头' })
    f.approvals.decide(pending.approval_id, true)
    const changed = (
      await f.call('await_approval', { approval_id: pending.approval_id, wait_seconds: 0 })
    ).json<{ status: string; plan: StoryboardBatchPlan }>()
    expect(changed.status).toBe('input_changed')
    expect(changed.plan.rows[0]!.input?.prompt).toContain('用户修改')
    expect(submit).not.toHaveBeenCalled()
    expect(f.server.runs.list(f.id).groups).toHaveLength(0)
    const next = (await f.call('run_storyboard', { ...args, token: changed.plan.token })).json<{
      status: string
      approval_id: string
    }>()
    expect(next.status).toBe('needs_approval')
    expect(next.approval_id).not.toBe(pending.approval_id)
    f.approvals.decide(next.approval_id, true)
    const started = (
      await f.call('await_approval', { approval_id: next.approval_id, wait_seconds: 0 })
    ).json<{ group_id: string }>()
    await f.wait(started.group_id)
    expect(submit).toHaveBeenCalledTimes(2)
    f.changes.release()
  })

  it('默认补缺，指定镜头出新候选；恢复未知任务保留阻塞且不隐式运行', async () => {
    const f = await setup()
    addResults(f.doc, f.node(0), [
      {
        id: 'adopted',
        port: 'images',
        value: { type: 'image', assetId: 'a'.repeat(64) },
        runId: 'old',
        at: 1,
      },
    ])
    const preview = async (args: Record<string, unknown> = {}) =>
      (
        await f.call('run_storyboard', {
          id: f.board,
          role: 'image',
          preview_only: true,
          ...args,
        })
      ).json<{ plan: StoryboardBatchPlan }>()
    expect((await preview()).plan.summary).toMatchObject({ run: 1, reuse: 1 })
    expect((await preview({ shot_ids: [f.shots[0]!.id] })).plan.summary).toMatchObject({
      run: 1,
      reuse: 0,
    })
    expect(
      (await preview({ shot_ids: [f.shots[0]!.id], reuse_existing: true })).plan.summary,
    ).toMatchObject({ run: 0, reuse: 1 })
    f.server.runs.store.insert({
      id: 'unknown',
      ownerId: 'local',
      canvasId: f.id,
      nodeId: f.node(1),
      nodeType: 'plein/image',
    })
    f.server.runs.store.update('unknown', {
      status: 'failed',
      recovery: JSON.stringify({ state: 'submit_unknown' }),
    })
    const blocked = (await preview()).plan
    expect(blocked.summary).toMatchObject({ run: 0, blocked: 1, reuse: 1 })
    expect(blocked.rows.find((row) => row.nodeId === f.node(1))?.reason).toContain('原任务')
    expect((await f.call('run_storyboard', { id: f.board, role: 'image' })).json().status).toBe(
      'nothing_to_run',
    )
    expect(currentResult(f.doc.get(f.node(0))!)?.id).toBe('adopted')
    f.changes.release()
  })

  it('auto 的四类生成统一为 reviewed batch，不制造人工批准', async () => {
    const f = await setup('auto')
    for (const role of ['image', 'video', 'speech', 'sfx']) {
      const started = (await f.call('run_storyboard', { id: f.board, role })).json<{
        group_id: string
      }>()
      expect(started.group_id).toBeTruthy()
      const group = await f.wait(started.group_id)
      expect(group.summary?.succeeded).toBe(2)
      expect(f.server.runs.store.batchItems(started.group_id)).toHaveLength(2)
    }
    expect(f.observed).toHaveLength(0)
    expect(f.server.runs.list(f.id).groups).toHaveLength(4)
    f.changes.release()
  })

  it('always 拒绝与过期不执行，预检 token 受范围、身份与服务生命周期约束', async () => {
    const f = await setup('always')
    const submit = vi.spyOn(mockProvider, 'submit')
    const args = { id: f.board, role: 'image' }
    const pending = (await f.call('run_storyboard', args)).json<{ approval_id: string }>()
    f.approvals.decide(pending.approval_id, false)
    expect(
      (await f.call('await_approval', { approval_id: pending.approval_id, wait_seconds: 0 })).text,
    ).toContain('跳过')
    const expired = (await f.call('run_storyboard', args)).json<{ approval_id: string }>()
    f.approvals.expireAll()
    expect(f.approvals.decide(expired.approval_id, true)).toBe(false)
    const preview = (await f.call('run_storyboard', { ...args, preview_only: true })).json<{
      plan: StoryboardBatchPlan
    }>()
    const service = storyboardBatchesOf(f.server.runs)
    expect(() => service.get(f.id, f.board, 'other', preview.plan.token)).toThrow('过期')
    expect(() => service.get('other', f.board, 'local', preview.plan.token)).toThrow('过期')
    expect(() =>
      new StoryboardBatches(f.server.runs).get(f.id, f.board, 'local', preview.plan.token),
    ).toThrow('过期')
    expect(
      (await f.call('run_storyboard', { ...args, role: 'video', token: preview.plan.token })).text,
    ).toContain('范围与请求不一致')
    const clock = vi.spyOn(Date, 'now').mockReturnValue(preview.plan.expiresAt + 1)
    expect(() => service.get(f.id, f.board, 'local', preview.plan.token)).toThrow('过期')
    clock.mockRestore()
    expect(submit).not.toHaveBeenCalled()
    f.changes.release()
  })

  it('HTTP 与 Agent 并发消费同一 token 只能创建一个组', async () => {
    const f = await setup('auto')
    const preview = (
      await invoke(canvasTools(f.env), 'run_storyboard', {
        id: f.board,
        role: 'image',
        preview_only: true,
      })
    ).json<{ plan: StoryboardBatchPlan }>()
    const out = await Promise.all([
      f.call('run_storyboard', { id: f.board, role: 'image', token: preview.plan.token }),
      request(f.server, API.storyboardBatchCommit(f.id, f.board), {
        method: 'POST',
        body: JSON.stringify({ token: preview.plan.token }),
      }),
    ])
    expect(f.server.runs.list(f.id).groups).toHaveLength(1)
    const group = f.server.runs.list(f.id).groups[0]!
    await f.wait(group.id)
    expect(out[0].result.isError || out[1].status === 409 || out[1].status === 400).toBeTruthy()
    f.changes.release()
  })

  it('高版本只读文档不能建立可执行清单；已取清单或待批准后升级也不能生成', async () => {
    const f = await setup()
    const submit = vi.spyOn(mockProvider, 'submit')
    const args = { id: f.board, role: 'image' }
    const preview = (await f.call('run_storyboard', { ...args, preview_only: true })).json<{
      plan: StoryboardBatchPlan
    }>()
    const pending = (await f.call('run_storyboard', { ...args, token: preview.plan.token })).json<{
      approval_id: string
    }>()
    f.doc.meta.set('schemaVersion', SCHEMA_VERSION + 1)
    expect(
      (
        await request(f.server, API.storyboardBatchCommit(f.id, f.board), {
          method: 'POST',
          body: JSON.stringify({ token: preview.plan.token }),
        })
      ).status,
    ).toBe(400)
    f.approvals.decide(pending.approval_id, true)
    expect(
      (await f.call('await_approval', { approval_id: pending.approval_id, wait_seconds: 0 })).text,
    ).toContain('只读')
    expect((await f.call('run_storyboard', { ...args, preview_only: true })).text).toContain('只读')
    expect((await f.call('run_storyboard', { ...args, token: preview.plan.token })).text).toContain(
      '只读',
    )
    expect(
      (
        await request(f.server, API.storyboardBatchPreview(f.id, f.board), {
          method: 'POST',
          body: JSON.stringify(preview.plan.request),
        })
      ).status,
    ).toBe(400)
    expect(submit).not.toHaveBeenCalled()
    expect(f.server.runs.list(f.id).groups).toHaveLength(0)
    f.changes.release()
  })

  it.each(['http', 'agent'] as const)(
    '%s 提交重算 await 期间只升级 schema 也不能排队',
    async (entry) => {
      const f = await setup('auto')
      const submit = vi.spyOn(mockProvider, 'submit')
      const args = { id: f.board, role: 'image' }
      const preview = (await f.call('run_storyboard', { ...args, preview_only: true })).json<{
        plan: StoryboardBatchPlan
      }>()
      const held = hold()
      const original = f.server.runs.inspect.bind(f.server.runs)
      vi.spyOn(f.server.runs, 'inspect').mockImplementationOnce(async (...args) => {
        held.enter()
        await held.waiting
        return original(...args)
      })
      const pending =
        entry === 'agent'
          ? f.call('run_storyboard', { ...args, token: preview.plan.token }).then((out) => out.text)
          : Promise.resolve(
              request(f.server, API.storyboardBatchCommit(f.id, f.board), {
                method: 'POST',
                body: JSON.stringify({ token: preview.plan.token }),
              }),
            ).then((out) => out.text())
      await held.entered
      f.doc.meta.set('schemaVersion', SCHEMA_VERSION + 1)
      held.release()
      expect(await pending).toContain('只读')
      expect(submit).not.toHaveBeenCalled()
      expect(f.server.runs.list(f.id).groups).toHaveLength(0)
      f.changes.release()
    },
  )

  it('预检 await 期间停止不创建迟到审批或任务', async () => {
    const f = await setup('rules', true)
    const original = f.server.runs.inspect.bind(f.server.runs)
    const held = hold()
    vi.spyOn(f.server.runs, 'inspect').mockImplementationOnce(async (...args) => {
      held.enter()
      await held.waiting
      return original(...args)
    })
    const pending = f.call('run_storyboard', { id: f.board, role: 'image' })
    await held.entered
    f.execution!.close('stopped')
    held.release()
    expect((await pending).text).toContain('turn_closed')
    expect(f.observed).toHaveLength(0)
    expect(f.server.runs.list(f.id).groups).toHaveLength(0)
    f.changes.release()
  })

  it.each(['stop', 'expiry'] as const)('批准后的重算 await 期间 %s 不提交原清单', async (mode) => {
    const f = await setup('rules', true)
    const submit = vi.spyOn(mockProvider, 'submit')
    const pending = (await f.call('run_storyboard', { id: f.board, role: 'image' })).json<{
      approval_id: string
    }>()
    const approval = f.approvals.get(pending.approval_id)!
    const original = f.server.runs.inspect.bind(f.server.runs)
    const held = hold()
    vi.spyOn(f.server.runs, 'inspect').mockImplementationOnce(async (...args) => {
      held.enter()
      await held.waiting
      return original(...args)
    })
    expect(f.approvals.decide(pending.approval_id, true)).toBe(true)
    await held.entered
    let restoreClock: (() => void) | undefined
    if (mode === 'stop') f.execution!.close('stopped')
    else {
      const clock = vi.spyOn(Date, 'now').mockReturnValue(approval.storyboardBatch!.expiresAt + 1)
      restoreClock = () => clock.mockRestore()
    }
    held.release()
    await expect(approval.result).rejects.toThrow(mode === 'stop' ? 'turn_closed' : '过期')
    restoreClock?.()
    expect(f.approvals.decide(pending.approval_id, true)).toBe(false)
    expect(submit).not.toHaveBeenCalled()
    expect(f.server.runs.list(f.id).groups).toHaveLength(0)
    f.changes.release()
  })
})
