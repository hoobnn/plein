// @vitest-environment happy-dom
import { deleteElements, groupElements, setParams, moveElements, adoptResult } from '@plein/doc'
import { expect, it } from 'vite-plus/test'
import { useCanvas } from '../stores/canvas'
import { useStale } from '../features/runs/stale'
import { mockFetch } from '../testing/fetch'
import { act, fireEvent, renderApp, screen, waitFor, within } from '../testing/render'
import { Board } from './Board'
import { Viewer } from './Viewer'
import { shellFixture, mediaAsset } from './testing'

async function setup() {
  const f = shellFixture()
  const text = f.add('text', '正文', { params: { text: '第一行\n第二行' } })
  const empty = f.add('text', '空正文', { y: 400, params: { text: '' } })
  const image = f.add('image', '待生成画面')
  const { user } = renderApp(
    <>
      <Board />
      <Viewer />
    </>,
  )
  const column = (name: string) => within(screen.getByRole('region', { name }))
  const filter = async (name: string, label: string) => {
    await user.click(column(name).getByRole('button', { name: '筛选' }))
    await user.click(screen.getByRole('menuitemradio', { name: label }))
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  }
  return { ...f, text, empty, image, user, column, filter }
}

it('分栏独立筛选在展开、收起、定位和返回后保留，换引擎清空', async () => {
  const f = await setup()
  await f.filter('文本', '已生成')
  await f.filter('图片', '待生成')
  await f.user.click(f.column('图片').getByRole('button', { name: '展开此栏' }))
  expect(screen.queryByRole('region', { name: '文本' })).toBeNull()
  await f.user.click(f.column('图片').getByRole('button', { name: '还原分栏' }))
  expect(f.column('文本').getByRole('button', { name: '筛选' }).textContent).toBe('已生成')
  expect(f.column('文本').queryByRole('button', { name: '空正文' })).toBeNull()
  await f.user.click(f.column('文本').getByRole('button', { name: '正文' }))
  expect(f.selection.values()).toEqual([f.text])
  await waitFor(() => expect(f.engine.zoomToFit).toHaveBeenCalledWith([f.text]))
  act(() => useCanvas.setState({ mode: 'board' }))
  expect(f.column('图片').getByRole('button', { name: '筛选' }).textContent).toBe('待生成')
  act(() => {
    const other = shellFixture()
    other.add('text', '新画布正文')
    other.doc.flush()
  })
  expect(f.column('文本').getByRole('button', { name: '筛选' }).textContent).toBe('全部')
})
it.each([false, true])(
  '删除筛选栏（全部 %s）后展开自动退出，撤销不恢复旧展开且保留筛选',
  async (all) => {
    const f = await setup()
    await f.filter('文本', '已生成')
    await f.user.click(f.column('文本').getByRole('button', { name: '展开此栏' }))
    act(() => {
      f.doc.undo.stopCapturing()
      deleteElements(f.doc, all ? [f.text, f.empty, f.image] : [f.text, f.empty])
      f.doc.flush()
    })
    if (all) expect(screen.getByText('画布上还没有内容')).toBeTruthy()
    else expect(screen.getByRole('region', { name: '图片' })).toBeTruthy()
    act(() => {
      f.doc.undo.undo()
      f.doc.flush()
    })
    expect(screen.queryByRole('button', { name: '还原分栏' })).toBeNull()
    expect(f.column('文本').getByRole('button', { name: '筛选' }).textContent).toBe('已生成')
  },
)
it('正文清空后空筛选跨展开保留，撤销恢复正文且不回退到旧生成结果', async () => {
  const f = await setup()
  f.results(f.text, 'text')
  await f.filter('文本', '已生成')
  act(() => {
    f.doc.undo.stopCapturing()
    setParams(f.doc, f.text, { text: '   ' })
    f.doc.flush()
  })
  expect(f.column('文本').getByText('没有符合筛选的内容')).toBeTruthy()
  await f.user.click(f.column('图片').getByRole('button', { name: '展开此栏' }))
  await f.user.click(f.column('图片').getByRole('button', { name: '还原分栏' }))
  expect(f.column('文本').getByText('没有符合筛选的内容')).toBeTruthy()
  act(() => {
    f.doc.undo.undo()
    f.doc.flush()
  })
  expect(f.column('文本').getByText('第一行 第二行')).toBeTruthy()
})
it('同帧删除后旧定位按钮不切模式、不选择失效对象', async () => {
  const f = await setup()
  const button = f.column('文本').getByRole('button', { name: '正文' })
  act(() => {
    deleteElements(f.doc, [f.text])
    button.click()
    f.doc.flush()
  })
  expect(useCanvas.getState().mode).toBe('board')
  expect(f.selection.values()).toEqual([])
  expect(useCanvas.getState().notice).toBe('元素已被删除，无法定位')
})
it('使用世界坐标按类别阅读排序，嵌套分组移动和撤销后立即重排', async () => {
  const f = shellFixture()
  const ids = [
    [0, 120],
    [100, 60],
    [200, 0],
    [0, 600],
  ].map(([x, y], i) => f.add('text', 'ABCD'[i]!, { x, y }))
  const inner = groupElements(f.doc, ids.slice(0, 3))!
  groupElements(f.doc, [inner, ids[3]!])
  f.add('image', '不相关类别', { x: 900, y: -30 })
  renderApp(<Board />)
  const names = () =>
    within(screen.getByRole('region', { name: '文本' }))
      .getAllByRole('listitem')
      .map((el) => el.textContent)
  expect(names()).toEqual(['B', 'C', 'A', 'D'])
  act(() => {
    f.doc.undo.stopCapturing()
    moveElements(f.doc, [inner], 0, 1000)
    f.doc.flush()
  })
  expect(names()).toEqual(['D', 'B', 'C', 'A'])
  act(() => {
    f.doc.undo.undo()
    f.doc.flush()
  })
  expect(names()).toEqual(['B', 'C', 'A', 'D'])
})
it.each(['image', 'video', 'audio'] as const)(
  '%s 缩略图重试只重建失败媒体并恢复焦点，不采用或开预览',
  async (kind) => {
    const f = shellFixture()
    const id = f.add(kind === 'audio' ? 'speech' : kind, '素材')
    const results = f.results(id, kind)
    mockFetch((request) =>
      request.url.endsWith('/meta')
        ? Response.json(mediaAsset(request.url.split('/').at(-2)!, kind))
        : undefined,
    )
    const { user } = renderApp(
      <>
        <Board />
        <Viewer />
      </>,
    )
    const preview = screen.getByRole('button', { name: '查看素材' })
    const image = preview.querySelector('img')!
    fireEvent.error(image)
    const retry = screen.getByRole('button', { name: '重新加载「素材」缩略图' })
    await user.click(retry)
    expect(preview.querySelector('img')).not.toBe(image)
    expect(document.activeElement).toBe(preview)
    expect(useCanvas.getState().viewer).toBeNull()
    expect(f.doc.get(id)!.adopted).toBe(results[0]!.id)
    await act(async () => {
      adoptResult(f.doc, id, results[1]!.id)
      fireEvent.error(image)
      f.doc.flush()
    })
    expect(preview.querySelector('img')!.getAttribute('src')).toContain(`${id}-asset-1`)
    expect(screen.queryByRole('button', { name: '重新加载「素材」缩略图' })).toBeNull()
  },
)
it('待采用卡片只浏览主输出；明确采用才更新故事板和筛选', async () => {
  const f = shellFixture()
  const id = f.add('image', '候选')
  const results = f.results(id, 'image', 2)
  f.doc
    .mutable(id)!
    .set('results', [
      { ...results[0]!, id: 'metadata', port: 'metadata', value: { type: 'text', text: '说明' } },
      ...results,
    ])
  f.doc.mutable(id)!.set('adopted', null)
  mockFetch((request) =>
    request.url.endsWith('/meta')
      ? Response.json(mediaAsset(request.url.split('/').at(-2)!))
      : undefined,
  )
  const { user } = renderApp(
    <>
      <Board />
      <Viewer />
    </>,
  )
  const card = screen.getByRole('button', { name: '查看候选的候选' })
  expect(card.textContent).toContain('待采用')
  expect(screen.getByLabelText('2 个候选')).toBeTruthy()
  await user.click(card)
  await user.click(screen.getByRole('button', { name: '预览下一个候选' }))
  expect(f.doc.get(id)!.adopted).toBeNull()
  await user.click(screen.getByRole('button', { name: '采用此候选' }))
  act(() => f.doc.flush())
  await user.click(screen.getByRole('button', { name: '关闭' }))
  expect(
    screen.getByRole('button', { name: '查看候选' }).querySelector('img')!.getAttribute('src'),
  ).toContain(`${id}-asset-1`)
})
it('过期状态订阅独立于文档变化，运行状态优先且结束恢复提示', async () => {
  const f = await setup()
  act(() => useStale.getState().set({ stale: [f.text], upstream: [f.image], kept: [] }))
  expect(f.column('文本').getByText('需要重跑').getAttribute('title')).toContain('参数或输入改过')
  expect(f.column('图片').getByText('上游已改')).toBeTruthy()
  act(() => useStale.getState().set({ stale: [], upstream: [f.image], kept: [f.text] }))
  expect(f.column('文本').getByText('已保留')).toBeTruthy()
  for (const [status, label] of [
    ['queued', '排队中'],
    ['running', '生成中'],
    ['failed', '失败'],
  ]) {
    act(() => {
      f.doc.mutable(f.text)!.set('run', { id: 'run', status })
      f.doc.flush()
    })
    expect(f.column('文本').getByText(label!)).toBeTruthy()
    expect(f.column('文本').queryByText('已保留')).toBeNull()
  }
  act(() => {
    f.doc.mutable(f.text)!.set('run', { id: 'run', status: 'succeeded' })
    f.doc.flush()
  })
  expect(f.column('文本').getByText('已保留')).toBeTruthy()
})
