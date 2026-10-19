import { expandedNodes, expandShots, type ShotSource } from '@plein/capabilities'
import {
  connect,
  createDoc,
  createElement,
  currentResult,
  type PleinDoc,
  setParams,
} from '@plein/doc'
import { type Shot, STORYBOARD_TYPE } from '@plein/nodes'
import type { EditPlan } from '@plein/protocol'
import { mockProvider } from '@plein/providers'
import { describe, expect, it, vi } from 'vite-plus/test'
import { Approvals } from '../agent/approvals'
import { AgentChanges } from '../agent/changes'
import { McpServer } from '../agent/mcp'
import { agentTools, canvasTools, type ToolEnv } from '../agent/tools'
import type { Server } from '../app'
import { addNode, bootServer, makeNode, createCanvas, mockSettings, until } from '../testing'

const make = makeNode

const shot = (no: number): Shot => ({
  id: `shot_${no}`,
  no,
  duration: 4,
  shotSize: '中景',
  description: `第 ${no} 镜`,
  characters: ['林夏'],
  emotion: '',
  lighting: '',
  sfx: '',
  dialogue: [{ character: '林夏', line: `第 ${no} 句台词` }],
  imagePrompt: `第 ${no} 镜画面`,
  motionPrompt: '缓慢推近',
})

const sourceOf = (doc: PleinDoc, id: string) => doc.get(id)?.params?.source as ShotSource

/** 六镜头项目：角色卡带参考图，分镜展开成图 → 视频 + 配音，全部跑出结果 */
async function sixShots() {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id: canvas, doc } = await createCanvas(server)
  const hero = addNode(doc, 'plein/character', {
    name: '林夏',
    params: { description: '短发，白衬衫' },
  })
  const portrait = createElement(doc, {
    kind: 'image',
    assetId: 'a'.repeat(64),
    x: 0,
    y: -300,
    w: 10,
    h: 10,
  })
  connect(doc, [portrait, 'image'], [hero, 'references'])
  const board = addNode(doc, STORYBOARD_TYPE, {
    name: '分镜',
    params: { shots: [1, 2, 3, 4, 5, 6].map(shot) },
    x: -800,
  })
  expandShots(
    doc,
    board,
    [1, 2, 3, 4, 5, 6].map((n) => `shot_${n}`),
    make,
  )
  const byShot = (n: number, role: ShotSource['role']) =>
    expandedNodes(doc, board)
      .get(`shot_${n}`)!
      .find((el) => sourceOf(doc, el.id).role === role)!.id
  const all = [1, 2, 3, 4, 5, 6].flatMap((n) =>
    (['image', 'video', 'speech'] as const).map((r) => byShot(n, r)),
  )
  for (const role of ['image', 'video', 'speech'] as const)
    for (const n of [1, 2, 3, 4, 5, 6]) {
      const run = server.runs.start(canvas, byShot(n, role), 'local')
      expect(await server.runs.wait(run)).toBe('succeeded')
    }
  const env: ToolEnv = {
    canvasId: canvas,
    ownerId: 'local',
    rooms: server.rooms,
    runs: server.runs,
    host: server.plugins,
    assets: server.assets,
    plans: server.plans,
  }
  return { server, canvas, doc, board, hero, byShot, all, env, mcp: mcpOf(canvasTools(env)) }
}

let seq = 0
function mcpOf(tools: ConstructorParameters<typeof McpServer>[1]) {
  const server = new McpServer({ name: 'plein', version: 'test' }, tools)
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await server.handle({
      jsonrpc: '2.0',
      id: ++seq,
      method: 'tools/call',
      params: { name, arguments: args },
    })) as { result: { content: Array<{ text?: string }>; isError?: boolean } }
    const text = r.result.content[0]?.text ?? ''
    if (r.result.isError) throw new Error(text)
    return JSON.parse(text)
  }
}

/** 画布上全部任务数：每个任务对应一次运行，mock 平台下就是付费调用的次数 */
const jobCount = (server: Server, canvas: string) => server.runs.list(canvas, 1000).jobs.length

const jobsOf = (server: Server, canvas: string, node: string) =>
  server.runs.list(canvas, 1000).jobs.filter((j) => j.nodeId === node).length

const adopted = (doc: PleinDoc, ids: string[]) =>
  Object.fromEntries(ids.map((id) => [id, currentResult(doc.get(id)!)?.id]))

async function waitGroup(server: Server, groupId: string) {
  for (;;) {
    const g = server.runs.groupState(groupId, 'local')!
    if (g.status !== 'running') return g
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** 在原提示词（含 @ 引用）后加上紧张感 */
const tense = (doc: PleinDoc, id: string) =>
  `${String(doc.get(id)!.params!.prompt)}，手持晃动，压迫感更强`

describe('智能体修改方案', () => {
  it('仅候选方案不接管正在运行的其他任务，也不先改写文字', async () => {
    const { server } = await bootServer()
    mockSettings(server, { latencyMs: 1000 })
    const { id, doc } = await createCanvas(server)
    const node = addNode(doc, 'plein/image', { params: { prompt: '保留原文' } })
    const plan = await server.plans.propose(id, 'local', {
      summary: '只出候选',
      edits: [{ id: node, params: { prompt: '候选新文字' } }],
    })
    const running = server.runs.start(id, node, 'local')
    await until(() => server.runs.store.get(running)?.calls.includes('pending'))
    await expect(
      server.plans.apply(
        plan.id,
        'local',
        { scope: 'images' },
        {
          write: (fn) => server.rooms.withDoc(id, fn),
        },
      ),
    ).rejects.toThrow('目标节点正在运行')
    expect(doc.get(node)!.params!.prompt).toBe('保留原文')
    const group = server.runs.runImpact(id, 'local', {
      nodes: [node],
      force: true,
      candidateOnly: true,
    })
    await waitGroup(server, group.groupId)
    expect(server.runs.batchItems(group.groupId, 'local')?.[0]).toMatchObject({ outcome: 'review' })
    expect(jobCount(server, id)).toBe(1)
    server.runs.cancel(id, node)
    await server.runs.wait(running)
  })

  it.each(['failed', 'canceled', 'restart'] as const)(
    '仅候选任务 %s 后保留原采用，恢复成功也只入候选',
    async (mode) => {
      const first = await bootServer()
      const { server } = first
      mockSettings(server, {})
      const { id, doc } = await createCanvas(server)
      const node = addNode(doc, 'plein/image', { params: { prompt: '原画面' } })
      expect(await server.runs.wait(server.runs.start(id, node, 'local'))).toBe('succeeded')
      await until(() => !server.runs.isRunning(id, node))
      const original = currentResult(doc.get(node)!)!.id
      const plan = await server.plans.propose(id, 'local', {
        summary: '只出新候选',
        edits: [{ id: node, params: { prompt: '新画面' } }],
      })
      mockSettings(server, mode === 'failed' ? { failWith: 'auth' } : { latencyMs: 1000 })
      const submit = vi.spyOn(mockProvider, 'submit')
      try {
        const applied = await server.plans.apply(
          plan.id,
          'local',
          { scope: 'images' },
          {
            write: (fn) => server.rooms.withDoc(id, fn),
          },
        )
        const group = applied.applied!.groupId!
        if (mode !== 'failed')
          await until(
            () => server.runs.list(id).jobs.find((j) => j.groupId === group)?.recovery?.remoteId,
          )
        if (mode === 'canceled') server.runs.cancelGroup(group, 'local')
        let active = server
        let current = doc
        if (mode === 'restart') {
          await first.close()
          active = (await bootServer({ dataDir: first.dataDir })).server
          current = createDoc(active.rooms.get(id).doc, { schedule: () => {} })
        }
        await waitGroup(active, group)
        expect(currentResult(current.get(node)!)?.id).toBe(original)
        const job = active.runs.list(id).jobs.find((j) => j.groupId === group)!
        expect(job.status).toBe(mode === 'restart' ? 'succeeded' : mode)
        if (mode === 'restart') {
          expect(job.recovery).toMatchObject({ state: 'stored', held: 'candidate_only' })
          expect(current.get(node)!.results).toHaveLength(2)
          current.destroy()
        }
        expect(submit).toHaveBeenCalledTimes(1)
      } finally {
        submit.mockRestore()
      }
    },
  )

  it('方案列出目标、字段前后值、实际参考、执行阶段与保留项；只批准文字修改时零调用', async () => {
    const { server, canvas, doc, byShot, mcp } = await sixShots()
    const img3 = byShot(3, 'image')
    const TENSE = tense(doc, img3)
    const before = String(doc.get(img3)!.params!.prompt)
    const plan = await mcp('propose_edit', {
      summary: '让第三镜头更紧张',
      edits: [{ id: img3, params: { prompt: TENSE } }],
    })
    expect(plan.status).toBe('pending')
    expect(plan.targets).toEqual([
      expect.objectContaining({
        id: img3,
        shot_id: 'shot_3',
        shot: '第 3 镜',
        changes: [{ field: 'prompt', before, after: TENSE }],
      }),
    ])
    // 镜头图和它的视频要重做；同镜头的配音保留；其余五个镜头不在方案里
    expect(plan.steps).toEqual([
      expect.objectContaining({ id: img3, stage: 'image', scope: 'images' }),
      expect.objectContaining({ id: byShot(3, 'video'), stage: 'video', scope: 'full' }),
    ])
    expect(plan.keep).toEqual([expect.stringContaining('同一镜头')])
    expect(plan.untouched).toBe(15)
    expect(plan.estimate).toEqual({
      text: '不调用平台',
      images: '调用平台 1 次，价格未知',
      full: '调用平台 2 次，价格未知',
    })
    // 完整方案对象里带着绑定的版本和实际参考
    const full = server.plans.get(plan.plan_id, 'local')!
    expect(full.targets[0]!.inputHash).toMatch(/^v2:/)
    expect(full.targets[0]!.refs.map((r) => r.name)).toContain('林夏')
    // 提出方案不改画布
    expect(doc.get(img3)!.params!.prompt).toBe(before)

    const jobs = jobCount(server, canvas)
    const applied = await mcp('apply_edit_plan', { plan_id: plan.plan_id, scope: 'text' })
    expect(applied.status).toBe('applied')
    expect(applied.applied).toEqual({ scope: 'text', targets: [img3], nodes: [] })
    expect(doc.get(img3)!.params!.prompt).toBe(TENSE)
    expect(jobCount(server, canvas)).toBe(jobs)
    // 方案只能执行一次
    await expect(mcp('apply_edit_plan', { plan_id: plan.plan_id, scope: 'full' })).rejects.toThrow(
      '已经执行过',
    )
  })

  it('批准完整方案：只运行第三镜头的图和视频，其余镜头的结果和配音不变', async () => {
    const { server, canvas, doc, byShot, all, mcp } = await sixShots()
    const img3 = byShot(3, 'image')
    const TENSE = tense(doc, img3)
    const vid3 = byShot(3, 'video')
    const others = all.filter((id) => id !== img3 && id !== vid3)
    const kept = adopted(doc, others)
    const jobs = jobCount(server, canvas)
    const plan = await mcp('propose_edit', {
      summary: '让第三镜头更紧张',
      edits: [{ id: img3, params: { prompt: TENSE } }],
    })
    // 同时批准两次：只执行一次
    const apply = () => mcp('apply_edit_plan', { plan_id: plan.plan_id, scope: 'full' })
    const [applied, second] = (await Promise.allSettled([apply(), apply()])) as [
      PromiseSettledResult<{ applied: { nodes: string[]; group_id: string } }>,
      PromiseSettledResult<unknown>,
    ]
    expect(second.status).toBe('rejected')
    if (applied.status !== 'fulfilled') throw new Error('第一次批准应当成功')
    expect(applied.value.applied.nodes).toEqual([img3, vid3])
    expect((await waitGroup(server, applied.value.applied.group_id)).status).toBe('done')
    expect(jobCount(server, canvas)).toBe(jobs + 2)
    expect(jobsOf(server, canvas, img3)).toBe(2)
    expect(jobsOf(server, canvas, vid3)).toBe(2)
    expect(adopted(doc, others)).toEqual(kept)
  })

  it('只出候选图；方案涉及两个镜头时只批准第三镜头，第四镜头不改也不运行', async () => {
    const { server, canvas, doc, byShot, mcp } = await sixShots()
    const img3 = byShot(3, 'image')
    const TENSE = tense(doc, img3)
    const img4 = byShot(4, 'image')
    const prompt4 = doc.get(img4)!.params!.prompt
    const plan = await mcp('propose_edit', {
      summary: '第三、四镜头更紧张',
      edits: [
        { id: img3, params: { prompt: TENSE } },
        { id: img4, params: { prompt: '第 4 镜画面，冷色逆光' } },
      ],
    })
    expect(plan.estimate.images).toBe('调用平台 2 次，价格未知')
    const jobs = jobCount(server, canvas)
    const original = currentResult(doc.get(img3)!)!.id
    const observed: Array<string | undefined> = []
    const unsubscribe = doc.subscribe(() => observed.push(currentResult(doc.get(img3)!)?.id))
    const applied = await mcp('apply_edit_plan', {
      plan_id: plan.plan_id,
      scope: 'images',
      only: ['shot_3'],
    })
    expect(applied.applied.nodes).toEqual([img3])
    await waitGroup(server, applied.applied.group_id)
    unsubscribe()
    expect(currentResult(doc.get(img3)!)?.id).toBe(original)
    expect(observed.every((id) => id === original)).toBe(true)
    const candidate = doc.get(img3)!.results!.find((r) => r.id !== original)!
    expect(candidate).toBeDefined()
    const job = server.runs.list(canvas, 1000).jobs.find((j) => j.id === candidate.runId)!
    expect(job.recovery).toMatchObject({ state: 'stored', held: 'candidate_only' })
    const downstream = await server.runs.preview(canvas, byShot(3, 'video'), 'local')
    expect(
      Object.values(downstream.inputs)
        .flat()
        .find((v) => v.source === img3)?.resultId,
    ).toBe(original)
    expect(server.runs.batchItems(applied.applied.group_id, 'local')?.[0]?.resultId).toBe(
      candidate.id,
    )
    expect(jobCount(server, canvas)).toBe(jobs + 1)
    expect(jobsOf(server, canvas, byShot(3, 'video'))).toBe(1)
    expect(jobsOf(server, canvas, img4)).toBe(1)
    expect(doc.get(img4)!.params!.prompt).toBe(prompt4)
    // 同样输入已存在候选时沿用它，但依然不能自动采用。
    setParams(doc, img3, { prompt: `${TENSE}，临时修改` })
    const again = await mcp('propose_edit', {
      summary: '再次只查看第三镜头候选',
      edits: [{ id: img3, params: { prompt: TENSE } }],
    })
    const reused = await mcp('apply_edit_plan', { plan_id: again.plan_id, scope: 'images' })
    await waitGroup(server, reused.applied.group_id)
    expect(jobCount(server, canvas)).toBe(jobs + 1)
    expect(currentResult(doc.get(img3)!)?.id).toBe(original)
    expect(server.runs.batchItems(reused.applied.group_id, 'local')?.[0]).toMatchObject({
      outcome: 'cached',
      resultId: candidate.id,
    })
  })

  it('批准前目标变了：不执行旧方案，要求重新检查', async () => {
    const { server, canvas, doc, hero, byShot, mcp } = await sixShots()
    const img3 = byShot(3, 'image')
    const TENSE = tense(doc, img3)
    const plan = await mcp('propose_edit', {
      summary: '让第三镜头更紧张',
      edits: [{ id: img3, params: { prompt: TENSE } }],
    })
    // 用户自己又改了这个镜头（保留 @ 引用）
    const mine = `${String(doc.get(img3)!.params!.prompt)}，雨更大`
    setParams(doc, img3, { prompt: mine })
    const jobs = jobCount(server, canvas)
    const stale = await mcp('apply_edit_plan', { plan_id: plan.plan_id, scope: 'full' })
    expect(stale.status).toBe('stale')
    expect(stale.changed).toEqual([img3])
    expect(stale.next).toContain('重新')
    expect(doc.get(img3)!.params!.prompt).toBe(mine)
    expect(jobCount(server, canvas)).toBe(jobs)

    // 参数没动、引用的角色设定变了：实际输入不同，同样不执行
    const again = await mcp('propose_edit', {
      summary: '让第三镜头更紧张',
      edits: [{ id: img3, params: { prompt: TENSE } }],
    })
    setParams(doc, hero, { description: '长发，黑色风衣' })
    const changed = await mcp('apply_edit_plan', { plan_id: again.plan_id, scope: 'text' })
    expect(changed.status).toBe('stale')
    expect(changed.changed).toContain(img3)
    expect(doc.get(img3)!.params!.prompt).toBe(mine)
  })

  it('逐项编辑：改字段的新值、去掉一个目标后重新检查；批准时跳过视频只出图', async () => {
    const { server, canvas, doc, byShot, mcp } = await sixShots()
    const img3 = byShot(3, 'image')
    const vid3 = byShot(3, 'video')
    const img4 = byShot(4, 'image')
    const prompt4 = doc.get(img4)!.params!.prompt
    const plan = await mcp('propose_edit', {
      summary: '第三、四镜头更紧张',
      edits: [
        { id: img3, params: { prompt: tense(doc, img3) } },
        { id: img4, params: { prompt: '第 4 镜画面，冷色逆光' } },
      ],
    })
    expect(plan.estimate.full).toBe('调用平台 4 次，价格未知')

    // 用户在卡片上把第三镜头的提示词改成自己的写法，并去掉第四镜头
    const MINE = `${String(doc.get(img3)!.params!.prompt)}，只留一盏顶灯`
    const revised = await server.plans.revise(plan.plan_id, 'local', [
      { id: img3, params: { prompt: MINE } },
    ])
    expect(revised.id).toBe(plan.plan_id)
    expect(revised.revised).toBe(1)
    expect(revised.status).toBe('pending')
    expect(revised.targets.map((t) => [t.nodeId, t.changes[0]!.after])).toEqual([[img3, MINE]])
    expect(revised.steps.map((s) => s.nodeId)).toEqual([img3, vid3])
    expect(revised.estimate.full.calls).toBe(2)
    expect(revised.targets[0]!.refs.map((r) => r.name)).toContain('林夏')
    // 重新检查也不改画布
    expect(doc.get(img3)!.params!.prompt).not.toBe(MINE)

    // 和现在一样的改动不算方案
    await expect(
      server.plans.revise(plan.plan_id, 'local', [{ id: img4, params: { prompt: prompt4 } }]),
    ).rejects.toThrow('一样')

    const jobs = jobCount(server, canvas)
    const applied = await mcp('apply_edit_plan', {
      plan_id: plan.plan_id,
      scope: 'full',
      skip: [vid3],
    })
    expect(applied).toMatchObject({ status: 'applied', revised_by_user: 1 })
    expect(applied.applied.nodes).toEqual([img3])
    await waitGroup(server, applied.applied.group_id)
    expect(jobCount(server, canvas)).toBe(jobs + 1)
    expect(jobsOf(server, canvas, vid3)).toBe(1)
    expect(doc.get(img3)!.params!.prompt).toBe(MINE)
    expect(doc.get(img4)!.params!.prompt).toBe(prompt4)
    // 执行过的方案不能再改
    await expect(
      server.plans.revise(plan.plan_id, 'local', [{ id: img3, params: { prompt: 'x' } }]),
    ).rejects.toThrow('已经执行过')
  })

  it('会话里方案卡片按范围批准；整轮撤销回退文字，任务记录和新候选都保留', async () => {
    const { server, canvas, doc, byShot, env } = await sixShots()
    const img3 = byShot(3, 'image')
    const TENSE = tense(doc, img3)
    const before = doc.get(img3)!.params!.prompt
    const changes = new AgentChanges('agt_edit', canvas, 'local', server.rooms, server.runs)
    const cards: Array<{ id: string; plan: EditPlan }> = []
    const approvals = new Approvals(() => {})
    const call = mcpOf(
      agentTools(
        {
          ...env,
          origin: changes.origin,
          onRun: (n, r) => changes.recordRun(n, r),
          onGroup: (g) => changes.recordGroup(g),
        },
        {
          changes,
          approvals,
          mode: () => 'rules',
          onEditPlan: (id, plan) => cards.push({ id, plan }),
        },
      ),
    )
    changes.begin('t1')
    const proposed = await call('propose_edit', {
      summary: '让第三镜头更紧张',
      edits: [{ id: img3, params: { prompt: TENSE } }],
    })
    expect(proposed.status).toBe('needs_approval')
    expect(cards.at(-1)).toMatchObject({ id: proposed.approval_id, plan: { status: 'pending' } })
    // 智能体绕过卡片自己执行生成，也要先问
    const direct = await call('apply_edit_plan', {
      plan_id: proposed.plan.plan_id,
      scope: 'images',
    })
    expect(direct.status).toBe('needs_approval')

    const jobs = jobCount(server, canvas)
    expect(approvals.decide(proposed.approval_id, true, { scope: 'images' })).toBe(true)
    const done = await call('await_approval', { approval_id: proposed.approval_id })
    expect(done).toMatchObject({ status: 'applied', scope: 'images' })
    await waitGroup(server, done.applied.group_id)
    expect(cards.at(-1)!.plan.status).toBe('applied')
    const runs = server.runs.list(canvas, 1000).jobs.filter((j) => j.nodeId === img3)
    expect(runs).toHaveLength(2)
    expect(jobCount(server, canvas)).toBe(jobs + 1)
    expect(doc.get(img3)!.params!.prompt).toBe(TENSE)

    changes.end()
    expect(changes.undoTurn('t1')).toBe(true)
    expect(doc.get(img3)!.params!.prompt).toBe(before)
    // 撤销只回退画布改动：已经提交的任务和生成的候选都还在
    expect(server.runs.list(canvas, 1000).jobs.filter((j) => j.nodeId === img3)).toEqual(runs)
    expect(doc.get(img3)!.results).toHaveLength(2)
    changes.release()
  })
})
