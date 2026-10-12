import { createDoc, createElement, LOCAL_ORIGIN, type PleinDoc } from '@plein/doc'
import { describeNode, defineNode } from '@plein/plugin-sdk'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { z } from 'zod'
import { canvasCapabilities } from './canvas'
import { type CapabilityContext, CapabilityError, defineCapability } from './define'
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
    },
    assetMeta: () => undefined,
  }
  return { ctx, ydoc, origins, registry: new CapabilityRegistry(canvasCapabilities) }
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
})
