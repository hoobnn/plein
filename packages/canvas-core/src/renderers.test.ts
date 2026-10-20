import { createElement } from '@plein/doc'
import { box, openDoc } from '@plein/doc/testing'
import { type Container, Graphics, type GraphicsContext, Texture, TextureSource } from 'pixi.js'
import { describe, expect, it, vi } from 'vite-plus/test'
import { RendererRegistry } from './renderers'
import { TexturePool } from './textures'

async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

it.each(['image', 'video', 'audio', 'node', 'markdown', 'frame', 'sequence'] as const)(
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
