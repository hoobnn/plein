import { connect, setParams } from '@plein/doc'
import { describe, expect, it, vi } from 'vite-plus/test'
import { addNode, bootServer, createCanvas, mockSettings } from '../testing'
import { serverCapabilities, serverContext, type ToolEnv } from './tools'

describe('estimate_cost', () => {
  it('按运行口径估算：沿用的不计费，上游重做会让下游可能追加，价格未知单独计数', async () => {
    const { server } = await bootServer()
    mockSettings(server, {})
    const { id, doc } = await createCanvas(server)
    const env: ToolEnv = {
      canvasId: id,
      ownerId: 'local',
      rooms: server.rooms,
      runs: server.runs,
      host: server.plugins,
      assets: server.assets,
      canvasApi: server.canvasApi,
    }
    const invoke = (name: string, args: unknown, as = env) =>
      serverCapabilities.invoke(name, serverContext(as), args)
    const a = addNode(doc, 'plein/image', { params: { prompt: '甲' } })
    const b = addNode(doc, 'plein/image', { params: { prompt: '乙' }, x: 400 })
    connect(doc, [a, 'images'], [b, 'references'])
    for (const n of [a, b])
      expect(await server.runs.wait(server.runs.start(id, n, 'local'))).toBe('succeeded')

    type Est = {
      calls: number
      maybe_calls: number
      cost: { prices: Array<{ currency: string; amount: number }>; unknown: number }
      max_cost: { unknown: number }
      nodes: Array<{ id: string; will_run: string }>
    }
    const est = (scope: string, node = b) =>
      invoke('estimate_cost', { id: node, scope }) as Promise<Est>

    // 单节点总是重新运行；模型没配价格：不当成 0，记为 unknown
    expect(await est('node')).toMatchObject({ calls: 1, cost: { prices: [], unknown: 1 } })
    // 都还有效：运行到此处全部沿用
    expect(await est('upstream')).toMatchObject({ calls: 0, maybe_calls: 0 })

    vi.spyOn(server.runs, 'priceOf').mockReturnValue({ amount: 0.5, currency: 'CNY' } as never)
    setParams(doc, a, { prompt: '甲改' })
    const up = await est('upstream')
    expect(up.nodes.find((n) => n.id === a)!.will_run).toBe('run')
    expect(up.nodes.find((n) => n.id === b)!.will_run).toBe('maybe')
    expect(up).toMatchObject({
      calls: 1,
      maybe_calls: 1,
      cost: { prices: [{ currency: 'CNY', amount: 0.5 }], unknown: 0 },
    })
    expect(up.max_cost).toMatchObject({ prices: [{ currency: 'CNY', amount: 1 }] })
    const down = await est('downstream', a)
    expect(down.nodes.find((n) => n.id === a)!.will_run).toBe('run')

    await expect(invoke('estimate_cost', { id: 'nope', scope: 'node' })).rejects.toThrow('不存在')
    await expect(invoke('estimate_cost', { id: a, scope: 'frame' })).rejects.toThrow('Frame')
  })
})
