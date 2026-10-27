import type { Engine } from '@plein/canvas-core'
import { createDoc, createElement, setParam } from '@plein/doc'
import { Shot } from '@plein/nodes'
import type { Catalog } from '@plein/protocol'
import { afterEach, vi } from 'vite-plus/test'
import { useCanvas } from '../../stores/canvas'
import { useCatalog } from '../../stores/catalog'
import { resetStoreAfterEach } from '../../testing/render'
import { expandShots, shotsOf } from './model'

resetStoreAfterEach(useCatalog)
const documents: ReturnType<typeof createDoc>[] = []
afterEach(() => {
  for (const doc of documents.splice(0)) {
    doc.destroy()
    doc.ydoc.destroy()
  }
})

/** 文档与撤销保持真实，只替换本域 DOM 控件用到的引擎导航边界。 */
export function storyboardFixture({ count = 2, expanded = false } = {}) {
  const doc = createDoc(undefined, { schedule: () => {} })
  documents.push(doc)
  const engine = {
    doc,
    onStateChange: () => () => {},
    selection: { onChange: () => () => {}, set: vi.fn() },
    zoomToFit: vi.fn(),
    undo: () => {
      doc.undo.undo()
      doc.flush()
    },
    redo: () => {
      doc.undo.redo()
      doc.flush()
    },
  } as unknown as Engine
  const shots = Array.from({ length: count }, (_, i) =>
    Shot.parse({
      id: `shot-${i + 1}`,
      no: i + 1,
      duration: 3,
      description: `画面${i + 1}`,
      imagePrompt: `分镜图${i + 1}`,
      motionPrompt: '缓慢推进',
      dialogue:
        i === 0
          ? [
              { id: 'a', character: '甲', line: '第一句' },
              { id: 'b', character: '乙', line: '第二句' },
            ]
          : [],
    }),
  )
  const board = createElement(doc, {
    kind: 'node',
    nodeType: 'plein/storyboard',
    name: '分镜测试',
    params: { shots },
    x: 0,
    y: 0,
    w: 300,
    h: 200,
  })
  const catalog = {
    nodes: ['image', 'video', 'speech', 'sfx'].map((role) => ({
      type: `plein/${role}`,
      version: 1,
      title: role,
      executable: true,
      defaults: {},
      paramsSchema: { properties: {} },
      inputs: [
        {
          id: role === 'speech' ? 'text' : 'images',
          label: '输入',
          type: role === 'speech' ? 'text' : 'image',
          multiple: true,
        },
      ],
      outputs: [
        {
          id: role === 'image' ? 'images' : role === 'video' ? 'video' : 'audio',
          label: '输出',
          type: role === 'image' ? 'image' : role === 'video' ? 'video' : 'audio',
        },
      ],
    })),
    providers: [],
    models: [],
    templates: [],
  } as unknown as Catalog
  useCatalog.setState({ catalog })
  useCanvas.setState({ engine, canvasId: 'canvas', storyboard: board, sync: 'connected' })
  if (expanded)
    expandShots(
      engine,
      board,
      shots.map((shot) => shot.id),
      catalog,
    )
  doc.flush()
  doc.undo.clear()
  return {
    engine,
    doc,
    board,
    catalog,
    read: () => shotsOf(doc.get(board)),
    write: (value: unknown) => setParam(doc, board, 'shots', value),
    flush: () => doc.flush(),
  }
}
