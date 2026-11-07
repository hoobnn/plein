import { describe, expect, it } from 'vite-plus/test'
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
