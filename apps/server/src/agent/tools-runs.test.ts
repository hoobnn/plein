import { writeRun } from '@plein/doc'
import { describe, expect, it } from 'vite-plus/test'
import { batchItems } from '../storage/schema'
import { addNode, bootServer, createCanvas } from '../testing'
import { approvalFor } from './approvals'
import type { AgentChanges } from './changes'
import { serverCapabilities, serverContext, type ToolEnv } from './tools'

describe('run_nodes', () => {
  it('复用 runs.runBatch：返回 group_id，确认写明数量，参数 1..50 校验', async () => {
    const { server } = await bootServer()
    const { id, doc } = await createCanvas(server)
    const a = addNode(doc, 'plein/image', { name: '甲' })
    const b = addNode(doc, 'plein/image', { name: '乙' })
    const calls: Array<{ source: string; nodes: string[] }> = []
    const runs = Object.create(server.runs) as typeof server.runs
    runs.runBatch = (_canvas, source, nodes) => {
      calls.push({ source, nodes })
      return { groupId: 'grp-test', total: nodes.length }
    }
    const groups: string[] = []
    const env: ToolEnv = {
      canvasId: id,
      ownerId: 'local',
      rooms: server.rooms,
      runs,
      host: server.plugins,
      assets: server.assets,
      canvasApi: server.canvasApi,
      onGroup: (g) => groups.push(g),
    }
    const ctx = serverContext(env)
    const out = await serverCapabilities.invoke('run_nodes', ctx, { ids: [a, b] })
    expect(out).toEqual({ group_id: 'grp-test', total: 2 })
    expect(calls).toEqual([{ source: a, nodes: [a, b] }])
    expect(groups).toEqual(['grp-test'])

    const cap = serverCapabilities.get('run_nodes')!
    expect(serverCapabilities.effectOf(cap, { ids: [a] }, ctx)).toBe('run')
    const changes = { createdThisTurn: () => false, runCount: 0 } as unknown as AgentChanges
    const ask = approvalFor('rules', cap as never, { ids: [a, b] }, ctx, changes)
    expect(ask?.reason).toContain('2 个节点')
    expect(ask?.ids).toEqual([a, b])
    await expect(serverCapabilities.invoke('run_nodes', ctx, { ids: [] })).rejects.toThrow()
    await expect(
      serverCapabilities.invoke('run_nodes', ctx, {
        ids: Array.from({ length: 51 }, (_, i) => `n${i}`),
      }),
    ).rejects.toThrow()
  })
})

it('旧任务续等、查看和取消都绑定原运行，同一节点的新运行保留', async () => {
  const { server } = await bootServer()
  const { id: canvasId, doc } = await createCanvas(server)
  const node = addNode(doc, 'plein/image', { params: { prompt: '当前预检' } })
  const ctx = serverContext({
    canvasId,
    ownerId: 'local',
    rooms: server.rooms,
    runs: server.runs,
    host: server.plugins,
    assets: server.assets,
  })
  const invoke = (name: string, args: Record<string, unknown>) =>
    serverCapabilities.invoke(name, ctx, args)
  const input = await server.runs.preview(canvasId, node, 'local')
  for (const [id, ownerId] of [
    ['old', 'local'],
    ['new', 'local'],
    ['foreign', 'other'],
  ] as const)
    server.runs.store.insert({ id, nodeId: node, ownerId, canvasId, nodeType: 'plein/image' })
  server.runs.store.update('old', {
    status: 'failed',
    error: '原任务失败',
    input: JSON.stringify({ ...input, prompt: '原任务输入' }),
  })
  writeRun(doc, node, { id: 'new', status: 'running', at: Date.now() })
  expect(await invoke('wait_for_run', { id: node, run_id: 'old', wait_seconds: 0 })).toMatchObject({
    run_id: 'old',
    status: 'failed',
    error: '原任务失败',
  })
  expect(await invoke('get_job', { job_id: 'old' })).toMatchObject({
    id: 'old',
    status: 'failed',
    has_input: true,
  })
  expect(
    await invoke('inspect_node_input', { id: node, run_id: 'old', field_path: '/prompt' }),
  ).toMatchObject({ run_id: 'old', value: '原任务输入' })
  await expect(invoke('wait_for_run', { id: 'other-node', run_id: 'old' })).rejects.toThrow(
    '没有这个任务',
  )
  await expect(invoke('get_job', { job_id: 'foreign' })).rejects.toThrow('没有这个任务')
  await expect(invoke('cancel_run', { id: node, run_id: 'old' })).rejects.toThrow(
    '旧停止请求未执行',
  )
  expect(doc.get(node)?.run).toMatchObject({ id: 'new', status: 'running' })
  await invoke('cancel_run', { id: node, run_id: 'new' })
  expect(doc.get(node)?.run).toMatchObject({ id: 'new', status: 'canceled' })
  expect(await invoke('cancel_run', { id: node })).toContain('没有正在运行')
})

it('批次明细按所有者、批次和页读取，包括没有生成任务的待复核项', async () => {
  const { server } = await bootServer()
  const { id: canvasId } = await createCanvas(server)
  server.runs.store.insertGroup({
    id: 'original',
    ownerId: 'local',
    canvasId,
    frameId: 'a',
    options: { video: true, force: false },
    targets: ['a', 'b'],
  })
  server.db
    .insert(batchItems)
    .values([
      {
        group_id: 'original',
        node_id: 'a',
        seq: 0,
        stage: 'reuse',
        outcome: 'cached',
        result_id: 'previous',
        updated_at: 1,
      },
      {
        group_id: 'original',
        node_id: 'b',
        seq: 1,
        stage: 'run',
        outcome: 'review',
        reason: '等待采用',
        deps: JSON.stringify([{ nodeId: 'a' }]),
        updated_at: 2,
      },
    ])
    .run()
  const query = (ownerId: string, offset: number) =>
    serverCapabilities.invoke(
      'get_group_items',
      serverContext({
        canvasId: '',
        ownerId,
        rooms: server.rooms,
        runs: server.runs,
        host: server.plugins,
        assets: server.assets,
      }),
      { group_id: 'original', limit: 1, offset },
    )
  expect(await query('local', 0)).toMatchObject({
    canvas_id: canvasId,
    next_offset: 1,
    items: [{ nodeId: 'a', outcome: 'cached', resultId: 'previous' }],
  })
  const last = await query('local', 1)
  expect(last).toMatchObject({
    items: [{ nodeId: 'b', outcome: 'review', reason: '等待采用', dependency_count: 1 }],
  })
  expect(last).not.toHaveProperty('next_offset')
  await expect(query('other', 0)).rejects.toThrow('没有这个批次')
})
