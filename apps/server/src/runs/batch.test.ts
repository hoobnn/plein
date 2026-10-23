import { connect, currentResult, removeEdges, setParams, type PleinDoc } from '@plein/doc'
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
    expect((await done(server, group.groupId)).summary).toMatchObject({ failed: 1, succeeded: 0 })
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
