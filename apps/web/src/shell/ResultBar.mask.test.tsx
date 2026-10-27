// @vitest-environment happy-dom
import { type Engine, Scene, Camera, Selection } from '@plein/canvas-core'
import { createElement, type PleinDoc, updateElement } from '@plein/doc'
import { openDoc } from '@plein/doc/testing'
import type { Catalog } from '@plein/protocol'
import type { ComponentProps } from 'react'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { act, renderApp, resetStoreAfterEach, screen } from '../testing/render'
import { mockFetch } from '../testing/fetch'
import { mockResizeObserver } from '../testing/browser'
import { useCanvas } from '../stores/canvas'
import { useCatalog } from '../stores/catalog'
import type { MaskEditor } from '../features/generator/MaskEditor'
import { ResultBar } from './ResultBar'

const editor = vi.hoisted(() => ({ props: null as ComponentProps<typeof MaskEditor> | null }))
vi.mock('../features/generator/MaskEditor', () => ({
  MaskEditor: (props: ComponentProps<typeof MaskEditor>) => {
    editor.props = props
    return (
      <div role="dialog" aria-label="画板会话">
        <button type="button" onClick={props.onClose}>
          取消画板
        </button>
      </div>
    )
  },
}))
const docs: PleinDoc[] = []
resetStoreAfterEach(useCatalog)
afterEach(() => {
  docs.splice(0).forEach((doc) => doc.destroy())
  editor.props = null
})
const image = {
  type: 'plein/image',
  version: 1,
  title: '图片',
  capability: 'image.generate',
  paramsSchema: { properties: {} },
  defaults: {},
  inputs: [{ id: 'references', type: 'image', label: '参考图' }],
  outputs: [{ id: 'images', type: 'image', label: '图片' }],
}
const edit = {
  ...image,
  type: 'plein/image-edit',
  capability: 'image.edit',
  inputs: [{ id: 'image', type: 'image', label: '原图' }],
}
const catalog = {
  nodes: [image, edit],
  providers: [],
  prompts: [{ id: 'test', title: '测试预设', template: '原图', appliesTo: ['image.generate'] }],
} as unknown as Catalog
function setup() {
  mockResizeObserver()
  mockFetch((request) => {
    const path = new URL(request.url).pathname
    if (path.endsWith('/meta'))
      return Response.json({ id: 'source', kind: 'image', width: 160, height: 96 })
    if (path === '/api/media/caps') return Response.json({ ffmpeg: false })
  })
  const doc = openDoc()
  docs.push(doc)
  const source = createElement(doc, {
    kind: 'image',
    assetId: 'source',
    name: '原图',
    x: 0,
    y: 0,
    w: 160,
    h: 96,
  })
  const scene = new Scene(doc)
  doc.subscribe(() => scene.rebuild())
  const camera = new Camera()
  camera.setViewport(1000, 800)
  const selection = new Selection()
  selection.set([source])
  const noop = () => () => {}
  const engine = {
    doc,
    scene,
    camera,
    selection,
    onStateChange: noop,
    onMove: noop,
    worldToClient: (x: number, y: number) => ({ x, y }),
    setTool: vi.fn(),
    state: { tool: 'select' },
  } as unknown as Engine
  useCanvas.setState({ engine, canvasId: 'canvas' })
  useCatalog.setState({ catalog })
  const view = renderApp(<ResultBar />)
  return { ...view, doc, source, engine }
}
for (const label of ['局部重绘', '预设', '宫格切分']) {
  it(`${label} 所属原图替换会关闭旧弹层，再打开读取新素材`, async () => {
    const f = setup()
    await f.user.click(screen.getByRole('button', { name: label }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    act(() => {
      updateElement(f.doc, f.source, { assetId: 'replacement' })
      f.doc.flush()
    })
    expect(screen.queryByRole('dialog')).toBeNull()
    await f.user.click(screen.getByRole('button', { name: label }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    if (label === '局部重绘') expect(editor.props!.assetId).toBe('replacement')
    else {
      await f.user.keyboard('{Escape}')
      expect(document.activeElement).toBe(screen.getByRole('button', { name: label }))
    }
  })
}
