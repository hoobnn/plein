import { Camera, type Engine } from '@plein/canvas-core'
import { addResults, createElement, type NewElement, type NodeResult } from '@plein/doc'
import { openDoc } from '@plein/doc/testing'
import { imageNode, llmNode, speechNode, textNode, videoNode } from '@plein/nodes'
import { describeNode } from '@plein/plugin-sdk'
import type { Asset, Catalog } from '@plein/protocol'
import { afterEach, vi } from 'vite-plus/test'
import { useCatalog } from '../stores/catalog'
import { useCanvas } from '../stores/canvas'
import { useStale } from '../features/runs/stale'
import { resetStoreAfterEach } from '../testing/render'

resetStoreAfterEach(useCatalog)
resetStoreAfterEach(useStale)
const docs: ReturnType<typeof openDoc>[] = []
afterEach(() => {
  for (const doc of docs.splice(0)) doc.destroy()
})
export const catalog: Catalog = {
  nodes: [textNode, llmNode, imageNode, videoNode, speechNode].map((node) => ({
    ...describeNode(node, 'plein'),
    executable: true,
  })),
  plugins: [],
  providers: [],
  defaultModels: {},
  templates: [],
  prompts: [],
  elements: [],
}

/** 真实文档与相机；只替换 GPU 引擎边界的选区、定位和场景矩形读取。 */
export function shellFixture() {
  const doc = openDoc()
  docs.push(doc)
  const camera = new Camera()
  camera.setViewport(1200, 800)
  let selected: string[] = []
  const listeners = new Set<() => void>()
  const selection = {
    set: vi.fn((ids: string[]) => {
      selected = ids
      for (const fn of listeners) fn()
    }),
    clear() {
      this.set([])
    },
    values: () => selected,
    has: (id: string) => selected.includes(id),
    get size() {
      return selected.length
    },
    onChange(fn: () => void) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
  const engine = {
    doc,
    camera,
    selection,
    scene: { rect: (id: string) => (doc.has(id) ? doc.worldRect(id) : null) },
    state: { tool: 'select' },
    onStateChange: () => () => {},
    setTool: vi.fn(),
    zoomToFit: vi.fn(),
  } as unknown as Engine
  useCanvas.setState({ engine, canvasId: 'shell-test', mode: 'board' })
  useCatalog.setState({ catalog })
  const add = (
    type: 'text' | 'llm' | 'image' | 'video' | 'speech',
    name: string,
    extra: Partial<NewElement> = {},
  ) => {
    const info = catalog.nodes.find((node) => node.type === `plein/${type}`)!
    return createElement(doc, {
      kind: 'node',
      nodeType: info.type,
      name,
      x: 0,
      y: 0,
      w: 320,
      h: 200,
      ports: { inputs: info.inputs, outputs: info.outputs },
      ...extra,
    })
  }
  const results = (id: string, type: 'text' | 'image' | 'video' | 'audio', count = 3) => {
    const port = doc.get(id)!.ports!.outputs[0]!.id
    const rows: NodeResult[] = Array.from({ length: count }, (_, i) => ({
      id: `${id}-result-${i}`,
      runId: `run-${i}`,
      port,
      at: i + 1,
      value: type === 'text' ? { type, text: `正文 ${i}` } : { type, assetId: `${id}-asset-${i}` },
    }))
    addResults(doc, id, rows)
    return rows
  }
  return { doc, engine, add, results, selection }
}

export const mediaAsset = (id: string, kind: Asset['kind'] = 'image'): Asset => ({
  id,
  kind,
  name: `${id}.png`,
  mime: kind === 'audio' ? 'audio/wav' : 'image/png',
  size: 10,
  variants: [],
  createdAt: 1,
  width: 160,
  height: 90,
})
