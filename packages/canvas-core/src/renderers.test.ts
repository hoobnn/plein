import { createElement } from '@plein/doc'
import { box, openDoc } from '@plein/doc/testing'
import { Container, Graphics, type GraphicsContext, Texture, TextureSource } from 'pixi.js'
import { describe, expect, it, vi } from 'vite-plus/test'
import { type ElementRenderer, type ElementView, RendererRegistry } from './renderers'
import { TexturePool } from './textures'

/** 按名字可辨认的哑渲染器：不画内容，只用来断言查找命中了谁 */
const stub: ElementRenderer = () => {
  const display = new Container()
  return { display, update: () => {}, destroy: () => {} }
}

const expectStub = (view: ElementView) => {
  expect(view.previewStatus).toBeUndefined()
  expect(view.setDetail).toBeUndefined()
  view.destroy()
}

describe('renderer lookup: nodeType 优先，未命中落回 kind，都没有时用占位卡片', () => {
  it('nodeType 命中时用 nodeType 渲染器', () => {
    const doc = openDoc()
    const id = createElement(doc, box({ kind: 'node', nodeType: 'plein/custom' }))
    const registry = new RendererRegistry()
    registry.registerNodeType('plein/custom', stub)
    expectStub(registry.create(doc.get(id)!, {}))
    doc.destroy()
  })

  it('nodeType 未命中时落回 kind 渲染器', () => {
    const doc = openDoc()
    const id = createElement(doc, box({ kind: 'node', nodeType: 'plein/other' }))
    const registry = new RendererRegistry(false)
    const byKind = vi.fn(stub)
    registry.register('node', byKind)
    expectStub(registry.create(doc.get(id)!, {}))
    expect(byKind).toHaveBeenCalledOnce()
    doc.destroy()
  })

  it('kind 也没有时用占位卡片（与现状一致）', () => {
    const doc = openDoc()
    const id = createElement(doc, box({ kind: 'node', nodeType: 'plein/other' }))
    const view = new RendererRegistry(false).create(doc.get(id)!, {})
    // 占位卡片：无预览、无细节档位；media / node 渲染器都有 previewStatus
    expect(view.previewStatus).toBeUndefined()
    view.destroy()
    doc.destroy()
  })

  it('nodeType 层只作用于 node 元素，media 元素不受影响', () => {
    const doc = openDoc()
    const id = createElement(doc, box({ kind: 'image', assetId: 'a' }))
    const registry = new RendererRegistry()
    registry.registerNodeType('plein/custom', stub)
    const view = registry.create(doc.get(id)!, { assetUrl: () => undefined })
    expect(view.previewStatus).not.toBeUndefined()
    view.destroy()
    doc.destroy()
  })
})

async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

it.each(['image', 'video', 'audio', 'node', 'markdown', 'frame'] as const)(
  '%s destroys its owned graphics contexts without destroying borrowed textures',
  async (kind) => {
    const doc = openDoc()
    const id = createElement(doc, box({ kind, assetId: 'shared' }))
    const source = new TextureSource({ width: 256, height: 128 })
    const texture = new Texture({ source })
    const pool = new TexturePool({
      load: async () => texture,
      unload: async () => {},
      estimateBytes: () => 256 * 128 * 4,
    })
    const owner = pool.createOwner()
    const view = new RendererRegistry().create(doc.get(id)!, {
      initialDetail: false,
      textures: owner,
      assetUrl: () => 'shared.png',
    })
    await flush()
    const contexts: GraphicsContext[] = []
    const collect = (display: Container) => {
      if (display instanceof Graphics) contexts.push(display.context)
      for (const child of display.children) collect(child)
    }
    collect(view.display)
    expect(contexts.length).toBeGreaterThan(0)
    view.destroy()
    try {
      expect(contexts.every((context) => context.destroyed)).toBe(true)
      expect(texture.destroyed).toBe(false)
      expect(source.destroyed).toBe(false)
    } finally {
      owner.dispose()
      for (const context of contexts) if (!context.destroyed) context.destroy()
      texture.destroy(true)
      doc.destroy()
    }
  },
)

describe('preview renderer detail', () => {
  it.each(['image', 'node'] as const)(
    '%s first requests only the initial detail tier',
    async (kind) => {
      const doc = openDoc()
      const id = createElement(doc, box({ kind, assetId: kind === 'image' ? 'a' : undefined }))
      if (kind === 'node') {
        doc
          .mutable(id)!
          .set('results', [
            { id: 'r', port: 'out', runId: 'run', at: 1, value: { type: 'image', assetId: 'a' } },
          ])
      }
      const textures = new Map<string, Texture>()
      const load = vi.fn(async (url: string) => {
        const texture = new Texture({ source: new TextureSource({ width: 256, height: 128 }) })
        textures.set(url, texture)
        return texture
      })
      const pool = new TexturePool({
        load,
        unload: async (url) => {
          textures.get(url)?.destroy(true)
        },
        estimateBytes: () => 256 * 128 * 4,
      })
      const owner = pool.createOwner()
      const view = new RendererRegistry().create(doc.get(id)!, {
        initialDetail: false,
        textures: owner,
        assetUrl: (_asset, _kind, size) => `http://localhost/${size}.webp`,
      })
      await flush()
      expect(load.mock.calls.map(([url]) => url)).toEqual(['http://localhost/small.webp'])
      view.setDetail?.(true)
      await flush()
      view.setDetail?.(false)
      await flush()
      expect(load.mock.calls.map(([url]) => url)).toEqual([
        'http://localhost/small.webp',
        'http://localhost/large.webp',
      ])
      view.destroy()
      owner.dispose()
      await flush()
      expect(pool.stats.activeLeases).toBe(0)
      doc.destroy()
    },
  )
})
