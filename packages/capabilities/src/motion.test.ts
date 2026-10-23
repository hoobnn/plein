import { createDoc, createElement, currentResult, type PleinDoc } from '@plein/doc'
import { motionNode, MotionParams } from '@plein/nodes'
import { describeNode } from '@plein/plugin-sdk'
import { describe, expect, it } from 'vite-plus/test'
import * as Y from 'yjs'
import type { CapabilityContext } from './define'
import { motionCapabilities } from './motion'
import { CapabilityRegistry } from './registry'

function setup(ydoc = new Y.Doc()) {
  const doc = createDoc(ydoc, { schedule: () => {} })
  const info = {
    def: motionNode,
    descriptor: describeNode(motionNode, 'plein/core'),
    runnable: true,
  }
  const ctx: CapabilityContext = {
    withDoc: <T>(fn: (doc: PleinDoc) => T) => fn(doc),
    nodes: {
      latest: (type) => (type === motionNode.type ? info : undefined),
      all: () => [info],
      models: () => [],
      defaultModel: () => '',
      prompts: () => [],
    },
    assetMeta: () => undefined,
  }
  return { doc, ctx, registry: new CapabilityRegistry(motionCapabilities) }
}

describe('动态合成能力', () => {
  it('创建、结构化编辑与读取同一份合同，不触发渲染或采用', async () => {
    const { ctx, doc, registry } = setup()
    const image = createElement(doc, {
      kind: 'image',
      assetId: 'a'.repeat(64),
      x: 0,
      y: 0,
      w: 100,
      h: 100,
    })
    const made = (await registry.invoke('create_motion', ctx, {
      image_id: image,
      name: '介绍',
      params: { template: 'character', title: '角色甲' },
    })) as { id: string }
    expect(doc.get(made.id)?.params).toMatchObject({
      template: 'character',
      title: '角色甲',
      audio: 'mute',
    })
    expect(doc.get(made.id)?.run).toBeUndefined()
    expect(currentResult(doc.get(made.id)!)).toBeUndefined()
    const result = (await registry.invoke('edit_motion', ctx, {
      id: made.id,
      params: { accent: '#aabbcc' },
      operations: [
        { op: 'text', id: 'hf-title', text: '改名' },
        { op: 'style', id: 'hf-subtitle', property: 'color', value: '#ffffff' },
        { op: 'timing', id: 'hf-title', start: 1, end: 4 },
      ],
    })) as { params: MotionParams }
    expect(result.params.overrides).toEqual({
      'hf-title.text': '改名',
      'hf-subtitle.style.color': '#ffffff',
      'hf-title.timing.start': 1,
      'hf-title.timing.end': 4,
    })
    const snapshot = (await registry.invoke('get_motion', ctx, { id: made.id })) as {
      inputs: unknown[]
      params: MotionParams
      editable: unknown[]
    }
    expect(snapshot.inputs).toEqual([{ elementId: image, fromPort: 'image', toPort: 'image' }])
    expect(snapshot.params.accent).toBe('#aabbcc')
    expect(snapshot.editable).toHaveLength(4)
    expect(snapshot).not.toHaveProperty('html')
    doc.destroy()
  })

  it('基础参数补丁只写实际传入字段，不执行创建时的默认值', async () => {
    const { ctx, doc, registry } = setup()
    const made = (await registry.invoke('create_motion', ctx, {
      params: {
        template: 'video-title',
        title: '保留的标题',
        subtitle: '保留的副标题',
        duration: 12,
        aspectRatio: '16:9',
        resolution: '720p',
        sourceIn: 3,
        speed: 2,
        audio: 'source',
      },
    })) as { id: string }
    const before = MotionParams.parse(doc.get(made.id)?.params)
    const schema = registry.get('edit_motion')!.input
    expect(schema.parse({ id: made.id, params: { accent: '#aabbcc' } })).toEqual({
      id: made.id,
      params: { accent: '#aabbcc' },
    })
    await expect(registry.invoke('edit_motion', ctx, { id: made.id, params: {} })).rejects.toThrow()
    await registry.invoke('edit_motion', ctx, { id: made.id, params: { accent: '#aabbcc' } })
    expect(MotionParams.parse(doc.get(made.id)?.params)).toEqual({ ...before, accent: '#aabbcc' })
    doc.destroy()
  })

  it('完整验证后才写入，一条非法操作不能留下之前的编辑', async () => {
    const { ctx, doc, registry } = setup()
    const made = (await registry.invoke('create_motion', ctx, {})) as { id: string }
    const prior = doc.get(made.id)?.params
    await expect(
      registry.invoke('edit_motion', ctx, {
        id: made.id,
        params: { title: '不能部分保存' },
        operations: [
          { op: 'text', id: 'hf-title', text: '草稿' },
          { op: 'timing', id: 'hf-subtitle', start: 3, end: 9 },
        ],
      }),
    ).rejects.toThrow('无效')
    expect(doc.get(made.id)?.params).toEqual(prior)
    for (const input of [
      { id: made.id, params: { overrides: { 'hf-title.text': '绕过受控操作' } } },
      {
        id: made.id,
        operations: [{ op: 'style', id: 'hf-title', property: 'color', value: 'url(https://x)' }],
      },
      {
        id: made.id,
        operations: [{ op: 'attr', id: 'hf-media', property: 'src', value: 'https://x' }],
      },
    ])
      await expect(registry.invoke('edit_motion', ctx, input)).rejects.toThrow()
    expect(doc.get(made.id)?.params).toEqual(prior)
    doc.destroy()
  })

  it('在创建前验证输入类型，不留下未连接的半成品', async () => {
    const { ctx, doc, registry } = setup()
    const image = createElement(doc, {
      kind: 'image',
      assetId: 'a'.repeat(64),
      x: 0,
      y: 0,
      w: 100,
      h: 100,
    })
    await expect(registry.invoke('create_motion', ctx, { video_id: image })).rejects.toThrow(
      '没有 video 输出',
    )
    expect([...doc.elements()]).toHaveLength(1)
    await expect(
      registry.invoke('create_motion', ctx, {
        params: { overrides: { 'hf-media.attr.src': 'file:///secret' } },
      }),
    ).rejects.toThrow()
    expect([...doc.elements()]).toHaveLength(1)
    await expect(registry.invoke('get_motion', ctx, { id: image })).rejects.toThrow('不是动态合成')
    doc.destroy()
  })

  it('覆盖逐字段写入并保留别的字段，一次能力调用只有一步撤销', async () => {
    const { ctx, doc, registry } = setup()
    const made = (await registry.invoke('create_motion', ctx, {
      params: { overrides: { 'hf-accent.style.backgroundColor': '#aabbcc' } },
    })) as { id: string }
    doc.undo.stopCapturing()
    await registry.invoke('edit_motion', ctx, {
      id: made.id,
      params: { subtitle: '新副标题' },
      operations: [
        { op: 'text', id: 'hf-title', text: '标题' },
        { op: 'style', id: 'hf-title', property: 'left', value: '12%' },
      ],
    })
    expect((doc.mutable(made.id)!.get('params') as Y.Map<unknown>).get('overrides')).toBeInstanceOf(
      Y.Map,
    )
    expect(MotionParams.parse(doc.get(made.id)?.params).overrides).toMatchObject({
      'hf-accent.style.backgroundColor': '#aabbcc',
      'hf-title.text': '标题',
    })
    doc.undo.undo()
    expect(MotionParams.parse(doc.get(made.id)?.params).overrides).toEqual({
      'hf-accent.style.backgroundColor': '#aabbcc',
    })
    expect(doc.get(made.id)?.params?.subtitle).toBe('把创意带入画面')
    doc.destroy()
  })

  it('双客户端首次编辑独立字段可以合并', async () => {
    const first = setup()
    const made = (await first.registry.invoke('create_motion', first.ctx, {})) as { id: string }
    const secondDoc = new Y.Doc()
    Y.applyUpdate(secondDoc, Y.encodeStateAsUpdate(first.doc.ydoc))
    const second = setup(secondDoc)
    await first.registry.invoke('edit_motion', first.ctx, {
      id: made.id,
      operations: [{ op: 'text', id: 'hf-title', text: '左端标题' }],
    })
    await second.registry.invoke('edit_motion', second.ctx, {
      id: made.id,
      operations: [{ op: 'style', id: 'hf-subtitle', property: 'color', value: '#aabbcc' }],
    })
    const left = Y.encodeStateAsUpdate(first.doc.ydoc)
    const right = Y.encodeStateAsUpdate(second.doc.ydoc)
    Y.applyUpdate(first.doc.ydoc, right)
    Y.applyUpdate(second.doc.ydoc, left)
    for (const doc of [first.doc, second.doc]) {
      expect(MotionParams.parse(doc.get(made.id)?.params).overrides).toEqual({
        'hf-title.text': '左端标题',
        'hf-subtitle.style.color': '#aabbcc',
      })
      doc.destroy()
    }
  })

  it('只读文档允许get并拒绝实际编辑', async () => {
    const { ctx, doc, registry } = setup()
    const made = (await registry.invoke('create_motion', ctx, {})) as { id: string }
    doc.readOnly = true
    await expect(registry.invoke('get_motion', ctx, { id: made.id })).resolves.toHaveProperty(
      'id',
      made.id,
    )
    await expect(
      registry.invoke('edit_motion', ctx, { id: made.id, params: { title: '不能写' } }),
    ).rejects.toThrow()
    await expect(registry.invoke('create_motion', ctx, {})).rejects.toThrow()
    doc.destroy()
  })
})
