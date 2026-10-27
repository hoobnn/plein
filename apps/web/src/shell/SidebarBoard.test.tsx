// @vitest-environment happy-dom
import { Camera, Scene, Selection, type Engine } from '@plein/canvas-core'
import { createDoc, createElement } from '@plein/doc'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { useCanvas } from '../stores/canvas'
import { useSidebar } from '../stores/sidebar'
import {
  act,
  fireEvent,
  renderApp,
  resetStoreAfterEach,
  screen,
  waitFor,
  within,
} from '../testing/render'
import { Sidebar } from './Sidebar'
import { Board } from './Board'

resetStoreAfterEach(useSidebar)
const cleanups: (() => void)[] = []
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
)
function fixture(group = false) {
  const doc = createDoc()
  cleanups.push(() => doc.destroy())
  const parentId = group
    ? createElement(doc, { kind: 'frame', name: '分组', x: 0, y: 0, w: 900, h: 600 })
    : undefined
  const done = createElement(doc, {
    kind: 'node',
    nodeType: 'plein/llm',
    nodeVersion: 1,
    name: '已完成文本',
    x: 400,
    y: 200,
    w: 300,
    h: 180,
    parentId,
    ports: { inputs: [], outputs: [{ id: 'text', type: 'text', label: '文本' }] },
    results: [
      {
        id: 'done-result',
        runId: 'fixture',
        port: 'text',
        at: 1,
        value: { type: 'text', text: '已完成正文' },
      },
    ],
    adopted: 'done-result',
  })
  createElement(doc, {
    kind: 'node',
    nodeType: 'plein/text',
    nodeVersion: 1,
    name: '待生成文本',
    x: 800,
    y: 200,
    w: 300,
    h: 180,
    parentId,
    ports: { inputs: [], outputs: [{ id: 'text', type: 'text', label: '文本' }] },
  })
  doc.flush()
  const scene = new Scene(doc)
  cleanups.push(doc.subscribe((change) => scene.apply(change)))
  const selection = new Selection()
  const camera = new Camera()
  const engine = { doc, scene, selection, camera, zoomToFit: vi.fn() } as unknown as Engine
  useCanvas.setState({ engine })
  return { doc, engine, done, parentId }
}

it('侧栏分组方向键折叠展开只改树，不移动文档', async () => {
  const { doc } = fixture(true)
  const before = [...doc.elements()]
  const { user } = renderApp(<Sidebar open />)
  const group = screen.getByRole('treeitem', { name: '分组' })
  group.focus()
  await user.keyboard('{ArrowLeft}')
  expect(screen.getAllByRole('treeitem')).toHaveLength(1)
  await user.keyboard('{ArrowRight}')
  expect(screen.getAllByRole('treeitem')).toHaveLength(3)
  expect([...doc.elements()]).toEqual(before)
})

it('侧栏组字确认取消保留名称草稿，重命名单独撤销不回退紧邻位置修改', async () => {
  const { doc, done } = fixture()
  const { user } = renderApp(<Sidebar open />)
  await user.dblClick(screen.getByRole('treeitem', { name: /已完成文本/ }))
  const input = screen.getByRole<HTMLInputElement>('textbox', { name: '元素名称' })
  await user.clear(input)
  await user.type(input, '新的名称')
  for (const key of ['Enter', 'Escape']) fireEvent.keyDown(input, { key, isComposing: true })
  expect(input.value).toBe('新的名称')
  act(() => {
    doc.undo.stopCapturing()
    doc.mutable(done)!.set('x', 101)
    doc.flush()
  })
  await user.keyboard('{Enter}')
  expect(doc.get(done)?.name).toBe('新的名称')
  act(() => {
    doc.undo.undo()
    doc.flush()
  })
  expect(doc.get(done)?.name).toBe('已完成文本')
  expect(doc.worldRect(done)!.x).toBe(101)
})

it('侧栏菜单键盘筛选保留选区与元素位置', async () => {
  const { doc, engine, done } = fixture()
  engine.selection.set([done])
  const before = [...doc.elements()]
  const { user } = renderApp(<Sidebar open />)
  const trigger = screen.getByRole('button', { name: '按类型筛选' })
  await user.click(trigger)
  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  await user.click(trigger)
  await user.click(screen.getByRole('menuitemradio', { name: '文本' }))
  expect(screen.getAllByRole('treeitem')).toHaveLength(2)
  expect(engine.selection.values()).toEqual([done])
  expect([...doc.elements()]).toEqual(before)
})

it('故事板已生成筛选随采用结果更新，展开还原保留筛选', async () => {
  const { doc, done } = fixture()
  useCanvas.setState({ mode: 'board' })
  const { user } = renderApp(<Board />)
  const region = within(screen.getByRole('region', { name: '文本' }))
  await user.click(region.getByRole('button', { name: '筛选' }))
  await user.click(screen.getByRole('menuitemradio', { name: '已生成' }))
  expect(region.getAllByRole('listitem')).toHaveLength(1)
  expect(region.getByText('已完成文本')).toBeTruthy()
  await user.click(region.getByRole('button', { name: '展开此栏' }))
  expect(region.getByRole('button', { name: '筛选' }).textContent).toContain('已生成')
  await user.click(region.getByRole('button', { name: '还原分栏' }))
  act(() => {
    doc.mutable(done)!.set('adopted', null)
    doc.flush()
  })
  expect(region.getByText('没有符合筛选的内容')).toBeTruthy()
  act(() => {
    doc.mutable(done)!.set('adopted', 'done-result')
    doc.flush()
  })
  expect(region.getAllByRole('listitem')).toHaveLength(1)
  await user.click(region.getByRole('button', { name: '筛选' }))
  await user.click(screen.getByRole('menuitemradio', { name: '待生成' }))
  expect(region.getByText('待生成文本')).toBeTruthy()
})
