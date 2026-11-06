import { describe, expect, it } from 'vite-plus/test'
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

type Changed = Record<string, { from: unknown; to: unknown }>

describe('list_models', () => {
  it('不带 ref 给摘要，带 ref 给完整 limits 与 options_schema；可只列已启用', async () => {
    const f = await fixture()
    const all = (await f.invoke('list_models', { capability: 'image.generate' })) as {
      models: Array<{ ref: string; enabled: boolean; limits?: unknown }>
    }
    const enabled = (await f.invoke('list_models', {
      capability: 'image.generate',
      enabled_only: true,
    })) as { models: Array<{ ref: string; enabled: boolean }> }
    expect(all.models.some((m) => !m.enabled)).toBe(true)
    expect(enabled.models.length).toBeGreaterThan(0)
    expect(enabled.models.every((m) => m.enabled)).toBe(true)
    // 摘要不带 limits 全量
    expect(all.models[0]).not.toHaveProperty('limits')
    const detail = (await f.invoke('list_models', { ref: 'plein/mock:image' })) as {
      limits: { resolutions: string[] }
      options_schema: { properties: Record<string, unknown> }
      node_types: Array<{ type: string; model_param?: string }>
      default_for: string[]
    }
    expect(detail.limits.resolutions).toEqual(['1K', '2K'])
    expect(detail.options_schema.properties).toHaveProperty('watermark')
    expect(detail.node_types).toContainEqual(expect.objectContaining({ type: 'plein/image' }))
    expect(detail.default_for).toContain('image.generate')
    await expect(f.invoke('list_models', { ref: 'nope:none' })).rejects.toThrow('没有模型')
  })

  it('分页：limit 之外给 next_offset', async () => {
    const f = await fixture()
    const page = (await f.invoke('list_models', { limit: 2 })) as {
      total: number
      models: unknown[]
      next_offset?: number
    }
    expect(page.models).toHaveLength(2)
    expect(page.next_offset).toBe(2)
  })
})

describe('set_node_model', () => {
  it('切到 H3 文生视频：auto 画幅被纠正，分辨率不在新模型内改回默认，时长夹进范围', async () => {
    const f = await fixture()
    f.server.plugins.configs.update('minimax/api', { enabled: true })
    const node = addNode(f.doc, 'plein/video', {
      params: { mode: 'text', aspectRatio: 'auto', resolution: '1080p', duration: 2 },
    })
    const out = (await f.invoke('set_node_model', { id: node, model: H3 })) as {
      changed: Changed
      notes: string[]
    }
    expect(out.changed.model).toEqual({ from: expect.any(String), to: H3 })
    expect(out.changed.aspectRatio).toEqual({ from: 'auto', to: '16:9' })
    expect(out.changed.resolution?.to).toBe('')
    expect(out.changed.duration?.to).toBe(4)
    expect(out.notes.join('；')).toContain('画幅已从 智能 改为 16:9')
    expect(f.doc.get(node)?.params).toMatchObject({
      model: H3,
      aspectRatio: '16:9',
      resolution: '',
      duration: 4,
    })
  })

  it('切到不支持种子的模型：种子值保留但报告为不再传给平台', async () => {
    const f = await fixture()
    const node = addNode(f.doc, 'plein/image', { params: { seed: 42 } })
    const out = (await f.invoke('set_node_model', { id: node, model: 'plein/mock:image' })) as {
      ignored_params?: string[]
    }
    expect(out.ignored_params).toContain('seed')
    expect(f.doc.get(node)?.params?.seed).toBe(42)
  })

  it('校验：未启用平台、能力不符、未知模型、非节点都明确拒绝', async () => {
    const f = await fixture()
    const node = addNode(f.doc, 'plein/image')
    await expect(
      f.invoke('set_node_model', { id: node, model: 'aliyun/bailian:wan3.0-video' }),
    ).rejects.toThrow(/没有启用|不支持/)
    await expect(
      f.invoke('set_node_model', { id: node, model: 'plein/mock:video' }),
    ).rejects.toThrow('不支持')
    await expect(f.invoke('set_node_model', { id: node, model: 'x:y' })).rejects.toThrow('没有模型')
    await expect(
      f.invoke('set_node_model', { id: 'missing', model: 'plein/mock:image' }),
    ).rejects.toThrow('不存在')
  })

  it('update_element 直接写 model 时返回提示，指向 set_node_model', async () => {
    const f = await fixture()
    const node = addNode(f.doc, 'plein/video')
    const out = (await f.invoke('update_element', {
      id: node,
      params: { model: 'plein/mock:video' },
    })) as { warnings?: string[] }
    // 同一个模型不算切换；换成别的值才提示
    expect(out.warnings).toBeUndefined()
    f.server.plugins.configs.update('minimax/api', { enabled: true })
    const other = (await f.invoke('update_element', {
      id: node,
      params: { model: H3 },
    })) as { warnings?: string[] }
    expect(other.warnings?.[0]).toContain('set_node_model')
  })
})
