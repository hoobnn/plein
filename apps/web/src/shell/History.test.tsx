// @vitest-environment happy-dom
import { deleteElements } from '@plein/doc'
import { expect, it, vi } from 'vite-plus/test'
import * as importProgress from '../canvas/importProgress'
import * as importView from '../canvas/importView'
import { useCanvas } from '../stores/canvas'
import { useSession } from '../stores/session'
import { mockFetch } from '../testing/fetch'
import { act, fireEvent, renderApp, screen, waitFor, within } from '../testing/render'
import { History } from './History'
import { Viewer } from './Viewer'
import { shellFixture, mediaAsset } from './testing'

function setup() {
  const f = shellFixture()
  const ids = ['甲', '乙', '丙'].map((name, i) =>
    f.add(i === 2 ? 'speech' : 'image', name, { x: i * 500 }),
  )
  const results = ids.map((id, i) => f.results(id, i === 2 ? 'audio' : 'image', 1)[0]!)
  results.forEach((result, i) => f.doc.mutable(ids[i]!)!.set('results', [{ ...result, at: i + 1 }]))
  useCanvas.setState({ history: true })
  mockFetch((request) => {
    if (request.url.endsWith('/meta')) {
      const id = request.url.split('/').at(-2)!
      return Response.json(mediaAsset(id, id.startsWith(ids[2]!) ? 'audio' : 'image'))
    }
  })
  const rendered = renderApp(
    <>
      <History />
      <Viewer />
    </>,
  )
  const check = (name: string) =>
    screen.getByRole<HTMLInputElement>('checkbox', { name: `选择「${name}」` })
  const selectAll = async () => {
    await rendered.user.click(check('甲'))
    await rendered.user.click(screen.getByRole('button', { name: '全选' }))
  }
  const imported = () =>
    [...f.doc.elements()].filter((el) => el.kind === 'image' || el.kind === 'audio')
  return { ...f, ...rendered, ids, results, check, selectAll, imported }
}

it.each(['filter', 'empty-filter', 'delete-undo', 'result', 'sort', 'rapid'] as const)(
  '历史选择 %s 保留可见身份，不复活旧选择且放入正确原素材',
  async (mode) => {
    const f = setup()
    await f.selectAll()
    if (mode === 'filter' || mode === 'empty-filter') {
      await f.user.click(
        screen.getByRole('button', { name: mode === 'filter' ? /^图片/ : /^视频/ }),
      )
      if (mode === 'empty-filter') expect(screen.getByText('没有符合筛选条件的结果')).toBeTruthy()
      await f.user.click(screen.getByRole('button', { name: /^全部/ }))
      expect(f.check('丙').checked).toBe(false)
      expect(f.check('甲').checked).toBe(mode === 'filter')
    } else if (mode === 'delete-undo' || mode === 'result') {
      act(() => {
        f.doc.undo.stopCapturing()
        if (mode === 'delete-undo') deleteElements(f.doc, [f.ids[0]!])
        else f.doc.mutable(f.ids[0]!)!.set('results', [])
        f.doc.flush()
      })
      expect(screen.queryByRole('checkbox', { name: '选择「甲」' })).toBeNull()
      act(() => {
        if (mode === 'delete-undo') f.doc.undo.undo()
        else f.doc.mutable(f.ids[0]!)!.set('results', [f.results[0]])
        f.doc.flush()
      })
      expect(f.check('甲').checked).toBe(false)
      expect(f.check('乙').checked).toBe(true)
    } else if (mode === 'sort') {
      await f.user.click(screen.getByRole('button', { name: '最新在前' }))
      expect(screen.getAllByRole('checkbox').map((el) => el.getAttribute('aria-label'))).toEqual([
        '选择「甲」',
        '选择「乙」',
        '选择「丙」',
      ])
      expect(screen.getAllByRole('checkbox', { checked: true })).toHaveLength(3)
    } else {
      await f.user.click(screen.getByRole('button', { name: '取消选择' }))
      act(() => {
        f.check('甲').click()
        f.check('乙').click()
        f.check('丙').click()
      })
      expect(screen.getAllByRole('checkbox', { checked: true })).toHaveLength(3)
    }
    if (mode === 'empty-filter')
      expect(screen.queryByRole('button', { name: '放到画布上' })).toBeNull()
    else {
      const chosen =
        mode === 'filter'
          ? f.ids.slice(0, 2)
          : ['rapid', 'sort'].includes(mode)
            ? f.ids
            : f.ids.slice(1)
      await f.user.click(screen.getByRole('button', { name: '放到画布上' }))
      await waitFor(() =>
        expect(
          f
            .imported()
            .map((el) => el.assetId!)
            .sort((a, b) => a.localeCompare(b)),
        ).toEqual(chosen.map((id) => `${id}-asset-0`).sort((a, b) => a.localeCompare(b))),
      )
      f.doc.undo.undo()
      expect(f.imported()).toHaveLength(0)
    }
  },
)
it.each(['image', 'video', 'audio', 'resize'] as const)(
  '历史缩略图 %s 重试不改变选择和采用，尺寸改变丢弃旧失败',
  async (mode) => {
    const f = shellFixture()
    const kind = mode === 'resize' ? 'image' : mode
    const id = f.add(kind === 'audio' ? 'speech' : kind, '缩略图')
    const result = f.results(id, kind, 1)[0]!
    useCanvas.setState({ history: true })
    const { user } = renderApp(<History />)
    const checkbox = screen.getByRole<HTMLInputElement>('checkbox')
    const old = document.querySelector('img')!
    fireEvent.error(old)
    await user.click(checkbox)
    if (mode === 'resize')
      fireEvent.change(screen.getByRole('slider'), { target: { value: '280' } })
    else await user.click(screen.getByRole('button', { name: '重新加载「缩略图」缩略图' }))
    expect(checkbox.checked).toBe(true)
    expect(document.querySelector('img')).not.toBe(old)
    expect(screen.queryByRole('button', { name: '重新加载「缩略图」缩略图' })).toBeNull()
    if (mode !== 'resize')
      expect(document.activeElement).toBe(screen.getByRole('button', { name: '选择「缩略图」' }))
    expect(f.doc.get(id)!.adopted).toBe(result.id)
    expect(useCanvas.getState().viewer).toBeNull()
  },
)
it.each(['escape', 'edit', 'reopen'] as const)('历史读取期间 %s 完成后不抢上下文', async (mode) => {
  const f = setup()
  let release!: (response: Response) => void
  mockFetch((request) =>
    request.url.endsWith('/meta')
      ? new Promise<Response>((resolve) => {
          release = resolve
        })
      : undefined,
  )
  await f.user.click(f.check('甲'))
  await f.user.click(screen.getByRole('button', { name: '放到画布上' }))
  await f.user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  if (mode === 'edit') act(() => f.selection.set([f.ids[1]!]))
  if (mode === 'reopen') act(() => useCanvas.getState().toggleHistory(true))
  await act(async () => release(Response.json(mediaAsset(`${f.ids[0]}-asset-0`))))
  await waitFor(() => expect(f.imported()).toHaveLength(1))
  expect(f.selection.values()).toEqual(mode === 'edit' ? [f.ids[1]] : [])
  if (mode === 'reopen') {
    expect(screen.getByRole('dialog', { name: '生成历史' })).toBeTruthy()
    expect(f.check('甲').checked).toBe(false)
  } else {
    expect(screen.queryByRole('dialog')).toBeNull()
    act(() => useCanvas.getState().noticeAction?.run())
    expect(f.selection.values()).toEqual([f.imported()[0]!.id])
  }
})
it('同帧重复放入只写入一批素材', async () => {
  const f = setup()
  let release!: (response: Response) => void
  mockFetch((request) =>
    request.url.endsWith('/meta')
      ? new Promise<Response>((resolve) => {
          release = resolve
        })
      : undefined,
  )
  await f.user.click(f.check('甲'))
  const place = screen.getByRole<HTMLButtonElement>('button', { name: '放到画布上' })
  act(() => {
    place.click()
    place.click()
  })
  await act(async () => {})
  await act(async () => release(Response.json(mediaAsset(`${f.ids[0]}-asset-0`))))
  expect(f.imported()).toHaveLength(1)
})
it.each(['batch', 'view'] as const)(
  '历史导入初始化 %s 同步失败后释放等待状态且可重试',
  async (stage) => {
    const f = setup()
    await f.user.click(f.check('甲'))
    const fail = () => {
      throw new Error('初始化暂时不可用')
    }
    if (stage === 'batch') vi.spyOn(importProgress, 'beginImport').mockImplementationOnce(fail)
    else vi.spyOn(importView, 'watchImportView').mockImplementationOnce(fail)
    await f.user.click(screen.getByRole('button', { name: '放到画布上' }))
    expect(screen.getByRole('alert').textContent).toContain('初始化暂时不可用')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '放到画布上' }).disabled).toBe(
      false,
    )
    expect(f.check('甲').checked).toBe(true)
    expect(f.imported()).toHaveLength(0)
    expect(useCanvas.getState().importing).toBeNull()
    await f.user.click(screen.getByRole('button', { name: '放到画布上' }))
    await waitFor(() => expect(f.imported()).toHaveLength(1))
    expect(useCanvas.getState().importing).toBeNull()
  },
)
it('素材读取等待可见，失败保留选择并可重试', async () => {
  const f = setup()
  let release!: (response: Response) => void
  const requests = mockFetch((request) =>
    request.url.endsWith('/meta')
      ? new Promise<Response>((resolve) => {
          release = resolve
        })
      : undefined,
  )
  await f.user.click(f.check('甲'))
  const place = screen.getByRole<HTMLButtonElement>('button', { name: '放到画布上' })
  act(() => {
    place.click()
    place.click()
  })
  await act(async () => {})
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '正在读取素材…' }).disabled).toBe(
    true,
  )
  expect(requests).toHaveBeenCalledTimes(1)
  await act(async () => release(Response.json({ error: '暂时无法读取素材' }, { status: 503 })))
  expect(screen.getByRole('alert').textContent).toContain('选择已保留，请重试')
  expect(f.check('甲').checked).toBe(true)
  expect(f.imported()).toHaveLength(0)
  await f.user.click(screen.getByRole('button', { name: '放到画布上' }))
  await act(async () => release(Response.json(mediaAsset(`${f.ids[0]}-asset-0`))))
  await waitFor(() => expect(f.imported()).toHaveLength(1))
  expect(requests).toHaveBeenCalledTimes(2)
})
it('素材读取期间变只读时不写入、不关闭历史或误报成功', async () => {
  const f = setup()
  let release!: (response: Response) => void
  mockFetch((request) =>
    request.url.endsWith('/meta')
      ? new Promise<Response>((resolve) => {
          release = resolve
        })
      : undefined,
  )
  await f.user.click(f.check('甲'))
  await f.user.click(screen.getByRole('button', { name: '放到画布上' }))
  f.doc.readOnly = true
  await act(async () => release(Response.json(mediaAsset(`${f.ids[0]}-asset-0`))))
  expect(f.imported()).toHaveLength(0)
  expect(screen.getByRole('alert').textContent).toContain('画布已变为只读')
  expect(screen.getByRole('dialog', { name: '生成历史' })).toBeTruthy()
  expect(useCanvas.getState().notice).not.toContain('已放到画布')
})
it.each(['escape', 'locate'] as const)(
  '历史审片 %s 按层级退出，只有明确采用才写文档',
  async (mode) => {
    const f = setup()
    const extra = {
      ...f.results[0]!,
      id: 'extra',
      value: { type: 'image' as const, assetId: 'extra-asset' },
    }
    act(() => {
      f.doc.mutable(f.ids[0]!)!.set('results', [f.results[0], extra])
      f.doc.flush()
    })
    const cards = screen.getAllByRole('button', { name: '预览「甲」' })
    await f.user.click(cards.at(-1)!)
    expect(f.doc.get(f.ids[0]!)!.adopted).toBe(f.results[0]!.id)
    const viewer = within(screen.getByRole('dialog', { name: '查看「甲」' }))
    if (mode === 'escape') {
      await f.user.keyboard('{Escape}')
      expect(screen.queryByRole('dialog', { name: '查看「甲」' })).toBeNull()
      expect(screen.getByRole('dialog', { name: '生成历史' })).toBeTruthy()
      await f.user.click(cards.at(-1)!)
      await f.user.click(screen.getByRole('button', { name: '采用此候选' }))
      expect(f.doc.get(f.ids[0]!)!.adopted).toBe('extra')
    } else {
      await f.user.click(viewer.getByRole('button', { name: '定位来源' }))
      expect(useCanvas.getState().history).toBe(false)
      expect(useCanvas.getState().viewer).toBeNull()
      expect(f.selection.values()).toEqual([f.ids[0]])
    }
  },
)

it('历史采用旧尾帧后主视频同步采用，验收备注按端口独立保存并可重开', async () => {
  const f = shellFixture()
  const id = f.add('video', '视频与尾帧')
  f.doc.mutable(id)!.set('results', [
    {
      id: 'video-new',
      runId: 'new',
      port: 'video',
      at: 2,
      value: { type: 'video', assetId: 'new-video' },
    },
    {
      id: 'video-old',
      runId: 'old',
      outputGroup: 'old',
      port: 'video',
      at: 1,
      value: { type: 'video', assetId: 'old-video' },
    },
    {
      id: 'tail-old',
      runId: 'old',
      outputGroup: 'old',
      port: 'lastFrame',
      at: 1,
      value: { type: 'image', assetId: 'old-tail' },
    },
  ])
  f.doc.mutable(id)!.set('adopted', 'video-new')
  useCanvas.setState({ history: true })
  useSession.setState({
    status: 'ready',
    info: { principal: { id: 'local', role: 'owner' }, authRequired: false, needsSetup: false },
  })
  const { user } = renderApp(
    <>
      <History />
      <Viewer />
    </>,
  )
  await user.click(screen.getByRole('button', { name: /^图片/ }))
  await user.click(screen.getByRole('button', { name: '预览「视频与尾帧」' }))
  await user.click(screen.getByRole('button', { name: '采用此候选' }))
  act(() => f.doc.flush())
  const note = () =>
    screen.getByRole<HTMLTextAreaElement>('textbox', { name: '创作验收备注 · 视频与尾帧' })
  await user.click(screen.getByText('创作验收：待审'))
  await user.type(note(), '尾帧需调整边缘')
  await user.click(screen.getByRole('button', { name: '保存为需修改' }))
  act(() => f.doc.flush())
  const close = () =>
    user.click(
      within(screen.getByRole('dialog', { name: '查看「视频与尾帧」' })).getByRole('button', {
        name: '关闭',
      }),
    )
  await close()
  await user.click(screen.getByRole('button', { name: /^视频/ }))
  const adopted = screen
    .getAllByRole('listitem')
    .find((row) => row.textContent?.includes('采用中'))!
  await user.click(within(adopted).getByRole('button'))
  expect(document.querySelector('video')!.getAttribute('src')).toBe('/api/assets/old-video')
  await user.click(screen.getByText('创作验收：待审'))
  expect(note().value).toBe('')
  await user.type(note(), '主视频运动可用')
  await user.click(screen.getByRole('button', { name: '保存为可用' }))
  act(() => f.doc.flush())
  await close()
  await user.click(screen.getByRole('button', { name: /^图片/ }))
  await user.click(screen.getByRole('button', { name: '预览「视频与尾帧」' }))
  await user.click(screen.getByText('创作验收：需修改'))
  expect(note().value).toBe('尾帧需调整边缘')
  expect(f.doc.get(id)!.reviews?.map((review) => [review.target.resultId, review.note])).toEqual(
    expect.arrayContaining([
      ['tail-old', '尾帧需调整边缘'],
      ['video-old', '主视频运动可用'],
    ]),
  )
})
