import { createDoc, createElement, deleteElements, type PleinDoc } from '@plein/doc'
import { describe, expect, it } from 'vite-plus/test'
import * as Y from 'yjs'
import type { CapabilityContext } from './define'
import { CapabilityRegistry } from './registry'
import { canvasCapabilities } from './canvas'
import { canvasReadVersion, readViewCapabilities } from './read-view'

function setup() {
  const ydoc = new Y.Doc()
  const ctx: CapabilityContext = {
    withDoc: <T>(fn: (doc: PleinDoc) => T) => {
      const doc = createDoc(ydoc)
      try {
        return fn(doc)
      } finally {
        doc.destroy()
      }
    },
    assetMeta: () => undefined,
    nodes: {
      latest: () => undefined,
      all: () => [],
      models: () => [],
      defaultModel: () => '',
      prompts: () => [],
    },
  }
  return {
    ydoc,
    ctx,
    registry: new CapabilityRegistry([...canvasCapabilities, ...readViewCapabilities]),
  }
}
describe('bounded canvas reads', () => {
  it('shares versions across wrappers, detects deletion and invalidates recreated documents', () => {
    const { ydoc, ctx } = setup()
    const id = ctx.withDoc((doc) =>
      createElement(doc, { kind: 'markdown', x: 0, y: 0, w: 100, h: 100, text: 'keep' }),
    )
    const before = ctx.withDoc((doc) => canvasReadVersion(doc.ydoc))
    expect(ctx.withDoc((doc) => canvasReadVersion(doc.ydoc))).toBe(before)
    ctx.withDoc((doc) => deleteElements(doc, [id]))
    expect(canvasReadVersion(ydoc)).not.toBe(before)
    const replacement = new Y.Doc()
    Y.applyUpdate(replacement, Y.encodeStateAsUpdate(ydoc))
    expect(canvasReadVersion(replacement)).not.toBe(canvasReadVersion(ydoc))
    ydoc.destroy()
    replacement.destroy()
  })
  it('pages complete raw text and arrays with valid bounded JSON; legacy shape stays unchanged', async () => {
    const { ctx, registry, ydoc } = setup()
    const text = '你好🎬'.repeat(10000)
    const ids = ctx.withDoc((doc) =>
      Array.from({ length: 80 }, (_, i) =>
        createElement(doc, {
          kind: 'markdown',
          x: i,
          y: 0,
          w: 100,
          h: 100,
          text: i === 0 ? text : `node${i}`,
        }),
      ),
    )
    const legacy = (await registry.invoke('get_canvas', ctx, {})) as {
      elements: unknown[]
      edges: unknown[]
    }
    expect(Object.keys(legacy).sort()).toEqual(['edges', 'elements'])
    let offset = 0,
      version = '',
      count = 0
    do {
      const page = (await registry.invoke('get_canvas_page', ctx, {
        offset,
        ...(version ? { expected_version: version } : {}),
      })) as { version: string; items: unknown[]; next_offset?: number }
      version = page.version
      count += page.items.length
      offset = page.next_offset ?? -1
      expect(new TextEncoder().encode(JSON.stringify(page)).byteLength).toBeLessThanOrEqual(
        24 * 1024,
      )
    } while (offset >= 0)
    expect(count).toBe(80)
    let full = '',
      textOffset = 0
    do {
      const page = (await registry.invoke('get_element_field', ctx, {
        id: ids[0],
        field_path: '/text',
        text_offset: textOffset,
        expected_version: version,
      })) as { value: string; next_text_offset?: number }
      full += page.value
      textOffset = page.next_text_offset ?? -1
    } while (textOffset >= 0)
    expect(full).toBe(text)
    await expect(registry.invoke('get_canvas_page', ctx, { offset: 30 })).rejects.toThrow(
      'expected_version_required',
    )
    ctx.withDoc((doc) => deleteElements(doc, [ids[1]!]))
    await expect(
      registry.invoke('get_canvas_page', ctx, { offset: 30, expected_version: version }),
    ).rejects.toThrow('canvas_changed')
    await expect(
      registry.invoke('get_element_field', ctx, { id: ids[0], field_path: '/__proto__' }),
    ).rejects.toThrow('field_missing')
    ydoc.destroy()
  })
  it('locates deeply nested raw result text and pages array entries without silently losing fields', async () => {
    const { ctx, registry, ydoc } = setup()
    const id = ctx.withDoc((doc) =>
      createElement(doc, {
        kind: 'node',
        nodeType: 'test/data',
        nodeVersion: 1,
        x: 0,
        y: 0,
        w: 100,
        h: 100,
        params: {
          shots: Array.from({ length: 150 }, (_, i) => ({
            id: String(i),
            text: '原文'.repeat(1000),
          })),
        },
      }),
    )
    const first = (await registry.invoke('get_element_field', ctx, {
      id,
      field_path: '/params/shots',
    })) as {
      version: string
      value: Array<{ key: string; value: { field_path: string } }>
      next_offset: number
      total: number
    }
    expect(first.total).toBe(150)
    expect(first.value[0]!.value.field_path).toBe('/params/shots/0')
    const detail = (await registry.invoke('get_element_field', ctx, {
      id,
      field_path: '/params/shots/0/text',
      expected_version: first.version,
    })) as { value: string; complete: boolean }
    expect(detail.value).toBe('原文'.repeat(1000))
    expect(detail.complete).toBe(true)
    const second = (await registry.invoke('get_element_field', ctx, {
      id,
      field_path: '/params/shots',
      offset: first.next_offset,
      expected_version: first.version,
    })) as { value: Array<{ key: string }> }
    expect(second.value[0]!.key).toBe(String(first.next_offset))
    ydoc.destroy()
  })
})
