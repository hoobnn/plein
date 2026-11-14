import {
  addResults,
  adoptResult,
  connect,
  createDoc,
  currentResult,
  removeEdges,
  setParams,
  type PleinDoc,
} from '@plein/doc'
import { ProviderError } from '@plein/plugin-sdk'
import { mockProvider } from '@plein/providers'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import type { Server } from '../app'
import { addCharacter, addNode, bootServer, createCanvas, mockSettings, until } from '../testing'
import { snapshotBatch } from './batch'
import { type NodeRuns, runGraph } from './runs'

afterEach(() => vi.restoreAllMocks())

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

let groupId = 0
function snapshotGroup(server: Server, canvasId: string, targets: string[]) {
  const group = { id: `snapshot_${++groupId}`, canvas_id: canvasId, owner_id: 'local' }
  server.runs.store.insertGroup({
    id: group.id,
    canvasId,
    ownerId: 'local',
    frameId: targets[0]!,
    options: { video: true, force: false },
    targets,
  })
  return group
}

function spyPreparation(runs: NodeRuns) {
  return vi.spyOn(runs as unknown as { prepare(...args: unknown[]): Promise<unknown> }, 'prepare')
}

async function firstResult(server: Server, canvasId: string, nodeId: string) {
  const run = server.runs.start(canvasId, nodeId, 'local')
  expect(await server.runs.wait(run)).toBe('succeeded')
  await until(() => !server.runs.isRunning(canvasId, nodeId))
}

const done = (server: Server, groupId: string) =>
  until(() => {
    const group = server.runs.groupState(groupId, 'local')
    return group?.status !== 'running' && group
  })

describe('批次输入快照', () => {
  it.each([false, true])(
    '批次快照持续无法写入时停止提交并处理记录失败（组记录也失败：%s）',
    async (groupUnavailable) => {
      const { server } = await bootServer()
      const { id, doc } = await createCanvas(server)
      const node = addNode(doc, 'plein/image', { params: { prompt: 'no snapshot storage' } })
      const submit = vi.spyOn(mockProvider, 'submit')
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.spyOn(server.runs.store, 'insertBatchItems').mockImplementation(() => {
        throw new Error('batch storage unavailable')
      })
      const finish = vi.spyOn(server.runs.store, 'finishGroup')
      if (groupUnavailable)
        finish.mockImplementation(() => {
          throw new Error('group storage unavailable')
        })
      const group = server.runs.runBatch(id, node, [node], 'local')
      await until(() => finish.mock.calls.length === 1)
      expect(submit).not.toHaveBeenCalled()
      expect(doc.get(node)?.run).toBeUndefined()
      expect(errors).toHaveBeenCalledWith(
        `[runs] 批次 ${group.groupId} 的检查失败明细尚未写入`,
        expect.any(Error),
      )
      if (groupUnavailable) {
        expect(errors).toHaveBeenCalledWith(
          `[runs] 批次 ${group.groupId} 已停止，结束状态尚未写入`,
          expect.any(Error),
        )
        expect(server.runs.groupState(group.groupId, 'local')?.status).toBe('running')
      } else
        expect(server.runs.groupState(group.groupId, 'local')).toMatchObject({
          status: 'done',
          summary: { failed: 1 },
        })
    },
  )

  it('重复目标只记录和运行一次，不产生冲突快照或残留运行组', async () => {
    const { server } = await bootServer()
    mockSettings(server, { latencyMs: 0 })
    const { id, doc } = await createCanvas(server)
    const node = addNode(doc, 'plein/image', { params: { prompt: 'one target' } })
    const submit = vi.spyOn(mockProvider, 'submit')
    const group = server.runs.runBatch(id, node, [node, node], 'local')
    expect(group.total).toBe(1)
    expect(await done(server, group.groupId)).toMatchObject({
      status: 'done',
      summary: { succeeded: 1, failed: 0 },
    })
    expect(submit).toHaveBeenCalledTimes(1)
    expect(server.runs.batchItems(group.groupId, 'local')).toHaveLength(1)
    expect(server.runs.store.activeGroups()).toHaveLength(0)
  })

  it('快照失败时已取消的批次保持取消事实，不提交或误记成检查失败', async () => {
    const { server } = await bootServer()
    const { id, doc } = await createCanvas(server)
    const node = addNode(doc, 'plein/image')
    const entered = deferred()
    const release = deferred()
    const submit = vi.spyOn(mockProvider, 'submit')
    vi.spyOn(server.runs, 'inspect').mockImplementationOnce(async () => {
      entered.resolve()
      await release.promise
      throw new Error('aborted inspection')
    })
    const group = server.runs.runBatch(id, node, [node], 'local')
    await entered.promise
    server.runs.cancelGroup(group.groupId, 'local')
    release.resolve()
    expect(await done(server, group.groupId)).toMatchObject({
      status: 'canceled',
      summary: { canceled: 1, failed: 0 },
    })
    expect(submit).not.toHaveBeenCalled()
    expect(server.runs.batchItems(group.groupId, 'local')?.[0]).toMatchObject({
      outcome: 'canceled',
      reason: '批次已取消',
    })
  })

  it.each(['inspect', 'persist'] as const)(
    '快照 %s 失败停止批次并保存原因，不绕过批准输入继续提交',
    async (failure) => {
      const { server } = await bootServer()
      mockSettings(server, { latencyMs: 0 })
      const { id, doc } = await createCanvas(server)
      const node = addNode(doc, 'plein/image', { params: { prompt: 'needs snapshot' } })
      const submit = vi.spyOn(mockProvider, 'submit')
      if (failure === 'inspect')
        vi.spyOn(server.runs, 'inspect').mockRejectedValueOnce(new Error('snapshot unavailable'))
      else
        vi.spyOn(server.runs.store, 'insertBatchItems').mockImplementationOnce(() => {
          throw new Error('snapshot unavailable')
        })

      const group = server.runs.runBatch(id, node, [node], 'local')
      const state = await done(server, group.groupId)
      expect(submit).not.toHaveBeenCalled()
      expect(state).toMatchObject({ status: 'done', summary: { failed: 1, succeeded: 0 } })
      expect(server.runs.batchItems(group.groupId, 'local')).toEqual([
        expect.objectContaining({
          nodeId: node,
          stage: 'blocked',
          outcome: 'review',
          reason: expect.stringContaining('snapshot unavailable'),
        }),
      ])
      expect(doc.get(node)?.run).toBeUndefined()
      expect(server.runs.store.activeGroups()).toHaveLength(0)
    },
  )

  it.each(['reuse', 'force', 'rerun'] as const)(
    '%s 模式每个节点只检查和准备一次，保留缓存、新节点和阻断输入的区别',
    async (mode) => {
      const { server } = await bootServer()
      mockSettings(server, { latencyMs: 0 })
      const { id, doc } = await createCanvas(server)
      const cached = addNode(doc, 'plein/image', { params: { prompt: 'cached' } })
      await firstResult(server, id, cached)
      const fresh = addNode(doc, 'plein/image', { params: { prompt: 'new' } })
      const blocked = addNode(doc, 'plein/image', { params: { prompt: 'blocked' } })
      const missing = addNode(doc, 'plein/image')
      connect(doc, [missing, 'images'], [blocked, 'references'])
      const targets = [cached, fresh, blocked, 'deleted']
      const group = snapshotGroup(server, id, targets)
      const inspect = vi.spyOn(server.runs, 'inspect')
      const prepare = spyPreparation(server.runs)
      await snapshotBatch(
        server.runs,
        group,
        doc,
        targets,
        runGraph(doc),
        { force: mode === 'force', rerun: new Set(mode === 'rerun' ? [cached] : []) },
        new AbortController().signal,
      )
      expect(inspect.mock.calls.map(([, el]) => el.id)).toEqual([cached, fresh, blocked])
      expect(prepare).toHaveBeenCalledTimes(3)
      expect(inspect.mock.calls.every(([copy]) => copy.ydoc !== doc.ydoc)).toBe(true)
      const rows = server.runs.batchItems(group.id, 'local')!
      expect(rows.map((row) => [row.nodeId, row.stage])).toEqual([
        [cached, mode === 'reuse' ? 'reuse' : 'run'],
        [fresh, 'run'],
        [blocked, 'blocked'],
      ])
      expect(rows[2]!.input).toMatchObject({ status: 'unprepared' })
      expect(inspect.mock.calls[0]![0].ydoc.isDestroyed).toBe(true)
      expect(doc.ydoc.isDestroyed).toBe(false)
    },
  )

  it('检查等待期间的编辑不混入已开始的快照，后续节点仍读同一份参数、连线和上游结果', async () => {
    const { server } = await bootServer()
    mockSettings(server, { latencyMs: 0 })
    const { id, doc } = await createCanvas(server)
    const upstream = addNode(doc, 'plein/image', { params: { prompt: 'before upstream' } })
    await firstResult(server, id, upstream)
    const result = currentResult(doc.get(upstream)!)!
    const asset = result.value
    if (asset.type !== 'image') throw new Error('上游没有图片结果')
    const downstream = addNode(doc, 'plein/image', { params: { prompt: 'before downstream' } })
    connect(doc, [upstream, 'images'], [downstream, 'references'])
    const edgeIds = [...doc.edges()].map((edge) => edge.id)
    const targets = [upstream, downstream]
    const group = snapshotGroup(server, id, targets)
    const entered = deferred()
    const release = deferred()
    const actualInspect = server.runs.inspect.bind(server.runs)
    const inspect = vi.spyOn(server.runs, 'inspect').mockImplementationOnce(async (...args) => {
      entered.resolve()
      await release.promise
      return actualInspect(...args)
    })
    const prepare = spyPreparation(server.runs)
    const snapshot = snapshotBatch(
      server.runs,
      group,
      doc,
      targets,
      runGraph(doc),
      { rerun: new Set([upstream]) },
      new AbortController().signal,
    )
    await entered.promise
    setParams(doc, upstream, { prompt: 'after upstream' })
    setParams(doc, downstream, { prompt: 'after downstream' })
    removeEdges(doc, edgeIds)
    release.resolve()
    await snapshot
    const rows = server.runs.batchItems(group.id, 'local')!
    expect(rows[0]).toMatchObject({ stage: 'run', input: { prompt: 'before upstream' } })
    expect(rows[1]).toMatchObject({
      stage: 'run',
      deps: [{ nodeId: upstream, resultId: result.id }],
      input: {
        prompt: 'before downstream',
        inputs: { references: [{ type: 'image', assetId: asset.assetId }] },
      },
    })
    expect(inspect).toHaveBeenCalledTimes(2)
    expect(prepare).toHaveBeenCalledTimes(2)
    expect(doc.get(downstream)?.params?.prompt).toBe('after downstream')
    expect([...doc.edges()]).toHaveLength(0)
  })

  it('检查失败也销毁副本，不留下部分批次快照或销毁原文档', async () => {
    const { server } = await bootServer()
    const { id, doc } = await createCanvas(server)
    const node = addNode(doc, 'plein/image')
    const group = snapshotGroup(server, id, [node])
    const inspect = vi.spyOn(server.runs, 'inspect').mockRejectedValueOnce(new Error('interrupted'))
    await expect(
      snapshotBatch(
        server.runs,
        group,
        doc,
        [node],
        runGraph(doc),
        { rerun: new Set() },
        new AbortController().signal,
      ),
    ).rejects.toThrow('interrupted')
    expect(inspect.mock.calls[0]![0].ydoc.isDestroyed).toBe(true)
    expect(doc.ydoc.isDestroyed).toBe(false)
    expect(server.runs.store.batchItems(group.id)).toEqual([])
  })

  it('已确认保留的过期结果复用同一次检查，强制或明确重跑仍执行新任务', async () => {
    const { server } = await bootServer()
    mockSettings(server, { latencyMs: 0 })
    const { id, doc } = await createCanvas(server)
    const node = addNode(doc, 'plein/image', { params: { prompt: 'before' } })
    await firstResult(server, id, node)
    const kept = currentResult(doc.get(node)!)!.id
    setParams(doc, node, { prompt: 'after' })
    const input = await server.runs.preview(id, node, 'local')
    server.runs.store.insertDecision({
      id: 'keep-snapshot',
      owner_id: 'local',
      canvas_id: id,
      node_id: node,
      result_id: kept,
      input_hash: input.inputHash!,
      causes: '[]',
      note: null,
      created_at: Date.now(),
    })
    const inspect = vi.spyOn(server.runs, 'inspect')
    const prepare = spyPreparation(server.runs)
    const submit = vi.spyOn(mockProvider, 'submit')
    const reused = server.runs.runFlow(id, node, 'local', { scope: 'upstream', force: false })
    expect((await done(server, reused.groupId)).summary).toMatchObject({ cached: 1, succeeded: 0 })
    expect(server.runs.batchItems(reused.groupId, 'local')![0]?.stage).toBe('reuse')
    expect(currentResult(doc.get(node)!)?.id).toBe(kept)
    expect(submit).not.toHaveBeenCalled()
    expect(inspect.mock.calls.filter(([copy]) => copy.ydoc !== doc.ydoc)).toHaveLength(1)
    expect(
      prepare.mock.calls.filter(([copy]) => (copy as PleinDoc).ydoc !== doc.ydoc),
    ).toHaveLength(1)
    const forced = server.runs.runFlow(id, node, 'local', { scope: 'upstream', force: true })
    expect((await done(server, forced.groupId)).summary).toMatchObject({ succeeded: 1, cached: 0 })
    expect(server.runs.batchItems(forced.groupId, 'local')![0]?.stage).toBe('run')
    const rerun = server.runs.runFlow(id, node, 'local', { scope: 'downstream', force: false })
    expect((await done(server, rerun.groupId)).summary).toMatchObject({ succeeded: 1, cached: 0 })
    expect(server.runs.batchItems(rerun.groupId, 'local')![0]?.stage).toBe('run')
    expect(submit).toHaveBeenCalledTimes(2)
  })

  it('快照等待期间原输入变化，真正提交前仍复核并拒绝付费调用', async () => {
    const { server } = await bootServer()
    mockSettings(server, { latencyMs: 0 })
    const { id, doc } = await createCanvas(server)
    const node = addNode(doc, 'plein/image', { params: { prompt: 'approved' } })
    const entered = deferred()
    const release = deferred()
    const actualInspect = server.runs.inspect.bind(server.runs)
    vi.spyOn(server.runs, 'inspect').mockImplementationOnce(async (...args) => {
      const inspection = await actualInspect(...args)
      entered.resolve()
      await release.promise
      return inspection
    })
    const submit = vi.spyOn(mockProvider, 'submit')
    const group = server.runs.runFlow(id, node, 'local', { scope: 'upstream', force: false })
    await entered.promise
    setParams(doc, node, { prompt: 'unapproved edit' })
    release.resolve()
    // 复核拒绝不算失败：目标单列为「待重新审查」，既没提交也没有产出。
    expect((await done(server, group.groupId)).summary).toMatchObject({
      failed: 0,
      review: 1,
      succeeded: 0,
    })
    expect(server.runs.batchItems(group.groupId, 'local')![0]).toMatchObject({
      input: { prompt: 'approved' },
      outcome: 'review',
    })
    expect(submit).not.toHaveBeenCalled()
    expect(currentResult(doc.get(node)!)).toBeUndefined()
  })

  it('已有未知提交的节点即使强制批量运行也不再次提交', async () => {
    const { server } = await bootServer()
    mockSettings(server, { latencyMs: 0 })
    const { id, doc } = await createCanvas(server)
    const node = addNode(doc, 'plein/image', { params: { prompt: 'unknown' } })
    vi.spyOn(mockProvider, 'lookup').mockResolvedValue(null)
    const submit = vi
      .spyOn(mockProvider, 'submit')
      .mockRejectedValue(new ProviderError('unavailable', 'network lost', { outcome: 'unknown' }))
    const original = server.runs.start(id, node, 'local')
    expect(await server.runs.wait(original)).toBe('failed')
    await until(() => !server.runs.isRunning(id, node))
    const before = server.runs.store.get(original)!
    const group = server.runs.runFlow(id, node, 'local', { scope: 'upstream', force: true })
    expect((await done(server, group.groupId)).summary).toMatchObject({ failed: 1, succeeded: 0 })
    expect(server.runs.list(id).jobs[0]?.recovery?.state).toBe('submit_unknown')
    expect(server.runs.store.get(original)).toEqual(before)
    expect(submit).toHaveBeenCalledTimes(1)
  })
})

describe('批量出分镜图', () => {
  it('镜头 @ 到的角色卡还没出定妆图时先出，出完再出镜头图；已有的沿用', async () => {
    const { server } = await bootServer()
    mockSettings(server, {})
    const { id, doc } = await createCanvas(server)
    const hero = addCharacter(doc, '林夏', { description: '二十岁，短发' }, { x: 300 })
    const portrait = addNode(doc, 'plein/image', { params: { prompt: '林夏的定妆参考图' } })
    connect(doc, [portrait, 'images'], [hero, 'references'])
    const shots = [1, 2].map((i) =>
      addNode(doc, 'plein/image', { params: { prompt: `@林夏 镜头 ${i}` }, x: 600 * i }),
    )

    const done = async (groupId: string) => {
      await until(() => server.runs.groupState(groupId, 'local')?.status !== 'running', 20_000)
      return server.runs.groupState(groupId, 'local')!
    }
    const first = server.runs.runBatch(id, shots[0]!, shots, 'local')
    expect(first.total).toBe(3)
    expect((await done(first.groupId)).summary).toMatchObject({ succeeded: 3, failed: 0 })

    const jobs = server.runs.list(id).jobs
    const of = (node: string) => jobs.find((j) => j.nodeId === node)!
    for (const s of shots) expect(of(s).startedAt!).toBeGreaterThanOrEqual(of(portrait).finishedAt!)
    expect(currentResult(doc.get(portrait)!)?.value.type).toBe('image')

    // 再批量一次：定妆图没改，沿用；镜头图照常重跑
    const again = server.runs.runBatch(id, shots[0]!, shots, 'local')
    expect((await done(again.groupId)).summary).toMatchObject({ succeeded: 2, cached: 1 })
  }, 30_000)
})

describe('批次批准时的采用基线', () => {
  /** 上游要重新生成、下游要等它：同时准备两个已有候选并采用 A */
  function waitingPair(doc: PleinDoc) {
    const up = addNode(doc, 'plein/image', { params: { prompt: '批量上游' } })
    const down = addNode(doc, 'plein/image', { params: { prompt: '批量下游' }, x: 300 })
    connect(doc, [up, 'images'], [down, 'references'])
    addResults(
      doc,
      down,
      ['a', 'b'].map((k, i) => ({
        id: `cand-${k}`,
        runId: `old-${k}`,
        port: 'images',
        at: i + 1,
        value: { type: 'image', assetId: k.repeat(64) },
      })),
      { adopt: false },
    )
    adoptResult(doc, down, 'cand-a')
    doc.mutable(down)!.set('adoptionRevision', 'rev-a')
    return { up, down }
  }

  async function awaiting(
    server: Server,
    canvasId: string,
    groupId: string,
    up: string,
    down: string,
  ) {
    await until(() => {
      const item = server.runs.store.batchItem(groupId, down)
      return item?.outcome === 'pending' && !item.job_id && server.runs.isRunning(canvasId, up)
    })
  }

  it('等待上游期间改选 B：批准基线不变，晚到结果只进候选', async () => {
    const { server } = await bootServer()
    mockSettings(server, { latencyMs: 350 })
    const { id, doc } = await createCanvas(server)
    const { up, down } = waitingPair(doc)
    const group = server.runs.runFlow(id, down, 'local', { scope: 'upstream', force: true })
    await awaiting(server, id, group.groupId, up, down)
    // 快照里已经记下批准时的采用身份
    expect(JSON.parse(server.runs.store.batchItem(group.groupId, down)!.adoption!)).toEqual({
      result: 'cand-a',
      revision: 'rev-a',
    })

    adoptResult(doc, down, 'cand-b')
    doc.mutable(down)!.set('adoptionRevision', 'rev-b')
    await done(server, group.groupId)
    const item = server.runs.store.batchItem(group.groupId, down)!
    expect(item.outcome).toBe('succeeded')
    expect(doc.get(down)?.adopted).toBe('cand-b')
    const job = server.runs.store.get(item.job_id!)!
    expect(JSON.parse(job.recovery!).held).toBe('adopted_during_run')
    // 系统写入不改人工采用版本
    expect(doc.mutable(down)!.get('adoptionRevision')).toBe('rev-b')
  })

  it('等待期间 A→B→A（含撤销回退）也保住人工选择', async () => {
    const { server } = await bootServer()
    mockSettings(server, { latencyMs: 350 })
    const { id, doc } = await createCanvas(server)
    const { up, down } = waitingPair(doc)
    const group = server.runs.runFlow(id, down, 'local', { scope: 'upstream', force: true })
    await awaiting(server, id, group.groupId, up, down)

    adoptResult(doc, down, 'cand-b')
    doc.mutable(down)!.set('adoptionRevision', 'rev-b')
    adoptResult(doc, down, 'cand-a')
    doc.mutable(down)!.set('adoptionRevision', 'rev-c')
    await done(server, group.groupId)
    const item = server.runs.store.batchItem(group.groupId, down)!
    expect(item.outcome).toBe('succeeded')
    expect(doc.get(down)?.adopted).toBe('cand-a')
    expect(JSON.parse(server.runs.store.get(item.job_id!)!.recovery!).held).toBe(
      'adopted_during_run',
    )
  })

  it('没人动过采用时，批次结束照常自动采用新结果', async () => {
    const { server } = await bootServer()
    mockSettings(server, { latencyMs: 200 })
    const { id, doc } = await createCanvas(server)
    const { down } = waitingPair(doc)
    const group = server.runs.runFlow(id, down, 'local', { scope: 'upstream', force: true })
    await done(server, group.groupId)
    const item = server.runs.store.batchItem(group.groupId, down)!
    expect(item.outcome).toBe('succeeded')
    expect(doc.get(down)?.adopted).toBe(item.result_id)
    expect(doc.get(down)?.adopted).not.toBe('cand-a')
  })

  it('旧批次没有采用基线时仍按开始时刻冻结，兼容原有行为', async () => {
    const { server } = await bootServer()
    mockSettings(server, { latencyMs: 350 })
    const { id, doc } = await createCanvas(server)
    const { up, down } = waitingPair(doc)
    const group = server.runs.runFlow(id, down, 'local', { scope: 'upstream', force: true })
    await awaiting(server, id, group.groupId, up, down)
    // 模拟升级前的批次记录
    server.db.$client
      .prepare('UPDATE batch_items SET adoption = NULL WHERE group_id = ? AND node_id = ?')
      .run(group.groupId, down)
    adoptResult(doc, down, 'cand-b')
    doc.mutable(down)!.set('adoptionRevision', 'rev-b')
    await done(server, group.groupId)
    const item = server.runs.store.batchItem(group.groupId, down)!
    // 没有基线：按 start 这一刻的采用冻结，新结果自动采用（旧行为）
    expect(doc.get(down)?.adopted).toBe(item.result_id)
  })

  it('重启后继续的批次仍按批准时的采用基线判断', async () => {
    const first = await bootServer()
    mockSettings(first.server, { latencyMs: 300 })
    const { id, doc } = await createCanvas(first.server)
    const { up, down } = waitingPair(doc)
    const group = first.server.runs.runFlow(id, down, 'local', { scope: 'upstream', force: true })
    await awaiting(first.server, id, group.groupId, up, down)
    adoptResult(doc, down, 'cand-b')
    doc.mutable(down)!.set('adoptionRevision', 'rev-b')
    expect(first.server.rooms.get(id).persistNow()).toBe(true)
    await first.close()

    const second = await bootServer({ dataDir: first.dataDir })
    mockSettings(second.server, { latencyMs: 200 })
    const reopened = createDoc(second.server.rooms.get(id).doc, { schedule: () => {} })
    await until(
      () => second.server.runs.groupState(group.groupId, 'local')?.status !== 'running',
      15_000,
    )
    const item = second.server.runs.store.batchItem(group.groupId, down)!
    expect(item.outcome).toBe('succeeded')
    expect(reopened.get(down)?.adopted).toBe('cand-b')
    expect(JSON.parse(second.server.runs.store.get(item.job_id!)!.recovery!).held).toBe(
      'adopted_during_run',
    )
  })

  it('缓存候选与人工采用不一致时标记需审，不让下游拿到未采用的候选', async () => {
    const { server } = await bootServer()
    mockSettings(server, { latencyMs: 0 })
    const { id, doc } = await createCanvas(server)
    const up = addNode(doc, 'plein/image', { params: { prompt: '缓存候选与采用' } })
    const down = addNode(doc, 'plein/image', { params: { prompt: '下游要等上游' }, x: 300 })
    connect(doc, [up, 'images'], [down, 'references'])
    addResults(doc, up, [
      {
        id: 'cached-a',
        runId: 'run-a',
        port: 'images',
        at: 1,
        value: { type: 'image', assetId: 'a'.repeat(64) },
      },
      {
        id: 'cached-b',
        runId: 'run-b',
        port: 'images',
        at: 2,
        value: { type: 'image', assetId: 'b'.repeat(64) },
      },
    ])
    adoptResult(doc, up, 'cached-a')
    const submit = vi.spyOn(mockProvider, 'submit')

    const insert = server.runs.store.insertBatchItems.bind(server.runs.store)
    vi.spyOn(server.runs.store, 'insertBatchItems').mockImplementation((rows) => {
      insert(rows)
      // 快照落库之后、目标开始之前：用户改用了另一个候选
      adoptResult(doc, up, 'cached-b')
    })
    vi.spyOn(server.runs, 'isFresh').mockResolvedValue(false)
    vi.spyOn(server.runs, 'isKept').mockResolvedValue(false)
    vi.spyOn(server.runs, 'cachedCandidate').mockImplementation((el) =>
      el.id === up ? 'auto-hit' : undefined,
    )
    const group = server.runs.runImpact(id, 'local', { nodes: [up, down], force: false })
    await done(server, group.groupId)

    const item = server.runs.store.batchItem(group.groupId, up)!
    // 没有沿用、也没有采用：批次明确标记需审，而不是登记一个没采用的候选结果
    expect(item.outcome).toBe('review')
    expect(item.result_id).toBeNull()
    expect(item.reason).toContain('缓存候选与当前采用不一致')
    expect(doc.get(up)?.adopted).toBe('cached-b')
    // 下游不能因为上游的「自动结果」获得提交授权
    const downstream = server.runs.store.batchItem(group.groupId, down)!
    expect(submit).not.toHaveBeenCalled()
    expect(downstream.outcome).not.toBe('succeeded')
    expect(downstream.outcome).not.toBe('cached')
    expect(downstream.result_id ?? null).not.toBe('auto-hit')
  })

  it('没人改过采用时，缓存候选照常沿用并登记为批次结果', async () => {
    const { server } = await bootServer()
    mockSettings(server, { latencyMs: 0 })
    const { id, doc } = await createCanvas(server)
    const node = addNode(doc, 'plein/image', { params: { prompt: '缓存候选照常沿用' } })
    addResults(doc, node, [
      {
        id: 'keep-a',
        runId: 'run-a',
        port: 'images',
        at: 1,
        value: { type: 'image', assetId: 'a'.repeat(64) },
      },
      {
        id: 'keep-b',
        runId: 'run-b',
        port: 'images',
        at: 2,
        value: { type: 'image', assetId: 'b'.repeat(64) },
      },
    ])
    adoptResult(doc, node, 'keep-a')
    vi.spyOn(server.runs, 'isFresh').mockResolvedValue(false)
    vi.spyOn(server.runs, 'isKept').mockResolvedValue(false)
    vi.spyOn(server.runs, 'cachedCandidate').mockReturnValue('keep-b')
    const group = server.runs.runImpact(id, 'local', { nodes: [node], force: false })
    await done(server, group.groupId)
    const item = server.runs.store.batchItem(group.groupId, node)!
    expect(item.outcome).toBe('cached')
    expect(item.result_id).toBe('keep-b')
    expect(doc.get(node)?.adopted).toBe('keep-b')
  })
})
