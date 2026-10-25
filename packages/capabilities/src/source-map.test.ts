import { captureSourceSnapshot, connect, createElement, type PleinDoc } from '@plein/doc'
import { openDoc, node } from '@plein/doc/testing'
import { describe, expect, it } from 'vite-plus/test'
import type { CapabilityContext } from './define'
import { readViewCapabilities } from './read-view'
import { CapabilityRegistry } from './registry'

describe('原文快照的Agent有界读取', () => {
  it('实际get_element_field逐页还原全文，不把400字preview当作完整原文', async () => {
    const doc = openDoc()
    const text = '重复对白😀\r\n'.repeat(6000)
    const source = createElement(
      doc,
      node({
        nodeType: 'plein/text',
        params: { text },
        ports: { inputs: [], outputs: [{ id: 'text', label: '文本', type: 'text' }] },
      }),
    )
    const board = createElement(
      doc,
      node({
        nodeType: 'plein/storyboard',
        ports: { inputs: [{ id: 'script', label: '剧本', type: 'text' }], outputs: [] },
      }),
    )
    connect(doc, [source, 'text'], [board, 'script'])
    expect(
      captureSourceSnapshot(doc, board, {
        canvasId: 'c',
        elementId: source,
        port: 'text',
        expectedText: text,
      }),
    ).toBeTruthy()
    const ctx: CapabilityContext = {
      withDoc: <T>(fn: (doc: PleinDoc) => T) => fn(doc),
      assetMeta: () => undefined,
      nodes: {
        latest: () => undefined,
        all: () => [],
        models: () => [],
        defaultModel: () => '',
        prompts: () => [],
      },
    }
    const registry = new CapabilityRegistry(readViewCapabilities)
    let value = '',
      offset = 0,
      version: string | undefined
    while (offset < text.length) {
      const result = (await registry.invoke('get_element_field', ctx, {
        id: board,
        field_path: '/production/sourceMap/snapshots/0/text',
        text_offset: offset,
        text_limit: 8000,
        expected_version: version,
      })) as { value: string; version: string; complete: boolean; next_text_offset?: number }
      expect(result.value.length).toBeLessThanOrEqual(8000)
      expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(24576)
      value += result.value
      version = result.version
      if (result.complete) break
      offset = result.next_text_offset!
    }
    expect(value).toBe(text)
    doc.destroy()
  })
})
