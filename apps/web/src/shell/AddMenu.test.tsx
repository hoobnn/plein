// @vitest-environment happy-dom
import { Engine, Selection } from '@plein/canvas-core'
import { createDoc, createElement, type PleinDoc } from '@plein/doc'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { act, fireEvent, renderApp, screen } from '../testing/render'
import { AddMenu } from './AddMenu'
import { CanvasMenus } from './CanvasMenus'
import { Toolbar, ViewControls } from './Toolbar'
import { useCanvas } from '../stores/canvas'
import { useDismiss } from '../ui/useDismiss'

const docs: PleinDoc[] = []
afterEach(() => docs.splice(0).forEach((doc) => doc.destroy()))
function engineForMenu(): Engine {
  const doc = createDoc()
  docs.push(doc)
  const engine = Object.create(Engine.prototype) as Engine
  Object.assign(engine, {
    opts: { doc },
    selection: new Selection(),
    setTool: vi.fn(),
    onStateChange: () => () => {},
    camera: { viewRect: { x: 0, y: 0, w: 1400, h: 900 }, centerOn: vi.fn() },
    scene: { get: (id: string) => doc.get(id) },
  })
  return engine
}

it.each([{ isComposing: true }, { keyCode: 229 }])(
  '组字期间导航和确认不会误建节点 %j',
  async (mode) => {
    const engine = engineForMenu()
    const onClose = vi.fn()
    const { user } = renderApp(
      <AddMenu
        engine={engine}
        canImport={false}
        at={() => ({ x: 500, y: 400 })}
        onClose={onClose}
      />,
    )
    const input = screen.getByRole('textbox', { name: '搜索节点' })
    const active = screen.getByRole('option', { selected: true })
    for (const key of ['ArrowDown', 'ArrowUp', 'Enter']) fireEvent.keyDown(input, { key, ...mode })
    expect(screen.getByRole('option', { selected: true })).toBe(active)
    expect([...engine.doc.elements()]).toEqual([])
    expect(onClose).not.toHaveBeenCalled()
    await user.type(input, 'Markdown')
    await user.keyboard('{Enter}')
    expect([...engine.doc.elements()].map((el) => el.kind)).toEqual(['markdown'])
    expect(onClose).toHaveBeenCalledTimes(1)
  },
)

it('搜索无匹配时 Enter 不创建；返回匹配结果后选择和撤销只影响新节点', async () => {
  const engine = engineForMenu()
  const { user } = renderApp(
    <AddMenu
      engine={engine}
      canImport={false}
      at={() => ({ x: 500, y: 400 })}
      onClose={() => {}}
    />,
  )
  const input = screen.getByRole('textbox', { name: '搜索节点' })
  await user.type(input, '不存在xyz')
  expect(screen.getByText('没有匹配的节点')).toBeTruthy()
  await user.keyboard('{Enter}')
  expect([...engine.doc.elements()]).toEqual([])
  await user.clear(input)
  await user.type(input, 'Frame')
  await user.click(screen.getByRole('option', { name: 'Frame' }))
  expect([...engine.doc.elements()].map((el) => el.kind)).toEqual(['frame'])
  engine.doc.undo.undo()
  expect([...engine.doc.elements()]).toEqual([])
  engine.doc.undo.redo()
  expect([...engine.doc.elements()]).toHaveLength(1)
})

it('取消浮层时兼容组字结束的 229 Escape，普通 Escape 正常关闭', () => {
  const close = vi.fn()
  function Floating() {
    const ref = useDismiss(close)
    return (
      <div ref={ref}>
        <input aria-label="搜索" />
      </div>
    )
  }
  renderApp(<Floating />)
  const input = screen.getByRole('textbox')
  fireEvent.keyDown(input, { key: 'Escape', keyCode: 229 })
  expect(close).not.toHaveBeenCalled()
  fireEvent.keyDown(input, { key: 'Escape' })
  expect(close).toHaveBeenCalledTimes(1)
})

it('右键菜单 Home/End 导航，关闭不修改选区', async () => {
  const engine = engineForMenu()
  const id = createElement(engine.doc, { kind: 'frame', name: '分组', x: 0, y: 0, w: 600, h: 400 })
  engine.selection.values = () => [id]
  engine.ungroupSelection = vi.fn()
  useCanvas.setState({
    engine,
    menu: { kind: 'context', target: id, client: { x: 100, y: 100 }, world: { x: 100, y: 100 } },
  })
  const { user } = renderApp(<CanvasMenus canImport={false} />)
  const items = screen.getAllByRole('menuitem')
  expect(document.activeElement).toBe(items[0])
  await user.keyboard('{End}')
  expect(document.activeElement).toBe(items.at(-1))
  await user.keyboard('{Home}')
  expect(document.activeElement).toBe(items[0])
  await user.keyboard('{Escape}')
  expect(useCanvas.getState().menu).toBeNull()
  expect(engine.selection.values()).toEqual([id])
  expect(engine.ungroupSelection).not.toHaveBeenCalled()
})

it('只读右键菜单禁止修改，仍允许缩放到选中', async () => {
  const engine = engineForMenu()
  const id = createElement(engine.doc, { kind: 'frame', name: '分组', x: 0, y: 0, w: 600, h: 400 })
  engine.selection.values = () => [id]
  engine.doc.readOnly = true
  engine.zoomToFit = vi.fn()
  useCanvas.setState({
    engine,
    menu: { kind: 'context', target: id, client: { x: 100, y: 100 }, world: { x: 100, y: 100 } },
  })
  const { user } = renderApp(<CanvasMenus canImport={false} />)
  for (const name of ['复制一份', '打组', '解组', '置于顶层', '置于底层', '删除'])
    expect(
      screen.getByRole<HTMLButtonElement>('menuitem', { name: new RegExp(name) }).disabled,
    ).toBe(true)
  await user.click(screen.getByRole('menuitem', { name: /缩放到选中/ }))
  expect(engine.zoomToFit).toHaveBeenCalledWith([id])
})

it('场景节点右键可打开准备视图，只读画布也保留入口', async () => {
  const engine = engineForMenu()
  const id = createElement(engine.doc, {
    kind: 'node',
    nodeType: 'plein/scene',
    name: '天台',
    x: 0,
    y: 0,
    w: 200,
    h: 160,
  })
  engine.selection.set([id])
  engine.doc.readOnly = true
  useCanvas.setState({
    engine,
    menu: { kind: 'context', target: id, client: { x: 100, y: 100 }, world: { x: 100, y: 100 } },
  })
  const { user } = renderApp(<CanvasMenus canImport={false} />)
  await user.click(screen.getByRole('menuitem', { name: '场景准备' }))
  expect(useCanvas.getState().scenePrep).toBe(id)
  expect(useCanvas.getState().menu).toBeNull()
})

it('创建菜单已打开时变为只读，旧 Enter 不创建并退出', () => {
  const engine = engineForMenu()
  const onClose = vi.fn()
  renderApp(
    <AddMenu engine={engine} canImport={false} at={() => ({ x: 500, y: 400 })} onClose={onClose} />,
  )
  engine.doc.readOnly = true
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
  expect([...engine.doc.elements()]).toEqual([])
  expect(onClose).toHaveBeenCalledTimes(1)
})

it('工具条添加节点随只读状态禁用，恢复可写后可再次打开创建菜单', async () => {
  const doc = createDoc()
  docs.push(doc)
  const engine = new Engine({ host: document.createElement('div'), doc })
  engine.doc.readOnly = true
  useCanvas.setState({ engine })
  const { user } = renderApp(<Toolbar canImport={false} />)
  const button = screen.getByRole<HTMLButtonElement>('button', { name: '添加节点' })
  expect(button.disabled).toBe(true)
  await user.click(button)
  expect(screen.queryByRole('textbox', { name: '搜索节点' })).toBeNull()
  act(() => {
    engine.doc.readOnly = false
    engine.refreshState()
  })
  expect(button.disabled).toBe(false)
  await user.click(button)
  expect(screen.getByRole('textbox', { name: '搜索节点' })).toBeTruthy()
  act(() => {
    engine.doc.readOnly = true
    engine.refreshState()
  })
  expect(button.disabled).toBe(true)
  expect(screen.queryByRole('textbox', { name: '搜索节点' })).toBeNull()
})

it('分组右键解组入口写入真实文档，单步撤销恢复父子结构', async () => {
  const engine = engineForMenu()
  const frame = createElement(engine.doc, {
    kind: 'frame',
    name: '分组',
    x: 100,
    y: 100,
    w: 600,
    h: 400,
  })
  const child = createElement(engine.doc, {
    kind: 'markdown',
    text: '正文',
    parentId: frame,
    x: 20,
    y: 30,
    w: 200,
    h: 100,
  })
  engine.selection.set([frame])
  useCanvas.setState({
    engine,
    menu: { kind: 'context', target: frame, client: { x: 100, y: 100 }, world: { x: 100, y: 100 } },
  })
  const { user } = renderApp(<CanvasMenus canImport={false} />)
  await user.click(screen.getByRole('menuitem', { name: /解组/ }))
  expect(engine.doc.has(frame)).toBe(false)
  expect(engine.doc.get(child)?.parentId).toBeNull()
  expect(engine.doc.worldRect(child)).toMatchObject({ x: 120, y: 130 })
  engine.doc.undo.undo()
  expect(engine.doc.get(child)?.parentId).toBe(frame)
})

it('底部工具单击切换，缩放输入获得焦点、确认数值或取消后退出', async () => {
  const engine = engineForMenu()
  engine.zoomTo = vi.fn()
  useCanvas.setState({ engine })
  const { user } = renderApp(
    <>
      <Toolbar canImport={false} />
      <ViewControls />
    </>,
  )
  const tool = screen.getByRole('button', { name: '工具' })
  await user.click(tool)
  expect(engine.setTool).toHaveBeenCalledWith('hand')
  act(() => useCanvas.setState({ tool: 'hand' }))
  expect(tool.getAttribute('aria-pressed')).toBe('true')
  await user.click(tool)
  expect(engine.setTool).toHaveBeenLastCalledWith('select')
  await user.click(screen.getByRole('button', { name: '缩放选项' }))
  const input = screen.getByRole<HTMLInputElement>('textbox', { name: '缩放百分比' })
  expect(document.activeElement).toBe(input)
  await user.clear(input)
  await user.type(input, '125')
  await user.keyboard('{Enter}')
  expect(engine.zoomTo).toHaveBeenCalledWith(1.25)
  expect(screen.queryByRole('dialog', { name: '缩放' })).toBeNull()
  await user.click(screen.getByRole('button', { name: '缩放选项' }))
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('dialog', { name: '缩放' })).toBeNull()
  expect(engine.zoomTo).toHaveBeenCalledTimes(1)
})
