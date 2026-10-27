// @vitest-environment happy-dom
import type { Engine } from '@plein/canvas-core'
import { openDoc } from '@plein/doc/testing'
import type { PleinDoc } from '@plein/doc'
import { corePlugin } from '@plein/nodes'
import { describeNode } from '@plein/plugin-sdk'
import { LOCAL_PRINCIPAL, type Catalog } from '@plein/protocol'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { useCanvas } from '../stores/canvas'
import { useCatalog } from '../stores/catalog'
import { useSession } from '../stores/session'
import { act, fireEvent, renderApp, resetStoreAfterEach, screen } from '../testing/render'
import { CanvasStart } from './CanvasStart'
resetStoreAfterEach(useCatalog)
const docs: PleinDoc[] = []
afterEach(() => docs.splice(0).forEach((doc) => doc.destroy()))
function setup() {
  const doc = openDoc()
  docs.push(doc)
  const engine = {
    doc,
    selection: { set: vi.fn() },
    setTool: vi.fn(),
    camera: { viewRect: { x: 0, y: 0, w: 800, h: 600 } },
  } as unknown as Engine
  useCanvas.setState({ engine, canvasId: 'c' })
  useCatalog.setState({
    catalog: {
      nodes: corePlugin.nodes.map((n) => ({ ...describeNode(n, 'plein/core'), executable: true })),
    } as Catalog,
  })
  useSession.setState({
    info: { principal: LOCAL_PRINCIPAL, authRequired: false, needsSetup: false },
  })
  return { doc, engine, ...renderApp(<CanvasStart engine={engine} />) }
}
it('四种快捷入口只创建对应草稿、可撤销且不运行', async () => {
  const f = setup()
  for (const [title, type] of [
    ['角色', 'character'],
    ['场景', 'scene'],
    ['图片', 'image'],
    ['视频', 'video'],
  ]) {
    await f.user.click(screen.getByRole('button', { name: `新建${title}节点` }))
    const elements = [...f.doc.elements()]
    expect(elements).toHaveLength(1)
    expect(elements[0]?.nodeType).toBe(`plein/${type}`)
    expect(elements[0]?.run).toBeUndefined()
    act(() => {
      f.doc.undo.undo()
      f.doc.flush()
    })
    expect([...f.doc.elements()]).toEqual([])
  }
})
it('实时只读或切换画布后旧创建按钮不能写入', () => {
  const f = setup()
  const button = screen.getByRole('button', { name: '新建角色节点' })
  f.doc.readOnly = true
  fireEvent.click(button)
  expect([...f.doc.elements()]).toEqual([])
  f.doc.readOnly = false
  act(() => useCanvas.setState({ engine: null }))
  fireEvent.click(button)
  expect([...f.doc.elements()]).toEqual([])
  act(() =>
    useSession.setState({
      info: {
        principal: { ...LOCAL_PRINCIPAL, role: 'viewer' },
        authRequired: false,
        needsSetup: false,
      },
    }),
  )
  expect(screen.queryByRole('button', { name: '新建角色节点' })).toBeNull()
})
