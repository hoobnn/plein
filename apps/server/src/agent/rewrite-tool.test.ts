import { setParams } from '@plein/doc'
import { describe, expect, it, vi } from 'vite-plus/test'
import { addNode, bootServer, createCanvas } from '../testing'
import { serverCapabilities, serverContext, type ToolEnv } from './tools'

const H3 = 'minimax/api:MiniMax-H3'

async function fixture() {
  const { server } = await bootServer()
  const { id, doc } = await createCanvas(server)
  const env: ToolEnv = {
    canvasId: id,
    ownerId: 'local',
    rooms: server.rooms,
    runs: server.runs,
    host: server.plugins,
    assets: server.assets,
  }
  const invoke = (name: string, args: unknown) =>
    serverCapabilities.invoke(name, serverContext(env), args)
  return { server, id, doc, env, invoke }
}

describe('rewrite_prompt 入参', () => {
  it('模型返回时保留用户刚输入的新提示词，已生成的改写稿仍可获取', async () => {
    const f = await fixture()
    const node = addNode(f.doc, 'plein/image', { params: { prompt: '初稿' } })
    const call = f.server.plugins.call.bind(f.server.plugins)
    vi.spyOn(f.server.plugins, 'call').mockImplementationOnce((...args) => {
      setParams(f.doc, node, { prompt: '编辑期间的新稿' })
      return call(...args)
    })
    const out = await f.invoke('rewrite_prompt', { id: node })
    expect(out).toMatchObject({ applied: false, prompt: expect.stringContaining('【mock】') })
    expect(f.doc.get(node)?.params?.prompt).toBe('编辑期间的新稿')
  })

  it('structure/detail/model 可选，auto 在 H3 参考任务上判成六段结构', async () => {
    const f = await fixture()
    f.server.plugins.configs.update('minimax/api', { enabled: true })
    const node = addNode(f.doc, 'plein/video', {
      params: { prompt: '她走进房间', mode: 'reference', model: H3 },
    })
    const spec = serverCapabilities.get('rewrite_prompt')!.input.shape as Record<string, unknown>
    expect(Object.keys(spec)).toEqual(
      expect.arrayContaining(['structure', 'detail', 'model', 'apply', 'mode']),
    )
    const out = (await f.invoke('rewrite_prompt', { id: node, apply: false })) as {
      structure: string
      generation_model?: string
    }
    expect(out.generation_model).toBe(H3)
    expect(out.structure).toBe('h3')
    const forced = (await f.invoke('rewrite_prompt', {
      id: node,
      apply: false,
      structure: 'default',
    })) as { structure: string }
    expect(forced.structure).toBe('default')
    // 非 H3 节点即使 auto 也用通用公式
    const plain = addNode(f.doc, 'plein/video', {
      params: { prompt: '她走进房间', mode: 'reference' },
    })
    const out2 = (await f.invoke('rewrite_prompt', { id: plain, apply: false })) as {
      structure: string
    }
    expect(out2.structure).toBe('default')
  })
})
