import { connect, createDoc, createElement, inputEdges, type PleinDoc } from '@plein/doc'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import type { CapabilityContext } from './define'
import { editCapabilities } from './edit'
import { CapabilityRegistry } from './registry'

const docs: PleinDoc[] = []
afterEach(() => {
  for (const doc of docs.splice(0)) {
    doc.destroy()
    doc.ydoc.destroy()
  }
})

function setup() {
  const doc = createDoc()
  docs.push(doc)
  const images = ['first', 'last', 'replacement'].map((assetId) =>
    createElement(doc, { kind: 'image', assetId, x: 0, y: 0, w: 100, h: 100 }),
  )
  const audio = createElement(doc, { kind: 'audio', assetId: 'audio', x: 0, y: 0, w: 100, h: 100 })
  const target = createElement(doc, {
    kind: 'node',
    nodeType: 'test/video',
    nodeVersion: 1,
    x: 200,
    y: 0,
    w: 100,
    h: 100,
    ports: {
      inputs: [
        { id: 'images', label: '参考图', type: 'image', multiple: true },
        { id: 'mask', label: '蒙版', type: 'image' },
      ],
      outputs: [{ id: 'image', label: '图片', type: 'image' }],
    },
  })
  const edges = images
    .slice(0, 2)
    .map((source) => connect(doc, [source, 'image'], [target, 'images'])!)
  const mask = connect(doc, [images[2]!, 'image'], [target, 'mask'])!
  doc.undo.clear()
  const ctx: CapabilityContext = {
    withDoc: (fn) => fn(doc),
    assetMeta: () => undefined,
    nodes: {
      latest: () => undefined,
      all: () => [],
      models: () => [],
      defaultModel: () => '',
      prompts: () => [],
    },
  }
  const registry = new CapabilityRegistry(editCapabilities)
  return { doc, images, audio, target, edges, mask, ctx, registry }
}

describe('reference slot capabilities', () => {
  it('reorders exactly one port and replaces one slot while retaining edge identity, position and undo', async () => {
    const { doc, images, target, edges, mask, ctx, registry } = setup()
    const initial = edges.map((e) => ({ ...e }))
    const reordered = [edges[1]!.id, edges[0]!.id]
    await expect(
      registry.invoke('reorder_inputs', ctx, { id: target, port: 'images', edge_ids: reordered }),
    ).resolves.toMatchObject({ changed: true, edge_ids: reordered })
    expect(inputEdges(doc, target, 'images').map((e) => e.id)).toEqual(reordered)
    expect(inputEdges(doc, target, 'mask')).toEqual([mask])
    expect(edges.map((edge) => doc.getEdge(edge.id)?.from)).toEqual(initial.map((e) => e.from))
    doc.undo.stopCapturing()
    const slot = doc.getEdge(edges[1]!.id)!
    await expect(
      registry.invoke('replace_input', ctx, {
        edge_id: slot.id,
        from: images[2],
        from_port: 'image',
      }),
    ).resolves.toMatchObject({ edge_id: slot.id, changed: true })
    expect(doc.getEdge(slot.id)).toEqual({ ...slot, from: [images[2], 'image'] })
    expect(doc.get(images[1]!)).toBeDefined()
    expect(inputEdges(doc, target, 'images').map((e) => e.id)).toEqual(reordered)
    doc.undo.undo()
    expect(doc.getEdge(slot.id)).toEqual(slot)
    doc.undo.undo()
    expect(inputEdges(doc, target, 'images')).toEqual(initial)
  })

  it('rejects missing, repeated and foreign edges without changing any port', async () => {
    const { doc, target, edges, mask, ctx, registry } = setup()
    const before = [...doc.edges()]
    for (const edge_ids of [
      [edges[0]!.id],
      [edges[0]!.id, edges[0]!.id],
      [edges[0]!.id, mask.id],
      [edges[0]!.id, 'missing'],
    ])
      await expect(
        registry.invoke('reorder_inputs', ctx, { id: target, port: 'images', edge_ids }),
      ).rejects.toThrow('完整且不重复')
    await expect(
      registry.invoke('reorder_inputs', ctx, { id: target, port: 'missing', edge_ids: [mask.id] }),
    ).rejects.toThrow('没有输入端口')
    await expect(
      registry.invoke('reorder_inputs', ctx, { id: target, port: 'mask', edge_ids: [mask.id] }),
    ).rejects.toThrow('不是多输入')
    expect([...doc.edges()]).toEqual(before)
    expect(doc.undo.undoStack).toHaveLength(0)
  })

  it('rejects missing slots, incompatible ports, duplicates and self references; identical replacement is a no-op', async () => {
    const { doc, images, audio, target, edges, ctx, registry } = setup()
    const before = [...doc.edges()]
    const replace = (args: Record<string, unknown>) =>
      registry.invoke('replace_input', ctx, {
        edge_id: edges[0]!.id,
        from: images[2],
        from_port: 'image',
        ...args,
      })
    await expect(replace({ edge_id: 'missing' })).rejects.toThrow('没有连线')
    await expect(replace({ from_port: 'missing' })).rejects.toThrow('没有输出端口')
    await expect(replace({ from: audio, from_port: 'audio' })).rejects.toThrow('类型不兼容')
    await expect(replace({ from: images[1] })).rejects.toThrow('不能重复引用')
    await expect(replace({ from: target })).rejects.toThrow('自身')
    await expect(replace({ from: images[0] })).resolves.toMatchObject({ changed: false })
    expect([...doc.edges()]).toEqual(before)
    expect(doc.undo.undoStack).toHaveLength(0)
  })

  it('uses the document read-only boundary for both edits', async () => {
    const { doc, images, target, edges, ctx, registry } = setup()
    const before = [...doc.edges()]
    doc.readOnly = true
    await expect(
      registry.invoke('reorder_inputs', ctx, {
        id: target,
        port: 'images',
        edge_ids: [edges[1]!.id, edges[0]!.id],
      }),
    ).rejects.toThrow('只读')
    await expect(
      registry.invoke('replace_input', ctx, {
        edge_id: edges[0]!.id,
        from: images[2],
        from_port: 'image',
      }),
    ).rejects.toThrow('只读')
    expect([...doc.edges()]).toEqual(before)
  })
})
