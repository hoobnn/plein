import { setParams } from '@plein/doc'
import { describe, expect, it } from 'vite-plus/test'
import { addNode, bootServer, createCanvas, mockSettings, until } from '../testing'
import { Approvals } from './approvals'
import { AgentChanges } from './changes'
import { callTool } from './mcp'
import { agentTools, serverCapabilities, serverContext, type ToolEnv } from './tools'

describe('影响面板能力', () => {
  it('查看影响、保留、撤销保留、重做，且受所有权限制', async () => {
    const { server } = await bootServer()
    mockSettings(server, {})
    const { id, doc } = await createCanvas(server)
    const groups: string[] = []
    const env: ToolEnv = {
      canvasId: id,
      ownerId: 'local',
      rooms: server.rooms,
      runs: server.runs,
      host: server.plugins,
      assets: server.assets,
      canvasApi: server.canvasApi,
      onGroup: (g) => groups.push(g),
    }
    const invoke = (name: string, args: unknown, as = env) =>
      serverCapabilities.invoke(name, serverContext(as), args)
    const node = addNode(doc, 'plein/image', { params: { prompt: '一只猫' } })
    const run = server.runs.start(id, node, 'local')
    expect(await server.runs.wait(run)).toBe('succeeded')

    const none = (await invoke('get_impact', {})) as { nodes: unknown[]; total_nodes: number }
    expect(none.total_nodes).toBe(0)

    setParams(doc, node, { prompt: '一只狗' })
    const impact = (await invoke('get_impact', {})) as {
      nodes: Array<{ node_id: string; input_hash?: string; suggest: string }>
      summary: { pending: number }
    }
    expect(impact.nodes.map((n) => n.node_id)).toEqual([node])
    const target = impact.nodes[0]!
    expect(target.input_hash).toBeTruthy()

    await expect(
      invoke('keep_stale', { nodes: [{ node_id: node, input_hash: 'stale' }] }),
    ).rejects.toThrow('重新查看影响')
    const [decision] = (await invoke('keep_stale', {
      nodes: [{ node_id: node, input_hash: target.input_hash }],
      note: '先留着',
    })) as Array<{ id: string; note: string }>
    expect(decision!.note).toBe('先留着')
    const kept = (await invoke('get_impact', {})) as { summary: { kept: number } }
    expect(kept.summary.kept).toBe(1)
    await invoke('revoke_keep', { decision_id: decision!.id })
    await expect(invoke('revoke_keep', { decision_id: decision!.id })).rejects.toThrow('get_impact')

    const started = (await invoke('run_impact', { node_ids: [node] })) as {
      group_id: string
      total: number
    }
    expect(started.total).toBe(1)
    expect(groups).toEqual([started.group_id])
    await until(() => server.runs.groupState(started.group_id, 'local')?.status !== 'running')

    // 别的用户看不到这块画布
    await expect(invoke('get_impact', {}, { ...env, ownerId: 'other' })).rejects.toThrow('不存在')
    await expect(
      invoke('run_impact', { node_ids: [node] }, { ...env, ownerId: 'other' }),
    ).rejects.toThrow('不存在')

    // run_impact 在规则模式下要确认
    const changes = new AgentChanges('p', id, 'local', server.rooms, server.runs)
    changes.begin('turn')
    const tools = agentTools(env, {
      changes,
      approvals: new Approvals(() => {}),
      mode: () => 'always',
    })
    const r = await callTool(
      tools.find((t) => t.name === 'run_impact')!,
      { node_ids: [node] },
    )
    expect(JSON.parse(r.content[0]!.type === 'text' ? r.content[0]!.text : '{}').status).toBe(
      'needs_approval',
    )
  })
})
