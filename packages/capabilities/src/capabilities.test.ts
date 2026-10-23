import { createDoc, createElement, LOCAL_ORIGIN, type PleinDoc } from '@plein/doc'
import { describeNode, defineNode } from '@plein/plugin-sdk'
import { findMentions } from '@plein/nodes'
import { describe, expect, it } from 'vite-plus/test'
import * as Y from 'yjs'
import { z } from 'zod'
import { canvasCapabilities } from './canvas'
import { type CapabilityContext, CapabilityError, defineCapability } from './define'
import { editCapabilities } from './edit'
import { CapabilityRegistry } from './registry'

const textNode = defineNode({
  type: 'test/text',
  version: 1,
  title: '文本',
  category: 'text',
  inputs: [],
  outputs: [{ id: 'text', label: '文本', type: 'text' }],
  params: z.object({ text: z.string().default('') }),
})

function setup(origin?: unknown) {
  const ydoc = new Y.Doc()
  const origins: unknown[] = []
  ydoc.on('afterTransaction', (tr: Y.Transaction) => origins.push(tr.origin))
  const ctx: CapabilityContext = {
    withDoc: <T>(fn: (doc: PleinDoc) => T) => {
      const doc = createDoc(ydoc, { schedule: () => {}, origin })
      try {
        return fn(doc)
      } finally {
        doc.destroy()
      }
    },
    nodes: {
      latest: (type) =>
        type === textNode.type
          ? { def: textNode, descriptor: describeNode(textNode, 'test'), runnable: true }
          : undefined,
      all: () => [{ def: textNode, descriptor: describeNode(textNode, 'test'), runnable: true }],
      models: () => [],
      defaultModel: () => '',
      prompts: () => [],
    },
    assetMeta: () => undefined,
  }
  return {
    ctx,
    ydoc,
    origins,
    registry: new CapabilityRegistry([...canvasCapabilities, ...editCapabilities] as never[]),
  }
}

describe('能力注册表', () => {
  it('名字只能用小写下划线，不能重复注册', () => {
    expect(() =>
      defineCapability({
        name: 'canvas.create',
        title: '',
        description: '',
        group: 'edit',
        where: 'doc',
        effect: 'edit',
        input: z.object({}),
        run: () => null,
      }),
    ).toThrow()
    const { registry } = setup()
    expect(() => registry.add(canvasCapabilities[0]!)).toThrow('重复')
  })

  it('输入不合法时抛 CapabilityError，消息带上 schema 报错', async () => {
    const { registry, ctx } = setup()
    await expect(registry.invoke('create_node', ctx, { params: {} })).rejects.toBeInstanceOf(
      CapabilityError,
    )
    await expect(registry.invoke('nope', ctx, {})).rejects.toThrow('没有能力')
  })

  it('写入带调用方的 origin', async () => {
    const mine = { session: 'a' }
    const { registry, ctx, origins } = setup(mine)
    await registry.invoke('create_node', ctx, { type: 'test/text', params: { text: '雨夜' } })
    expect(origins).toContain(mine)
    expect(origins).not.toContain(LOCAL_ORIGIN)
  })

  it('find_elements 按名称、正文和参数查找', async () => {
    const { registry, ctx } = setup()
    ctx.withDoc((doc) => {
      createElement(doc, { kind: 'markdown', x: 0, y: 0, w: 100, h: 100, text: '第一场：天台' })
      createElement(doc, { kind: 'frame', x: 0, y: 200, w: 100, h: 100, name: '天台戏' })
    })
    await registry.invoke('create_node', ctx, { type: 'test/text', params: { text: '雨夜天台' } })
    const all = (await registry.invoke('find_elements', ctx, { query: '天台' })) as {
      total: number
    }
    expect(all.total).toBe(3)
    const frames = (await registry.invoke('find_elements', ctx, {
      query: '天台',
      kind: 'frame',
    })) as { total: number }
    expect(frames.total).toBe(1)
  })

  it('near 放在参照元素右侧，不压住别的元素', async () => {
    const { registry, ctx } = setup()
    const [a] = ctx.withDoc((doc) => [
      createElement(doc, { kind: 'markdown', x: 0, y: 0, w: 200, h: 200 }),
      createElement(doc, { kind: 'markdown', x: 280, y: 0, w: 200, h: 200 }),
    ])
    const made = (await registry.invoke('create_node', ctx, { type: 'test/text', near: a })) as {
      id: string
    }
    ctx.withDoc((doc) => {
      const r = doc.worldRect(made.id)!
      expect(r.x).toBeGreaterThanOrEqual(200)
      expect(r.y).toBeGreaterThanOrEqual(200)
    })
  })

  it('编辑类能力：复制、打组、解组，palette 从选区取参数', async () => {
    const { registry, ctx } = setup()
    const [a, b] = ctx.withDoc((doc) => [
      createElement(doc, { kind: 'markdown', x: 0, y: 0, w: 100, h: 100 }),
      createElement(doc, { kind: 'markdown', x: 200, y: 0, w: 100, h: 100 }),
    ])
    const copy = (await registry.invoke('duplicate_elements', ctx, { ids: [a] })) as {
      ids: string[]
    }
    expect(copy.ids).toHaveLength(1)
    const { frame_id } = (await registry.invoke('group_elements', ctx, {
      ids: [a, b],
      name: '第一场',
    })) as { frame_id: string }
    ctx.withDoc((doc) => {
      expect(doc.get(frame_id)?.name).toBe('第一场')
      expect(registry.get('ungroup')!.palette!.fromSelection([frame_id], doc)).toEqual({ frame_id })
      expect(registry.get('ungroup')!.palette!.fromSelection([a!], doc)).toBeNull()
    })
    const out = (await registry.invoke('ungroup', ctx, { frame_id })) as { ids: string[] }
    expect(out.ids.sort()).toEqual([a, b].sort())
    await expect(registry.invoke('ungroup', ctx, { frame_id: a })).rejects.toThrow('不是 Frame')
  })

  it('复制能力和画布快捷键一样重映射内部引用，保留原节点指向', async () => {
    const { registry, ctx } = setup()
    const [character, image] = ctx.withDoc((doc) => {
      const character = createElement(doc, {
        kind: 'node',
        nodeType: 'plein/character',
        name: '林夏',
        x: 0,
        y: 0,
        w: 100,
        h: 100,
      })
      const image = createElement(doc, {
        kind: 'node',
        x: 200,
        y: 0,
        w: 100,
        h: 100,
        params: { prompt: '@林夏 站着', requiredRefs: [character] },
      })
      return [character, image]
    })
    const copy = (await registry.invoke('duplicate_elements', ctx, {
      ids: [character, image],
    })) as { ids: string[] }
    ctx.withDoc((doc) => {
      const original = doc.get(image!)!
      const copied = doc.get(copy.ids[1]!)!
      expect(copied.params!.requiredRefs).toEqual([copy.ids[0]])
      expect(original.params!.requiredRefs).toEqual([character])
      const targets = [character!, copy.ids[0]!].map((id) => ({ id, name: '林夏' }))
      expect(findMentions(copied.params!.prompt as string, targets)[0]?.id).toBe(copy.ids[0])
      expect(findMentions(original.params!.prompt as string, targets)[0]?.id).toBe(character)
      expect(copied).toMatchObject({ x: 224, y: 24 })
    })
  })
})
