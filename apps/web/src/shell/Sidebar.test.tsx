// @vitest-environment happy-dom
import { type Engine, Scene, Selection } from '@plein/canvas-core'
import { createElement, createDoc, deleteElements, type PleinDoc } from '@plein/doc'
import type { LibraryItem } from '@plein/protocol'
import { expect, it, vi } from 'vite-plus/test'
import { useLibrary } from '../features/library/store'
import { useCanvas } from '../stores/canvas'
import { useSidebar } from '../stores/sidebar'
import { mockFetch } from '../testing/fetch'
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

resetStoreAfterEach(useSidebar)
resetStoreAfterEach(useLibrary)

/**
 * 侧栏的图层树只依赖文档、场景树和选区：真实 PleinDoc + 真实 Scene/Selection，
 * 相机与渲染边界用可观测的桩。
 */
function makeEngine() {
  const doc = createDoc(undefined, { schedule: (flush) => flush() })
  const scene = new Scene(doc)
  const selection = new Selection()
  doc.subscribe((change) => {
    scene.apply(change)
    selection.prune((id) => scene.has(id))
  })
  const zoomToFit = vi.fn()
  const engine = {
    doc,
    scene,
    selection,
    zoomToFit,
    camera: {
      width: 1200,
      height: 800,
      insets: { left: 0, top: 0, right: 0, bottom: 0 },
      worldToScreen: (x: number, y: number) => ({ x, y }),
      centerOn: vi.fn(),
    },
    onStateChange: () => () => {},
    onMenu: () => () => {},
    onArrange: () => () => {},
    state: {
      tool: 'select',
      zoom: 1,
      selection: 0,
      canUndo: false,
      canRedo: false,
      edgesHidden: false,
    },
  } as unknown as Engine
  return { engine, doc, scene, selection, zoomToFit }
}

const addText = (doc: PleinDoc, name: string, x = 0) =>
  createElement(doc, {
    kind: 'node',
    nodeType: 'plein/text',
    nodeVersion: 1,
    name,
    params: { text: name },
    x,
    y: 0,
    w: 200,
    h: 200,
    ports: {
      inputs: [{ id: 'prompt', label: '提示词', type: 'text' }],
      outputs: [{ id: 'text', label: '文本', type: 'text' }],
    },
  })

const addImage = (doc: PleinDoc, name: string, x = 0) =>
  createElement(doc, {
    kind: 'node',
    nodeType: 'plein/image',
    nodeVersion: 1,
    name,
    x,
    y: 0,
    w: 200,
    h: 200,
    ports: { inputs: [], outputs: [{ id: 'images', label: '图片', type: 'image' }] },
  })

const addFrame = (doc: PleinDoc, name: string) =>
  createElement(doc, { kind: 'frame', name, x: 0, y: 0, w: 400, h: 400 })

/** 三个文本 / 图片元素；framing 为真时把前两个放进一个分组 */
function setupLayers(opts: { frame?: boolean } = {}) {
  const { engine, doc, selection, zoomToFit } = makeEngine()
  const a = addText(doc, '海边文本')
  const b = addText(doc, '山林文本')
  const c = addImage(doc, '海边图片')
  let frame: string | null = null
  if (opts.frame) {
    frame = addFrame(doc, '分组一')
    doc.mutable(a)!.set('parentId', frame)
    doc.mutable(b)!.set('parentId', frame)
  }
  useCanvas.setState({ engine, canvasId: 'canvas-1' })
  const rendered = renderApp(<Sidebar open />)
  const sidebar = screen.getByRole('complementary', { name: '侧栏' })
  return {
    engine,
    doc,
    selection,
    zoomToFit,
    sidebar,
    user: rendered.user,
    ids: { a, b, c, frame },
  }
}

const tree = () => within(screen.getByRole('complementary', { name: '侧栏' }))
const rows = () => tree().queryAllByRole('treeitem')

it('搜索过滤实时响应，Escape 与按钮关闭后焦点返回搜索入口并恢复结果', async () => {
  const f = setupLayers()
  const { user } = { user: null as never }
  void user
  expect(rows()).toHaveLength(3)
  tree().getByRole('button', { name: '搜索' }).click()
  const query = await tree().findByRole<HTMLInputElement>('textbox', {
    name: '搜索画布元素',
  })
  expect(document.activeElement).toBe(query)
  await act(async () => {
    fireEvent.input(query, { target: { value: '海边' } })
  })
  await waitFor(() => expect(rows()).toHaveLength(2))
  fireEvent.keyDown(query, { key: 'Escape' })
  await waitFor(() => expect(tree().queryByRole('textbox')).toBeNull())
  expect(rows()).toHaveLength(3)
  const open = tree().getByRole('button', { name: '搜索' })
  expect(document.activeElement).toBe(open)
  open.click()
  const reopened = await tree().findByRole<HTMLInputElement>('textbox', {
    name: '搜索画布元素',
  })
  expect(reopened.value).toBe('')
  void f
})

it('组字中的 Escape 不关闭搜索也不丢查询', async () => {
  setupLayers()
  tree().getByRole('button', { name: '搜索' }).click()
  const query = await tree().findByRole<HTMLInputElement>('textbox', {
    name: '搜索画布元素',
  })
  await act(async () => {
    fireEvent.input(query, { target: { value: '海边' } })
  })
  await waitFor(() => expect(rows()).toHaveLength(2))
  for (const composing of [{ keyCode: 229 }, { isComposing: true }])
    fireEvent.keyDown(query, { key: 'Escape', ...composing })
  expect(tree().getByRole('textbox', { name: '搜索画布元素' })).toBe(query)
  expect(query.value).toBe('海边')
  expect(document.activeElement).toBe(query)
  expect(rows()).toHaveLength(2)
})

it('类型与名称组合筛选实时响应重命名，清除类型保留查询与焦点', async () => {
  setupLayers()
  // 类型筛选
  tree().getByRole('button', { name: '按类型筛选' }).click()
  fireEvent.click(await screen.findByRole('menuitemradio', { name: '文本' }))
  await waitFor(() => expect(rows()).toHaveLength(2))
  // 名称搜索
  tree().getByRole('button', { name: '搜索' }).click()
  const query = await tree().findByRole<HTMLInputElement>('textbox', {
    name: '搜索画布元素',
  })
  await act(async () => {
    fireEvent.input(query, { target: { value: '海边' } })
  })
  await waitFor(() => expect(rows()).toHaveLength(1))
  expect(rows()[0]!.getAttribute('data-id')).toBeTruthy()
  // 重命名让结果撤下
  const row = rows()[0]!
  fireEvent.keyDown(row, { key: 'F2' })
  const input = within(row).getByRole<HTMLInputElement>('textbox', { name: '元素名称' })
  await act(async () => {
    fireEvent.input(input, { target: { value: '海湾文本' } })
  })
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(rows()).toHaveLength(0))
  // 键盘提交后焦点回到查询框，查询还在
  await waitFor(() => expect(document.activeElement).toBe(query))
  expect(query.value).toBe('海边')
  // 改名真的生效了：换查询能找到新名字
  await act(async () => {
    fireEvent.input(query, { target: { value: '海湾' } })
  })
  await waitFor(() => expect(tree().getByRole('treeitem', { name: /海湾文本/ })).toBeTruthy())
  // 清除类型筛选：查询保留、焦点保留、描述清掉
  const clear = tree().getByRole('button', { name: '清除类型筛选：文本' })
  expect(query.getAttribute('aria-describedby')).toBeTruthy()
  clear.click()
  // 类型清掉了，但查询还在：只有名称匹配的一行
  await waitFor(() => expect(rows()).toHaveLength(1))
  expect(query.value).toBe('海湾')
  expect(document.activeElement).toBe(query)
  expect(query.getAttribute('aria-describedby')).toBeNull()
})

it('鼠标选中其他结果提交重命名，不把焦点抢回查询框', async () => {
  const f = setupLayers()
  tree().getByRole('button', { name: '搜索' }).click()
  const query = await tree().findByRole<HTMLInputElement>('textbox', {
    name: '搜索画布元素',
  })
  await act(async () => {
    fireEvent.input(query, { target: { value: '海边' } })
  })
  await waitFor(() => expect(rows()).toHaveLength(2))
  const row = tree().getByRole('treeitem', { name: /海边文本/ })
  fireEvent.keyDown(row, { key: 'F2' })
  const input = within(row).getByRole<HTMLInputElement>('textbox', { name: '元素名称' })
  await act(async () => {
    fireEvent.input(input, { target: { value: '山林新名称' } })
  })
  // 鼠标点选另一行：提交改名（失焦），焦点留在被点的行
  const other = tree().getByRole('treeitem', { name: /海边图片/ })
  await f.user.click(other)
  await waitFor(() => expect(tree().queryByRole('textbox', { name: '元素名称' })).toBeNull())
  expect(other.getAttribute('aria-selected')).toBe('true')
  expect(f.selection.values()).toEqual([f.ids.c])
  expect(document.activeElement).not.toBe(query)
  expect(f.doc.get(f.ids.a)?.name).toBe('山林新名称')
})

it('筛选期间停用分组折叠并说明，退出后保留折叠偏好', async () => {
  const f = setupLayers({ frame: true })
  await waitFor(() => expect(rows()).toHaveLength(4))
  const group = tree().getByRole('treeitem', { name: /分组一/ })
  const caret = within(group).getByRole('button', { name: '折叠' })
  // 先收起分组
  caret.click()
  await waitFor(() => expect(rows()).toHaveLength(2))
  // 搜索期间分组强制展开且折叠按钮停用
  tree().getByRole('button', { name: '搜索' }).click()
  const query = await tree().findByRole<HTMLInputElement>('textbox', {
    name: '搜索画布元素',
  })
  await act(async () => {
    fireEvent.input(query, { target: { value: '文本' } })
  })
  // 筛选命中组内两个子项：分组保持展开，组外的图片不出现在结果里
  await waitFor(() => expect(rows()).toHaveLength(3))
  expect(group.getAttribute('aria-expanded')).toBe('true')
  expect((caret as HTMLButtonElement).disabled).toBe(true)
  expect(caret.getAttribute('title')).toBe('筛选时分组保持展开，清除筛选后可折叠')
  // 退出筛选：偏好恢复为收起
  fireEvent.keyDown(query, { key: 'Escape' })
  await waitFor(() => expect(rows()).toHaveLength(2))
  expect(group.getAttribute('aria-expanded')).toBe('false')
  expect((caret as HTMLButtonElement).disabled).toBe(false)
  void f
})

it('类型筛选期间同样停用折叠，全部分组入口停用并说明', async () => {
  setupLayers({ frame: true })
  await waitFor(() => expect(rows()).toHaveLength(4))
  const group = tree().getByRole('treeitem', { name: /分组一/ })
  within(group).getByRole('button', { name: '折叠' }).click()
  await waitFor(() => expect(rows()).toHaveLength(2))
  tree().getByRole('button', { name: '按类型筛选' }).click()
  fireEvent.click(await screen.findByRole('menuitemradio', { name: '文本' }))
  await waitFor(() => expect(rows()).toHaveLength(3))
  expect(group.getAttribute('aria-expanded')).toBe('true')
  const all = tree().getByRole('button', { name: /^(展开|折叠)全部分组$/ })
  expect((all as HTMLButtonElement).disabled).toBe(true)
  expect(all.getAttribute('title')).toBe('筛选时分组保持展开，清除筛选后可折叠')
  // 清除类型筛选后恢复折叠偏好
  tree().getByRole('button', { name: '按类型筛选' }).click()
  fireEvent.click(await screen.findByRole('menuitemradio', { name: '全部类型' }))
  await waitFor(() => expect(rows()).toHaveLength(2))
  expect((all as HTMLButtonElement).disabled).toBe(false)
})

it('树键盘：方向键移动焦点，Enter 与空格激活选区，Tab 离开', async () => {
  const f = setupLayers()
  // 列表按绘制顺序的反序排列：后放进文档的排在最上
  const first = tree().getByRole('treeitem', { name: /海边图片/ })
  const middle = tree().getByRole('treeitem', { name: /山林文本/ })
  const last = tree().getByRole('treeitem', { name: /海边文本/ })
  first.focus()
  fireEvent.keyDown(first, { key: 'ArrowDown' })
  await waitFor(() => expect(document.activeElement).toBe(middle))
  // 只有一行承担 Tab 停靠
  expect(rows().filter((row) => row.tabIndex === 0)).toHaveLength(1)
  fireEvent.keyDown(middle, { key: 'End' })
  await waitFor(() => expect(document.activeElement).toBe(last))
  fireEvent.keyDown(last, { key: 'ArrowDown' })
  expect(document.activeElement).toBe(last)
  fireEvent.keyDown(last, { key: 'Home' })
  await waitFor(() => expect(document.activeElement).toBe(first))
  fireEvent.keyDown(first, { key: 'ArrowUp' })
  expect(document.activeElement).toBe(first)
  // 方向键浏览不改变选区
  expect(f.selection.values()).toEqual([])
  fireEvent.keyDown(first, { key: ' ' })
  await waitFor(() => expect(f.selection.values()).toEqual([f.ids.c]))
  fireEvent.keyDown(middle, { key: 'Enter' })
  await waitFor(() => expect(f.selection.values()).toEqual([f.ids.b]))
  // Tab 移出树到宽度手柄，Shift+Tab 回到树的停靠行（当前焦点行）
  await f.user.tab()
  expect(document.activeElement).toBe(tree().getByRole('separator', { name: '调整侧栏宽度' }))
  await f.user.tab({ shift: true })
  await waitFor(() => {
    expect(document.activeElement?.getAttribute('data-id')).toBe(f.ids.c)
  })
})

it('分组的左右键展开折叠并进出子项，不访问隐藏行', async () => {
  const f = setupLayers({ frame: true })
  await waitFor(() => expect(rows()).toHaveLength(4))
  const group = tree().getByRole('treeitem', { name: /分组一/ })
  group.focus()
  fireEvent.keyDown(group, { key: 'ArrowLeft' })
  await waitFor(() => expect(rows()).toHaveLength(2))
  expect(group.getAttribute('aria-expanded')).toBe('false')
  fireEvent.keyDown(group, { key: 'ArrowRight' })
  await waitFor(() => {
    expect(rows()).toHaveLength(4)
    expect(group.getAttribute('aria-expanded')).toBe('true')
  })
  // 展开后第一个子项是分组里最后放进去的那个
  fireEvent.keyDown(group, { key: 'ArrowRight' })
  const child = tree().getByRole('treeitem', { name: /山林文本/ })
  await waitFor(() => expect(document.activeElement).toBe(child))
  fireEvent.keyDown(child, { key: 'ArrowLeft' })
  await waitFor(() => expect(document.activeElement).toBe(group))
  fireEvent.keyDown(group, { key: 'ArrowLeft' })
  await waitFor(() => expect(rows()).toHaveLength(2))
  void f
})

it('树行的组字 Enter 不激活画布选区，F2 改名 Enter/Escape 退出后回到原行', async () => {
  const f = setupLayers()
  const row = tree().getByRole('treeitem', { name: /海边文本/ })
  row.focus()
  for (const composing of [{ keyCode: 229 }, { isComposing: true }])
    fireEvent.keyDown(row, { key: 'Enter', ...composing })
  expect(f.selection.values()).toEqual([])
  fireEvent.keyDown(row, { key: 'F2' })
  const input = within(row).getByRole<HTMLInputElement>('textbox', { name: '元素名称' })
  await act(async () => {
    fireEvent.input(input, { target: { value: '键盘改名完成' } })
  })
  for (const composing of [{ keyCode: 229 }, { isComposing: true }])
    fireEvent.keyDown(input, { key: 'Enter', ...composing })
  expect(within(row).getByRole('textbox', { name: '元素名称' })).toBe(input)
  expect(f.doc.get(f.ids.a)?.name).toBe('海边文本')
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => {
    expect(within(row).queryByRole('textbox')).toBeNull()
    expect(document.activeElement).toBe(row)
  })
  expect(f.doc.get(f.ids.a)?.name).toBe('键盘改名完成')
  // Escape 放弃改名
  fireEvent.keyDown(row, { key: 'F2' })
  const again = within(row).getByRole('textbox', { name: '元素名称' })
  await act(async () => {
    fireEvent.input(again, { target: { value: '应丢弃的名称' } })
  })
  fireEvent.keyDown(again, { key: 'Escape' })
  await waitFor(() => expect(within(row).queryByRole('textbox')).toBeNull())
  expect(f.doc.get(f.ids.a)?.name).toBe('键盘改名完成')
})

it('改名中同 ID 新节点替换：Enter、失焦或被动重渲染都不保存旧草稿', async () => {
  const f = setupLayers()
  // 同 ID 换成新元素（远端协作或撤销重做都可能造成）。
  // 提交发生在替换后的同一同步块里：编辑器还没等 effect 收起，草稿会撞上新元素
  for (const finish of ['Enter', 'blur'] as const) {
    fireEvent.keyDown(tree().getByRole('treeitem', { name: /海边文本/ }), { key: 'F2' })
    const editing = within(
      tree().getByRole('treeitem', { name: /海边文本/ }),
    ).getByRole<HTMLInputElement>('textbox', { name: '元素名称' })
    await act(async () => {
      fireEvent.input(editing, { target: { value: '旧草稿不能写入新节点' } })
    })
    act(() => {
      f.doc.ydoc.transact(() => {
        const next = f.doc.mutable(f.ids.a)!.clone()
        f.doc.elementMaps.set(f.ids.a, next)
        next.set('x', 1800)
      }, f.doc.origin)
      // 替换后立刻确认（或失焦）：守卫必须拒绝把旧草稿写进新元素
      if (finish === 'Enter') fireEvent.keyDown(editing, { key: 'Enter' })
      else
        tree()
          .getByRole('treeitem', { name: /山林文本/ })
          .focus()
    })
    await waitFor(() => expect(tree().queryByRole('textbox', { name: '元素名称' })).toBeNull())
    expect(f.doc.get(f.ids.a)?.name).toBe('海边文本')
    // 新元素的几何确实变了，替换本身是生效的
    expect(f.doc.get(f.ids.a)?.x).toBe(1800)
  }
  expect(useCanvas.getState().notice).toContain('元素已替换，名称未保存')
  // 替换后的新元素仍可以重新改名
  const newRow = tree().getByRole('treeitem', { name: /海边文本/ })
  fireEvent.keyDown(newRow, { key: 'F2' })
  const again = within(newRow).getByRole<HTMLInputElement>('textbox', { name: '元素名称' })
  await act(async () => {
    fireEvent.input(again, { target: { value: '新节点确认后的名称' } })
  })
  fireEvent.keyDown(again, { key: 'Enter' })
  await waitFor(() => expect(f.doc.get(f.ids.a)?.name).toBe('新节点确认后的名称'))
})

it('同一节点的独立几何更新保留改名草稿，撤销名称不回退几何', async () => {
  const f = setupLayers()
  const row = tree().getByRole('treeitem', { name: /海边文本/ })
  fireEvent.keyDown(row, { key: 'F2' })
  const input = within(row).getByRole<HTMLInputElement>('textbox', { name: '元素名称' })
  await act(async () => {
    fireEvent.input(input, { target: { value: '旧草稿不能写入新节点' } })
  })
  act(() => {
    f.doc.undo.stopCapturing()
    f.doc.ydoc.transact(() => f.doc.mutable(f.ids.a)!.set('rotation', 15), f.doc.origin)
  })
  expect(within(row).getByRole('textbox', { name: '元素名称' })).toBe(input)
  expect(input.value).toBe('旧草稿不能写入新节点')
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(f.doc.get(f.ids.a)?.name).toBe('旧草稿不能写入新节点'))
  void act(() => f.doc.undo.undo())
  await waitFor(() => expect(f.doc.get(f.ids.a)).toMatchObject({ name: '海边文本', rotation: 15 }))
})

it('改名期间变为只读：提交不写入并提示，恢复后可重新编辑', async () => {
  const f = setupLayers()
  const row = tree().getByRole('treeitem', { name: /海边文本/ })
  fireEvent.keyDown(row, { key: 'F2' })
  const input = within(row).getByRole<HTMLInputElement>('textbox', { name: '元素名称' })
  await act(async () => {
    fireEvent.input(input, { target: { value: '只读期间不应保存' } })
  })
  act(() => {
    ;(f.doc as PleinDoc & { readOnly: boolean }).readOnly = true
  })
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(tree().queryByRole('textbox')).toBeNull())
  await waitFor(() => expect(useCanvas.getState().notice).toBe('画布已变为只读，名称未保存'))
  expect(f.doc.get(f.ids.a)?.name).toBe('海边文本')
  act(() => {
    ;(f.doc as PleinDoc & { readOnly: boolean }).readOnly = false
  })
  const again = tree().getByRole('treeitem', { name: /海边文本/ })
  fireEvent.keyDown(again, { key: 'F2' })
  const reopened = within(again).getByRole('textbox', { name: '元素名称' })
  await act(async () => {
    fireEvent.input(reopened, { target: { value: '恢复后保存' } })
  })
  fireEvent.keyDown(reopened, { key: 'Enter' })
  await waitFor(() => expect(f.doc.get(f.ids.a)?.name).toBe('恢复后保存'))
})

it('同伴改名后才提交：保留草稿并说明，确认后再次保存成功', async () => {
  const f = setupLayers()
  const row = tree().getByRole('treeitem', { name: /海边文本/ })
  fireEvent.keyDown(row, { key: 'F2' })
  const input = within(row).getByRole<HTMLInputElement>('textbox', { name: '元素名称' })
  await act(async () => {
    fireEvent.input(input, { target: { value: '本机尚未提交' } })
  })
  // 远端（同伴）保存了新名称：同样通过文档订阅送达
  act(() => {
    f.doc.ydoc.transact(() => f.doc.mutable(f.ids.a)!.set('name', '同伴已保存'), f.doc.origin)
  })
  fireEvent.keyDown(input, { key: 'Enter' })
  // 不静默覆盖远端名称；草稿保留并给出说明
  await waitFor(() =>
    expect(useCanvas.getState().notice).toBe('名称已在其他位置更新，已保留输入；请确认后再次保存'),
  )
  expect(within(row).getByRole<HTMLInputElement>('textbox', { name: '元素名称' }).value).toBe(
    '本机尚未提交',
  )
  expect(f.doc.get(f.ids.a)?.name).toBe('同伴已保存')
  fireEvent.keyDown(within(row).getByRole('textbox', { name: '元素名称' }), { key: 'Enter' })
  await waitFor(() => expect(f.doc.get(f.ids.a)?.name).toBe('本机尚未提交'))
})

it('同伴删除正在改名的元素：焦点移交给相邻行或搜索框，撤销后可重新改名', async () => {
  const f = setupLayers()
  tree().getByRole('button', { name: '搜索' }).click()
  const query = await tree().findByRole<HTMLInputElement>('textbox', {
    name: '搜索画布元素',
  })
  await act(async () => {
    fireEvent.input(query, { target: { value: '海边文本' } })
  })
  await waitFor(() => expect(rows()).toHaveLength(1))
  const row = rows()[0]!
  fireEvent.keyDown(row, { key: 'F2' })
  await act(async () => {
    fireEvent.input(within(row).getByRole('textbox', { name: '元素名称' }), {
      target: { value: '未保存的旧草稿' },
    })
  })
  // 空筛选时被删：焦点交回搜索框
  act(() => f.doc.undo.stopCapturing())
  act(() => deleteElements(f.doc, [f.ids.a]))
  await waitFor(() => expect(rows()).toHaveLength(0))
  await waitFor(() => expect(document.activeElement).toBe(query))
  // 撤销恢复元素后还能继续改名
  void act(() => f.doc.undo.undo())
  await waitFor(() => expect(rows()).toHaveLength(1))
  const restored = rows()[0]!
  fireEvent.keyDown(restored, { key: 'F2' })
  const input = within(restored).getByRole<HTMLInputElement>('textbox', {
    name: '元素名称',
  })
  expect(input.value).toBe('海边文本')
  await act(async () => {
    fireEvent.input(input, { target: { value: '恢复后的名称' } })
  })
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(f.doc.get(f.ids.a)?.name).toBe('恢复后的名称'))
})

it('非搜索状态删除当前行后，相邻行承接焦点', async () => {
  const f = setupLayers()
  const row = tree().getByRole('treeitem', { name: /海边文本/ })
  row.focus()
  act(() => deleteElements(f.doc, [f.ids.a]))
  await waitFor(() => expect(rows()).toHaveLength(2))
  await waitFor(() =>
    expect(document.activeElement).toBe(tree().getByRole('treeitem', { name: /山林文本/ })),
  )
})

it('资产页签：读取失败说明原因并原地重试，恢复后显示空状态', async () => {
  const { engine } = makeEngine()
  useCanvas.setState({ engine, canvasId: 'canvas-1' })
  let fail = true
  mockFetch((request) => {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/api/library') {
      if (fail) return Response.json({ message: '资产列表暂不可用' }, { status: 503 })
      return Response.json([])
    }
  })
  useLibrary.setState({ error: '资产列表暂不可用', loaded: false, loading: false })
  renderApp(<Sidebar open />)
  tree().getByRole('tab', { name: '资产' }).click()
  expect(await tree().findByRole('alert')).toBeTruthy()
  expect(tree().getByRole('alert').textContent).toContain('资产列表暂不可用')
  expect(tree().queryByText('本项目还没有资产')).toBeNull()
  fail = false
  tree().getByRole('button', { name: '重新读取' }).click()
  await waitFor(() => expect(tree().queryByRole('alert')).toBeNull())
  expect(tree().getByText('本项目还没有资产')).toBeTruthy()
  expect(tree().getByText('共 0 项资产')).toBeTruthy()
})

it('资产页签：已有条目按类别分组显示并统计', async () => {
  const { engine } = makeEngine()
  useCanvas.setState({ engine, canvasId: 'canvas-1' })
  const item = {
    id: 'lib-1',
    kind: 'character',
    name: '缓存中的角色',
    projectId: 'canvas-1',
    description: '',
    tags: {},
    voice: null,
    images: [],
    video: null,
    models: [],
    profile: null,
    favorite: false,
    usedAt: null,
    createdAt: 1,
    updatedAt: 1,
  } satisfies LibraryItem
  useLibrary.setState({
    items: [item],
    loaded: true,
    loading: false,
    error: null,
    projectId: 'canvas-1',
  })
  renderApp(<Sidebar open />)
  tree().getByRole('tab', { name: '资产' }).click()
  expect(await tree().findByRole('button', { name: /缓存中的角色/ })).toBeTruthy()
  expect(tree().getByText('共 1 项资产')).toBeTruthy()
})
