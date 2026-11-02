import {
  deleteElementsCap,
  expandShots,
  expandedNodes,
  type CapabilityDefinition,
  type ShotSource,
} from '@plein/capabilities'
import { createDoc, createElement, type PleinDoc } from '@plein/doc'
import type { Shot } from '@plein/nodes'
import type { EditPlan } from '@plein/protocol'
import { z } from 'zod'
import { describe, expect, it } from 'vite-plus/test'
import { addNode, bootServer, createCanvas, makeNode, mockSettings } from '../testing'
import { approvalFor, RUN_LIMIT, type Approval } from './approvals'
import { AgentChanges } from './changes'
import { Approvals } from './approvals'
import { callTool } from './mcp'
import { agentTools, serverCapabilities, type ServerContext, type ToolEnv } from './tools'

type Cap = CapabilityDefinition<z.ZodObject, ServerContext>

/**
 * 能力审批与调度器的对照用例：钉住声明化之前的返回值（是否要确认、reason 文案、ids）。
 * 结构调整（审批声明化、tools.ts 拆分）后这些用例必须一字不改地通过。
 */

/** 本轮新建的元素：删它不用问 */
const CREATED = 'created-this-turn'
const MINE = 'mine'
/** 通用确认文案：声明 next 的能力（批量清单、方案卡片）有自己的 */
const GENERIC_NEXT =
  '已请用户在面板里确认。调用 await_approval 等待：用户允许后会直接执行并返回结果，不要重复调用原工具；用户跳过就换个做法或问用户。'

const changesWith = (runCount = 0, created: string[] = [CREATED]) =>
  ({
    createdThisTurn: (id: string) => created.includes(id),
    runCount,
  }) as AgentChanges

function docWith(): { doc: PleinDoc; frame: string; board: string; img: string; vid: string } {
  const doc = createDoc()
  const frame = createElement(doc, { kind: 'frame', name: '板', x: 0, y: 0, w: 100, h: 100 })
  const board = addNode(doc, 'plein/storyboard', { name: '分镜', params: {} })
  const img = addNode(doc, 'plein/image', { name: '图' })
  const vid = addNode(doc, 'plein/video', { name: '视频' })
  return { doc, frame, board, img, vid }
}

const unit = docWith()

const ctxWith = (doc: PleinDoc) =>
  ({
    withDoc: (fn: (d: PleinDoc) => unknown) => fn(doc),
    nodes: {
      latest: (type: string) =>
        type === 'plein/video'
          ? { def: { capability: 'video.generate' }, descriptor: {}, runnable: true }
          : undefined,
    },
  }) as unknown as ServerContext

const cap = (over: { name: string; title: string } & Partial<Cap>) =>
  ({
    where: 'server',
    group: 'read',
    effect: 'read',
    input: z.object({}),
    run: () => null,
    ...over,
  }) as Cap

const get = (name: string) => {
  const def = serverCapabilities.get(name)
  if (!def) throw new Error(`没有能力 ${name}`)
  return def
}

const ask = (
  mode: 'rules' | 'always' | 'auto',
  cap: Cap,
  input: Record<string, unknown>,
  opts: { runCount?: number; created?: string[] } = {},
) => approvalFor(mode, cap, input, ctxWith(unit.doc), changesWith(opts.runCount, opts.created))

const pluginRun = cap({ name: 'acme__spend', title: '插件消费', group: 'plugin', effect: 'run' })
const plainRun = cap({ name: 'plain_run', title: '普通运行', group: 'run', effect: 'run' })
const editCap = cap({ name: 'some_edit', title: '改动', group: 'edit', effect: 'edit' })

describe('approvalFor 对照：各能力的确认策略', () => {
  it('delete_elements：删用户已有的要问，删本轮自己建的不问（含 always）', () => {
    const both = { ids: [CREATED, MINE] }
    expect(ask('auto', deleteElementsCap as Cap, both)).toBeNull()
    expect(ask('always', deleteElementsCap as Cap, both)).toEqual({
      reason: '删除你已有的 1 个元素',
      ids: [MINE],
    })
    expect(ask('rules', deleteElementsCap as Cap, both)).toEqual({
      reason: '删除你已有的 1 个元素',
      ids: [MINE],
    })
    expect(
      ask('always', deleteElementsCap as Cap, { ids: [CREATED] }, { created: [CREATED] }),
    ).toBeNull()
    expect(ask('rules', deleteElementsCap as Cap, { ids: [CREATED] })).toBeNull()
    expect(ask('rules', deleteElementsCap as Cap, { ids: [MINE] })).toEqual({
      reason: '删除你已有的 1 个元素',
      ids: [MINE],
    })
  })

  it('run_frame：整组运行要问，带视频要写明', () => {
    const input = { frame_id: unit.frame, video: false, force: false }
    expect(ask('auto', get('run_frame'), input)).toBeNull()
    expect(ask('always', get('run_frame'), input)).toEqual({
      reason: '整组运行 「板」',
      ids: [unit.frame],
    })
    expect(ask('rules', get('run_frame'), input)).toEqual({
      reason: '整组运行 「板」',
      ids: [unit.frame],
    })
    expect(ask('rules', get('run_frame'), { ...input, video: true })).toEqual({
      reason: '整组运行 「板」（包括视频）',
      ids: [unit.frame],
    })
  })

  it('run_storyboard：批量生成要问，说明按角色', () => {
    const input = { id: unit.board, role: 'image' }
    expect(ask('auto', get('run_storyboard'), input)).toBeNull()
    expect(ask('always', get('run_storyboard'), input)).toEqual({
      reason: '批量生成「分镜」的分镜图',
      ids: [unit.board],
    })
    expect(ask('rules', get('run_storyboard'), input)).toEqual({
      reason: '批量生成「分镜」的分镜图',
      ids: [unit.board],
    })
    expect(ask('rules', get('run_storyboard'), { id: unit.board, role: 'video' })).toEqual({
      reason: '批量生成「分镜」的镜头视频',
      ids: [unit.board],
    })
    expect(ask('rules', get('run_storyboard'), { id: unit.board, role: 'speech' })).toEqual({
      reason: '批量生成「分镜」的配音',
      ids: [unit.board],
    })
    expect(ask('rules', get('run_storyboard'), { id: unit.board, role: 'sfx' })).toEqual({
      reason: '批量生成「分镜」的音效',
      ids: [unit.board],
    })
    expect(ask('rules', get('run_storyboard'), { id: unit.board, role: 'other' })).toEqual({
      reason: '批量生成「分镜」的',
      ids: [unit.board],
    })
  })

  it('apply_edit_plan：按方案执行要问，范围写进确认；只改文字是 edit 不问', () => {
    expect(ask('auto', get('apply_edit_plan'), { scope: 'images' })).toBeNull()
    expect(ask('always', get('apply_edit_plan'), { scope: 'images' })).toEqual({
      reason: '按修改方案生成候选图',
      ids: [],
    })
    expect(ask('rules', get('apply_edit_plan'), { scope: 'images' })).toEqual({
      reason: '按修改方案生成候选图',
      ids: [],
    })
    expect(ask('rules', get('apply_edit_plan'), { scope: 'full' })).toEqual({
      reason: '按修改方案执行全部生成步骤',
      ids: [],
    })
    expect(ask('rules', get('apply_edit_plan'), { scope: 'text' })).toBeNull()
  })

  it('run_flow：上下游运行要问，方向写进确认', () => {
    expect(ask('auto', get('run_flow'), { id: unit.img, scope: 'upstream' })).toBeNull()
    expect(ask('always', get('run_flow'), { id: unit.img, scope: 'upstream' })).toEqual({
      reason: '运行到「图」',
      ids: [unit.img],
    })
    expect(ask('rules', get('run_flow'), { id: unit.img, scope: 'upstream' })).toEqual({
      reason: '运行到「图」',
      ids: [unit.img],
    })
    expect(ask('rules', get('run_flow'), { id: unit.img, scope: 'downstream' })).toEqual({
      reason: '运行下游：「图」',
      ids: [unit.img],
    })
  })

  it('run_node：always 都问；rules 里视频要问、一轮跑满要问，其它不问', () => {
    expect(ask('auto', get('run_node'), { id: unit.img })).toBeNull()
    expect(ask('always', get('run_node'), { id: unit.img })).toEqual({
      reason: '运行 「图」',
      ids: [unit.img],
    })
    expect(ask('rules', get('run_node'), { id: unit.img })).toBeNull()
    expect(ask('rules', get('run_node'), { id: unit.img }, { runCount: RUN_LIMIT - 1 })).toBeNull()
    expect(ask('rules', get('run_node'), { id: unit.img }, { runCount: RUN_LIMIT })).toEqual({
      reason: `运行 「图」：这一轮已经运行了 ${RUN_LIMIT} 次`,
      ids: [unit.img],
    })
    expect(ask('rules', get('run_node'), { id: unit.vid })).toEqual({
      reason: '生成视频 「视频」（较贵、较慢）',
      ids: [unit.vid],
    })
    // 视频优先于次数限制
    expect(ask('rules', get('run_node'), { id: unit.vid }, { runCount: RUN_LIMIT })).toEqual({
      reason: '生成视频 「视频」（较贵、较慢）',
      ids: [unit.vid],
    })
    // always 不带「较贵、较慢」的说法
    expect(ask('always', get('run_node'), { id: unit.vid })).toEqual({
      reason: '运行 「视频」',
      ids: [unit.vid],
    })
  })

  it('perform_canvas_action：确认里写操作标题', () => {
    const input = { action: 'delete_library_item', input: {} }
    expect(ask('auto', get('perform_canvas_action'), input)).toBeNull()
    expect(ask('always', get('perform_canvas_action'), input)).toEqual({
      reason: '删除资产库条目（不能通过画布撤销）',
      ids: [],
    })
    expect(ask('rules', get('perform_canvas_action'), input)).toEqual({
      reason: '删除资产库条目（不能通过画布撤销）',
      ids: [],
    })
  })

  it('recover_job：resubmit 是 run 要问，refetch 是 edit 不问', () => {
    expect(
      ask('auto', get('recover_job'), { job_id: 'j', operation: { action: 'resubmit' } }),
    ).toBeNull()
    expect(
      ask('always', get('recover_job'), { job_id: 'j', operation: { action: 'resubmit' } }),
    ).toEqual({
      reason: '恢复生成任务',
      ids: [],
    })
    expect(
      ask('rules', get('recover_job'), { job_id: 'j', operation: { action: 'resubmit' } }),
    ).toEqual({
      reason: '恢复生成任务',
      ids: [],
    })
    expect(
      ask('rules', get('recover_job'), { job_id: 'j', operation: { action: 'refetch' } }),
    ).toBeNull()
    expect(
      ask('always', get('recover_job'), { job_id: 'j', operation: { action: 'refetch' } }),
    ).toBeNull()
  })

  it('未声明的能力走通用规则：破坏性与插件能力都问，普通 run 只在 always 问', () => {
    const destructive = get('delete_checkpoint')
    expect(ask('auto', destructive, {})).toBeNull()
    expect(ask('always', destructive, {})).toEqual({ reason: '删除检查点', ids: [] })
    expect(ask('rules', destructive, {})).toEqual({ reason: '删除检查点', ids: [] })

    expect(ask('auto', pluginRun, {})).toBeNull()
    expect(ask('always', pluginRun, {})).toEqual({ reason: '插件消费', ids: [] })
    expect(ask('rules', pluginRun, {})).toEqual({ reason: '插件消费', ids: [] })

    expect(ask('auto', plainRun, {})).toBeNull()
    expect(ask('always', plainRun, {})).toEqual({ reason: '普通运行', ids: [] })
    expect(ask('rules', plainRun, {})).toBeNull()

    expect(ask('rules', editCap, {})).toBeNull()
    expect(ask('always', editCap, {})).toBeNull()
  })
})

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

async function invoke(
  tools: ReturnType<typeof agentTools>,
  name: string,
  args: Record<string, unknown>,
) {
  const tool = tools.find((t) => t.name === name)!
  const result = await callTool(tool, args)
  const text = result.content
    .filter((b) => b.type === 'text')
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('\n')
  return {
    result,
    text,
    json: <T = Record<string, unknown>>() => JSON.parse(text) as T,
  }
}

async function storyboardSetup() {
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
  const env: ToolEnv = {
    canvasId: id,
    ownerId: 'local',
    rooms: server.rooms,
    runs: server.runs,
    host: server.plugins,
    assets: server.assets,
  }
  const changes = new AgentChanges('apv-test', id, 'local', server.rooms, server.runs)
  changes.begin('turn')
  const observed: Approval[] = []
  const approvals = new Approvals((a) => {
    if (!observed.some((i) => i.id === a.id)) observed.push(a)
  })
  const tools = agentTools(env, { changes, approvals, mode: () => 'rules' })
  return {
    server,
    id,
    board,
    changes,
    approvals,
    observed,
    call: (name: string, args: Record<string, unknown>) => invoke(tools, name, args),
  }
}

describe('调度器对照：批量清单确认', () => {
  it('run_storyboard 需要确认时的返回形状：reason、plan（无 token）、next 与确认单上的清单', async () => {
    const f = await storyboardSetup()
    const pending = await f.call('run_storyboard', { id: f.board, role: 'image' })
    expect(pending.json()).toEqual({
      status: 'needs_approval',
      approval_id: expect.any(String),
      reason: '批量生成「分镜」的分镜图',
      plan: expect.any(Object),
      next: '具体批量清单已展示给用户。调用 await_approval 等原调用结果，不重复调用 run_storyboard；若返回 input_changed，重新审阅新清单后再请求确认。',
    })
    const plan = pending.json<{ plan: { rows: unknown[] } }>().plan
    expect(plan.rows).toHaveLength(2)
    expect(plan).not.toHaveProperty('token')
    expect(f.observed[0]).toMatchObject({
      tool: 'run_storyboard',
      reason: '批量生成「分镜」的分镜图',
      ids: [f.board],
    })
    expect(f.observed[0]!.storyboardBatch?.rows).toHaveLength(2)
    expect(f.observed[0]!.storyboardBatch).not.toHaveProperty('token')
    // 未批准不执行
    expect(f.server.runs.list(f.id).groups).toHaveLength(0)
    f.changes.release()
  })

  it('run_frame 走通用确认：返回 reason 与通用 next，ids 在确认单上', async () => {
    const f = await storyboardSetup()
    const frame = (await f.call('create_element', { kind: 'frame', name: '板' })).json<{
      id: string
    }>()
    const gated = await f.call('run_frame', { frame_id: frame.id })
    expect(gated.json()).toEqual({
      status: 'needs_approval',
      approval_id: expect.any(String),
      reason: '整组运行 「板」',
      next: GENERIC_NEXT,
    })
    expect(f.observed[0]).toMatchObject({
      tool: 'run_frame',
      reason: '整组运行 「板」',
      ids: [frame.id],
    })
    f.changes.release()
  })
})

describe('调度器对照：方案卡片', () => {
  it('propose_edit 建卡片，按范围执行，跳过的步骤回 skipped_by_user', async () => {
    const { server } = await bootServer()
    mockSettings(server, {})
    const { id, doc } = await createCanvas(server)
    const board = addNode(doc, 'plein/storyboard', { name: '分镜', params: { shots: [shot(1)] } })
    expandShots(doc, board, ['shot-1'], makeNode)
    const expanded = expandedNodes(doc, board).get('shot-1')!
    const byRole = (role: ShotSource['role']) =>
      expanded.find((el) => (el.params?.source as ShotSource)?.role === role)!.id
    const img = byRole('image')
    const vid = byRole('video')
    for (const n of [img, vid])
      expect(await server.runs.wait(server.runs.start(id, n, 'local'))).toBe('succeeded')
    const prompt = String(doc.get(img)!.params!.prompt)
    const TENSE = `${prompt}，手持晃动`

    const changes = new AgentChanges('apv-edit', id, 'local', server.rooms, server.runs)
    changes.begin('t1')
    const cards: Array<{ id: string; plan: EditPlan }> = []
    const approvals = new Approvals(() => {})
    const env: ToolEnv = {
      canvasId: id,
      ownerId: 'local',
      rooms: server.rooms,
      runs: server.runs,
      host: server.plugins,
      assets: server.assets,
      plans: server.plans,
      origin: changes.origin,
      onRun: (n, r) => changes.recordRun(n, r),
      onGroup: (g) => changes.recordGroup(g),
    }
    const tools = agentTools(env, {
      changes,
      approvals,
      mode: () => 'rules',
      onEditPlan: (aid, plan) => cards.push({ id: aid, plan }),
    })
    const call = (name: string, args: Record<string, unknown>) => invoke(tools, name, args)

    const proposed = await call('propose_edit', {
      summary: '让第一镜头更紧张',
      edits: [{ id: img, params: { prompt: TENSE } }],
    })
    expect(proposed.json()).toEqual({
      status: 'needs_approval',
      approval_id: expect.any(String),
      plan: expect.any(Object),
      next: '方案卡片已经给用户看了，用户会选只改文字、只出候选图或完整方案，也可能在卡片上逐项改字段、去掉某个目标或某个步骤。用一句话说明方案要点，然后调用 await_approval 等用户选择；用户批准后服务端直接按范围执行并返回最终方案（以返回里的 targets、applied 为准，revised_by_user / skipped_by_user 表示用户改过），不要再调用 apply_edit_plan。',
    })
    const proposedJson = proposed.json<{
      approval_id: string
      plan: { plan_id: string; summary: string }
    }>()
    const approvalId = proposedJson.approval_id
    expect(approvalId).toBeTruthy()
    expect(proposedJson.plan.summary).toBe('让第一镜头更紧张')
    expect(cards.at(-1)).toMatchObject({ id: approvalId, plan: { status: 'pending' } })

    // 用户批准完整方案但跳过视频步骤：只重跑图，结果带 skipped_by_user
    expect(approvals.decide(approvalId, true, { scope: 'full', skip: [vid] })).toBe(true)
    const done = await call('await_approval', { approval_id: approvalId })
    const out = JSON.parse(done.text) as {
      status: string
      scope: string
      skipped_by_user: string[]
      applied: { nodes: string[] }
    }
    expect(out).toMatchObject({ status: 'applied', scope: 'full', skipped_by_user: [vid] })
    expect(out.applied.nodes).toEqual([img])
    await Promise.resolve()
    // 执行完卡片状态跟着变
    expect(cards.at(-1)!.plan.status).toBe('applied')

    // 再提一个方案，批准时指向不存在的目标：执行失败原样回给模型，卡片还是 pending
    const again = await call('propose_edit', {
      summary: '让镜头更慢',
      edits: [{ id: vid, params: { prompt: '更慢的推近' } }],
    })
    const second = again.json<{ approval_id: string }>()
    expect(
      approvals.decide(second.approval_id, true, { scope: 'full', only: ['missing-id'] }),
    ).toBe(true)
    const failed = await call('await_approval', { approval_id: second.approval_id })
    expect(failed.result.isError).toBe(true)
    expect(failed.text).toContain('方案里没有这些目标')
    expect(cards.at(-1)!.plan.status).toBe('pending')

    changes.end()
    changes.release()
  })
})
