// @vitest-environment happy-dom
import type { Engine } from '@plein/canvas-core'
import { createDoc, createElement, currentResult, setParam, updateElement } from '@plein/doc'
import { defaultStageScene, recordStageKeyframe, stageSceneOf, STAGE_TYPE } from '@plein/nodes'
import { afterEach, beforeEach, expect, it, vi } from 'vite-plus/test'
import { useCanvas } from '../../stores/canvas'
import { mockFetch } from '../../testing/fetch'
import { act, fireEvent, renderApp, screen, waitFor, within } from '../../testing/render'
import { Modal } from '../../ui/Modal'
import { watchStageHistory } from './history'
import { StageEditor } from './StageEditor'
import { StagePanel } from './StagePanel'
import type { StageViewEvents } from './view'

const viewport = vi.hoisted(() => ({
  construct: vi.fn(),
  snapshot: vi.fn<() => Promise<Blob>>(),
  finish: vi.fn(),
  dispose: vi.fn(),
  events: null as StageViewEvents | null,
}))
// DOM 用例只替换 WebGL 视口边界；文档、历史、API 和弹层仍走生产实现。
vi.mock('./view', () => ({
  StageView: class {
    constructor(_host: HTMLElement, events: StageViewEvents) {
      viewport.construct()
      viewport.events = events
    }
    setScene() {}
    setReadOnly() {}
    setSelected() {}
    setMode() {}
    setTool() {}
    finishCamera = viewport.finish
    snapshot = viewport.snapshot
    dispose = viewport.dispose
  },
}))

const cleanups: (() => void)[] = []
beforeEach(() => {
  viewport.construct.mockReset()
  viewport.snapshot.mockReset().mockResolvedValue(new Blob(['png'], { type: 'image/png' }))
  viewport.finish.mockReset()
  viewport.dispose.mockReset()
  viewport.events = null
})
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function setup({ editor = false, scene = defaultStageScene() } = {}) {
  const doc = createDoc()
  const off = watchStageHistory(doc)
  cleanups.push(() => {
    off()
    doc.destroy()
    doc.ydoc.destroy()
  })
  const id = createElement(doc, {
    kind: 'node',
    nodeType: STAGE_TYPE,
    x: 0,
    y: 0,
    w: 480,
    h: 270,
    params: { scene },
  })
  doc.flush()
  const engine = { doc } as Engine
  useCanvas.setState({ engine, stage: id })
  const onClose = vi.fn()
  const rendered = renderApp(
    <>{editor ? <StageEditor /> : <StagePanel engine={engine} id={id} onClose={onClose} />}</>,
  )
  const read = () => stageSceneOf(doc.get(id)?.params)
  const button = (name: string) => screen.getByRole<HTMLButtonElement>('button', { name })
  const change = (fn: () => void) =>
    act(() => {
      fn()
      doc.flush()
    })
  return { ...rendered, doc, engine, id, read, button, change, onClose }
}
function uploads() {
  let count = 0
  mockFetch((request) => {
    if (request.method === 'POST' && new URL(request.url).pathname === '/api/assets') {
      count++
      return Response.json({
        id: `shot-${count}`,
        kind: 'image',
        mime: 'image/png',
        width: 1600,
        height: 900,
      })
    }
  })
  return () => count
}

it('坐标负数草稿、空白、取消和越界提交不会误移动对象', async () => {
  const { user, read, onClose } = setup()
  const input = screen.getByRole<HTMLInputElement>('spinbutton', { name: '左右' })
  await user.clear(input)
  fireEvent.change(input, { target: { value: '-1.25' } })
  await user.click(input)
  expect(read().figures[0]!.x).toBe(0)
  await user.keyboard('{Enter}')
  expect(read().figures[0]!.x).toBe(-1.25)
  await user.clear(input)
  await user.tab()
  expect(input.value).toBe('-1.25')
  await user.type(input, '9')
  await user.keyboard('{Escape}')
  expect(input.value).toBe('-1.25')
  expect(onClose).not.toHaveBeenCalled()
  await user.clear(input)
  await user.type(input, '100{Enter}')
  expect(read().figures[0]!.x).toBe(50)
})

it('只读切换丢弃坐标草稿，旧按钮和视口回调不能写入，恢复后可继续', async () => {
  const { user, read, doc, id, change, button } = setup()
  const input = screen.getByRole<HTMLInputElement>('spinbutton', { name: '左右' })
  await user.clear(input)
  await user.type(input, '7.25')
  const before = read()
  const add = button('添加人物')
  change(() => {
    doc.readOnly = true
    doc.mutable(id)!.set('name', '只读')
  })
  expect(screen.getByRole<HTMLInputElement>('spinbutton', { name: '左右' }).value).toBe('0')
  expect(add.disabled).toBe(true)
  expect(button('截图').disabled).toBe(true)
  await user.click(button('自由视角'))
  act(() => {
    add.click()
    viewport.events!.onMove('fig-1', { x: 9, z: 9, facing: 90 })
  })
  expect(read()).toEqual(before)
  change(() => {
    doc.readOnly = false
    updateElement(doc, id, { name: '恢复' })
  })
  await user.click(button('添加人物'))
  expect(read().figures).toHaveLength(2)
  expect(read().figures[0]!.x).toBe(0)
})

it('人物上限禁用添加，删除后重用空位而不重复名字和站位', async () => {
  const { user, read, button } = setup()
  for (let i = 1; i < 12; i++) await user.click(button('添加人物'))
  expect(button('添加人物').disabled).toBe(true)
  await user.click(screen.getByRole('button', { name: /人物 6/ }))
  await user.click(button('删除'))
  expect(button('添加人物').disabled).toBe(false)
  await user.click(button('添加人物'))
  const figures = read().figures
  expect(figures).toHaveLength(12)
  expect(new Set(figures.map((f) => f.name)).size).toBe(12)
  expect(new Set(figures.map((f) => `${f.x},${f.z}`)).size).toBe(12)
})

it('菜单内删除和撤销不穿透，取消后恢复焦点并可键盘选场景件', async () => {
  const { user, read, button, onClose } = setup()
  await user.click(button('坐'))
  const before = read()
  const trigger = button('添加场景件')
  await user.click(trigger)
  const menu = await screen.findByRole('menu', { name: '添加场景件' })
  fireEvent.keyDown(menu, { key: 'Delete' })
  fireEvent.keyDown(trigger, { key: 'z', ctrlKey: true })
  expect(read()).toEqual(before)
  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  expect(onClose).not.toHaveBeenCalled()
  expect(document.activeElement).toBe(trigger)
  fireEvent.keyDown(trigger, { key: 'z', ctrlKey: true })
  expect(read().figures[0]!.pose).toBe('stand')
  await user.keyboard('{ArrowDown}')
  const table = await screen.findByRole('menuitem', { name: '桌子' })
  act(() => table.focus())
  await user.keyboard('{Enter}')
  expect(read().blocks[0]!.kind).toBe('table')
  expect(onClose).not.toHaveBeenCalled()
})

it('连续改名归并、离散操作可撤销，输入框快捷键不穿透节点创建', async () => {
  const { user, read, doc, id, button } = setup()
  expect(button('撤销构图操作').disabled).toBe(true)
  await user.click(button('坐'))
  const name = screen.getByRole('textbox', { name: '名字' })
  await user.clear(name)
  await user.type(name, 'AB', { skipClick: true })
  await user.click(button('指向'))
  await user.click(button('撤销构图操作'))
  expect(read().figures[0]).toMatchObject({ name: 'AB', pose: 'sit' })
  await user.click(button('撤销构图操作'))
  expect(read().figures[0]).toMatchObject({ name: '人物 1', pose: 'sit' })
  fireEvent.keyDown(name, { key: 'z', ctrlKey: true })
  expect(read().figures[0]!.pose).toBe('sit')
  await user.click(button('撤销构图操作'))
  expect(button('撤销构图操作').disabled).toBe(true)
  expect(doc.get(id)).toBeDefined()
})

it('同次滑杆停顿归并，两次手势分别撤销，取消手势恢复键盘归并窗口', async () => {
  const { user, read, doc, button } = setup()
  await user.click(screen.getByRole('button', { name: /35mm/ }))
  const slider = screen.getByRole('slider', { name: '焦距' })
  const gesture = async (end: 'pointerUp' | 'pointerCancel', values: number[]) => {
    fireEvent.pointerDown(slider, { button: 0, pointerId: 1 })
    for (const [index, value] of values.entries()) {
      if (index > 0) doc.undo.lastChange = 1
      fireEvent.change(slider, { target: { value } })
    }
    await act(async () => {
      fireEvent[end](window, { pointerId: 1 })
      await Promise.resolve()
    })
  }
  await gesture('pointerUp', [50, 60])
  await gesture('pointerCancel', [85, 100])
  await user.click(button('撤销构图操作'))
  expect(read().camera.focal).toBe(60)
  await user.click(button('撤销构图操作'))
  expect(read().camera.focal).toBe(35)
  await user.click(button('重做构图操作'))
  expect(read().camera.focal).toBe(60)
  expect(doc.undo.captureTimeout).not.toBe(Infinity)
})

it('WebGL 初始化失败显示重试入口，重试读取最新场景且可截图', async () => {
  viewport.construct.mockImplementationOnce(() => {
    throw new Error('WebGL unavailable')
  })
  const { user, button } = setup()
  const sent = uploads()
  expect(screen.getByRole('alert').textContent).toContain('3D 预览未能加载')
  expect(button('截图').disabled).toBe(true)
  await user.click(button('重试预览'))
  expect(screen.queryByRole('alert')).toBeNull()
  expect(viewport.construct).toHaveBeenCalledTimes(2)
  await user.click(button('截图'))
  await screen.findByRole('img', { name: /截图/ })
  expect(sent()).toBe(1)
})

it('同一帧重复截图只编码和上传一次，等待中编辑保留冻结来源', async () => {
  let finish!: (value: Blob) => void
  viewport.snapshot.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const { user, doc, id, read, button } = setup()
  const sent = uploads()
  const before = read()
  act(() => {
    button('截图').click()
    button('截图').click()
  })
  expect(viewport.snapshot).toHaveBeenCalledTimes(1)
  expect(button('截图').disabled).toBe(true)
  await user.click(button('坐'))
  await user.click(button('自由视角'))
  await act(async () => finish(new Blob(['png'])))
  await screen.findByRole('img', { name: /截图/ })
  expect(sent()).toBe(1)
  expect((doc.get(id)!.params!.snapshots as { scene: unknown }[])[0]!.scene).toEqual(before)
  expect(read().figures[0]!.pose).toBe('sit')
  expect(button('截图').disabled).toBe(false)
})

it.each(['编码', '上传'] as const)('%s失败给出反馈且保留编辑，可再次截图', async (phase) => {
  const { user, read, button } = setup()
  let calls = 0
  mockFetch((request) => {
    if (request.method === 'POST' && new URL(request.url).pathname === '/api/assets') {
      calls++
      return phase === '上传' && calls === 1
        ? Response.json({ error: '暂时无法上传' }, { status: 503 })
        : Response.json({ id: 'retry-shot' })
    }
  })
  if (phase === '编码') viewport.snapshot.mockRejectedValueOnce(new Error('PNG 编码失败'))
  await user.click(button('坐'))
  await user.click(button('截图'))
  await waitFor(() => expect(useCanvas.getState().notice).toContain('截图没有成功'))
  expect(screen.queryByRole('img')).toBeNull()
  expect(read().figures[0]!.pose).toBe('sit')
  expect(button('截图').disabled).toBe(false)
  await user.click(button('截图'))
  await screen.findByRole('img', { name: /截图/ })
})

it('动态关键帧在当前时刻插值，播放与拖动不写文档，恢复截图保留轨迹', async () => {
  const { user, read, doc, id, button } = setup()
  uploads()
  await user.click(button('启用动态预演'))
  const time = screen.getByRole('slider', { name: '预演时间' })
  fireEvent.change(time, { target: { value: 5 } })
  const x = screen.getByRole('spinbutton', { name: '左右' })
  await user.clear(x)
  await user.type(x, '2{Enter}')
  await user.click(button('坐'))
  const before = read()
  fireEvent.change(time, { target: { value: 2.5 } })
  expect((x as HTMLInputElement).value).toBe('1')
  expect(read()).toEqual(before)
  await user.click(button('指向'))
  expect(read().motion!.keyframes.map((frame) => frame.time)).toEqual([0, 2.5, 5])
  await user.click(button('撤销构图操作'))
  expect(read().motion!.keyframes).toHaveLength(2)
  await user.click(button('重做构图操作'))
  const captured = read()
  await user.click(button('截图'))
  await screen.findByRole('img', { name: /截图/ })
  const record = (doc.get(id)!.params!.snapshots as { time: number; scene: unknown }[])[0]!
  expect(record).toMatchObject({ time: 2.5, scene: captured })
  fireEvent.change(time, { target: { value: 5 } })
  await user.click(button('行走'))
  await user.click(button('恢复'))
  expect(read().motion).toEqual(captured.motion)
  expect((time as HTMLInputElement).value).toBe('2.5')
  await user.click(button('播放预演'))
  expect(button('截图').disabled).toBe(true)
  await user.click(button('暂停预演'))
  expect(read().motion).toEqual(captured.motion)
})

it('锁定动态构图允许拖动播放头，不允许记录和截图', async () => {
  const scene = recordStageKeyframe(defaultStageScene(), 0)
  const { user, doc, id, change, read, button } = setup({ scene })
  change(() => updateElement(doc, id, { locked: true }))
  const before = read()
  fireEvent.change(screen.getByRole('slider', { name: '预演时间' }), { target: { value: 2 } })
  await user.click(button('播放预演'))
  expect(button('记录当前关键帧').disabled).toBe(true)
  expect(button('截图').disabled).toBe(true)
  await user.click(button('暂停预演'))
  expect(read()).toEqual(before)
})

it.each(['删除', '类型变更', '同 ID 替换'] as const)(
  '目标%s时旧草稿和同帧按钮不能写入替代实例',
  async (kind) => {
    const { user, doc, id, change } = setup({ editor: true })
    await screen.findByRole('dialog', { name: '3D 构图' })
    const x = screen.getByRole('spinbutton', { name: '左右' })
    await user.clear(x)
    await user.type(x, '7.25')
    const add = screen.getByRole<HTMLButtonElement>('button', { name: '添加人物' })
    change(() => {
      doc.ydoc.transact(() => {
        if (kind === '删除') doc.elementMaps.delete(id)
        else if (kind === '类型变更') doc.mutable(id)!.set('nodeType', 'plein/text')
        else doc.elementMaps.set(id, doc.mutable(id)!.clone())
      }, doc.origin)
      doc.flush()
      add.click()
      fireEvent.blur(x)
    })
    if (kind === '同 ID 替换') {
      await waitFor(() =>
        expect(screen.getByRole<HTMLInputElement>('spinbutton', { name: '左右' }).value).toBe('0'),
      )
      expect(stageSceneOf(doc.get(id)?.params).figures).toHaveLength(1)
      await user.click(screen.getByRole('button', { name: '添加人物' }))
      expect(stageSceneOf(doc.get(id)?.params).figures).toHaveLength(2)
    } else {
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      expect(useCanvas.getState().stage).toBeNull()
      if (kind === '类型变更') expect(stageSceneOf(doc.get(id)?.params).figures).toHaveLength(1)
      change(() => doc.undo.undo())
      expect(doc.get(id)?.nodeType).toBe(STAGE_TYPE)
      expect(screen.queryByRole('dialog')).toBeNull()
      act(() => useCanvas.getState().openStage(id))
      await screen.findByRole('dialog', { name: '3D 构图' })
      expect(screen.getByRole<HTMLInputElement>('spinbutton', { name: '左右' }).value).toBe('0')
      await user.click(screen.getByRole('button', { name: '添加人物' }))
      expect(stageSceneOf(doc.get(id)?.params).figures).toHaveLength(2)
    }
  },
)

it('候选采用不改变编辑场景，来源缺失只能采用，孤立来源只能恢复', async () => {
  const { user, doc, id, read, button, change } = setup()
  uploads()
  await user.click(button('截图'))
  await screen.findByRole('img', { name: /截图/ })
  await user.click(button('坐'))
  await user.click(button('截图'))
  await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(2))
  const adopted = currentResult(doc.get(id)!)!.id
  const old = (doc.get(id)!.params!.snapshots as { resultId: string }[]).at(-1)!
  change(() => {
    setParam(doc, id, 'snapshots', [old, { resultId: 'broken', scene: null }, old])
    doc.mutable(id)!.set(
      'results',
      doc.get(id)!.results!.filter((result) => result.id !== old.resultId),
    )
  })
  const missing = screen.getByRole('img', { name: /来源缺失/ }).closest('figure')!
  const orphan = screen.getByRole('img', { name: '第 0 版截图' }).closest('figure')!
  expect(within(missing).getByRole<HTMLButtonElement>('button', { name: '恢复' }).disabled).toBe(
    true,
  )
  expect(within(orphan).getAllByRole<HTMLButtonElement>('button')[0]!.disabled).toBe(true)
  await user.click(within(orphan).getByRole('button', { name: '恢复' }))
  expect(read().figures[0]!.pose).toBe('stand')
  expect(currentResult(doc.get(id)!)!.id).toBe(adopted)
  expect(doc.get(id)!.results).toHaveLength(1)
})

it('上层面板出现会收起构图菜单，Escape 只交给上层且不改变场景', async () => {
  const { user, read, engine, id, rerender, onClose, button } = setup()
  const before = read()
  await user.click(button('添加场景件'))
  await screen.findByRole('menu', { name: '添加场景件' })
  const closeTop = vi.fn()
  rerender(
    <>
      <StagePanel engine={engine} id={id} onClose={onClose} />
      <Modal label="上层面板" top onClose={closeTop}>
        <button type="button">上层操作</button>
      </Modal>
    </>,
  )
  await user.click(await screen.findByRole('button', { name: '上层操作' }))
  await waitFor(() => expect(screen.queryByRole('menu', { hidden: true })).toBeNull())
  await user.keyboard('{Escape}')
  expect(closeTop).toHaveBeenCalledTimes(1)
  expect(onClose).not.toHaveBeenCalled()
  expect(read()).toEqual(before)
})

it('上传等待中关闭重开，旧结果保留为候选而不覆盖新构图和采用', async () => {
  const { user, doc, id, read } = setup({ editor: true })
  let release!: () => void
  let sent = 0
  mockFetch((request) => {
    if (request.method === 'POST' && new URL(request.url).pathname === '/api/assets') {
      sent++
      if (sent === 1)
        return new Promise<Response>((resolve) => {
          release = () => resolve(Response.json({ id: 'old-shot' }))
        })
      return Response.json({ id: 'new-shot' })
    }
  })
  await user.click(await screen.findByRole('button', { name: '截图' }))
  await waitFor(() => expect(sent).toBe(1))
  await user.click(screen.getByRole('button', { name: '关闭' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  act(() => useCanvas.getState().openStage(id))
  await user.click(await screen.findByRole('button', { name: '坐' }))
  await user.click(screen.getByRole('button', { name: '截图' }))
  await screen.findByRole('img', { name: /截图/ })
  const adopted = currentResult(doc.get(id)!)!.id
  await act(async () => release())
  await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(2))
  expect(currentResult(doc.get(id)!)!.id).toBe(adopted)
  expect(read().figures[0]!.pose).toBe('sit')
})

it('编码中切换画布后旧任务不上传也不提示新画布', async () => {
  let finish!: (value: Blob) => void
  viewport.snapshot.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const { user, doc, button } = setup()
  const sent = uploads()
  await user.click(button('截图'))
  act(() => {
    useCanvas.setState({ engine: null, stage: null })
    doc.ydoc.destroy()
  })
  await act(async () => finish(new Blob(['png'])))
  expect(sent()).toBe(0)
  expect(useCanvas.getState().notice).toBeNull()
})

it('点击旧截图采用不覆盖当前编辑场景，恢复来源与采用独立', async () => {
  const { user, doc, id, read, button } = setup()
  uploads()
  await user.click(button('截图'))
  await screen.findByRole('img', { name: /截图/ })
  const original = currentResult(doc.get(id)!)!.id
  await user.click(button('坐'))
  await user.click(button('截图'))
  await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(2))
  expect(currentResult(doc.get(id)!)!.id).not.toBe(original)
  const editing = read()
  const oldest = screen.getByRole('img', { name: '第 0 版截图' }).closest('figure')!
  await user.click(within(oldest).getAllByRole('button')[0]!)
  expect(currentResult(doc.get(id)!)!.id).toBe(original)
  expect(read()).toEqual(editing)
  expect(within(oldest).getAllByRole('button')[0]!.getAttribute('aria-pressed')).toBe('true')
  await user.click(within(oldest).getByRole('button', { name: '恢复' }))
  expect(read().figures[0]!.pose).toBe('stand')
  expect(currentResult(doc.get(id)!)!.id).toBe(original)
})

it('关闭后同帧切换构图重置选择和视角，后续编辑只写新节点', async () => {
  const { user, doc, id, change } = setup({ editor: true })
  await user.click(await screen.findByRole('button', { name: '添加人物' }))
  await user.click(screen.getByRole('button', { name: '坐' }))
  await user.click(screen.getByRole('button', { name: '自由视角' }))
  const before = stageSceneOf(doc.get(id)?.params)
  let next = ''
  change(() => {
    next = createElement(doc, {
      kind: 'node',
      nodeType: STAGE_TYPE,
      x: 600,
      y: 0,
      w: 480,
      h: 270,
      params: { scene: defaultStageScene() },
    })
    useCanvas.getState().openStage(null)
    useCanvas.getState().openStage(next)
  })
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: '名字' }).value).toBe('人物 1')
  expect(screen.getByRole('button', { name: '机位视角' }).getAttribute('aria-pressed')).toBe('true')
  await user.click(screen.getByRole('button', { name: '指向' }))
  expect(stageSceneOf(doc.get(next)?.params).figures[0]!.pose).toBe('point')
  expect(stageSceneOf(doc.get(id)?.params)).toEqual(before)
})
