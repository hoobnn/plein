// @vitest-environment happy-dom
import type { Engine } from '@plein/canvas-core'
import {
  createDoc,
  createElement,
  deleteElements,
  updateElement,
  type DeliveryRecord,
} from '@plein/doc'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { useDocVersion } from '../../canvas/hooks'
import { useCanvas } from '../../stores/canvas'
import { useSession } from '../../stores/session'
import { act, fireEvent, renderApp, screen } from '../../testing/render'
import { DeliveryReview, useDeliveryReviewSession } from './DeliveryReview'

const docs: ReturnType<typeof createDoc>[] = []
afterEach(() => docs.splice(0).forEach((doc) => doc.destroy()))
function Review({ engine, id, shown = true }: { engine: Engine; id: string; shown?: boolean }) {
  const session = useDeliveryReviewSession()
  useDocVersion(engine.doc)
  return shown ? (
    <DeliveryReview engine={engine} node={engine.doc.get(id)!} session={session} />
  ) : null
}
function record(id: string): DeliveryRecord {
  return {
    id,
    resultId: id,
    runId: `run-${id}`,
    assetId: id.repeat(64),
    kind: 'animatic',
    version: id,
    createdAt: 1,
    width: 1280,
    height: 720,
    duration: 4,
    sources: [{ source: 'board', shotId: 'shot', start: 0, end: 4 }],
    notes: [],
  }
}
function setup() {
  vi.stubGlobal(
    'HTMLMediaElement',
    new Proxy(HTMLMediaElement, {
      get: (target, key, receiver) =>
        key === 'HAVE_METADATA' ? 1 : Reflect.get(target, key, receiver),
    }),
  )
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
  const doc = createDoc(undefined, { schedule: () => {} })
  docs.push(doc)
  const id = createElement(doc, {
    kind: 'node',
    nodeType: 'plein/animatic',
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    name: '样片',
    deliveries: [record('a'), record('b')],
  })
  createElement(doc, {
    id: 'board',
    kind: 'node',
    nodeType: 'plein/storyboard',
    x: 0,
    y: 0,
    w: 100,
    h: 100,
  })
  doc.flush()
  doc.undo.clear()
  const engine = { doc, selection: { set: vi.fn() }, zoomToFit: vi.fn() } as unknown as Engine
  useCanvas.setState({ engine, canvasId: 'canvas', sequence: id })
  useSession.setState({
    info: { principal: { id: 'local', role: 'owner' }, authRequired: false, needsSetup: false },
  })
  const view = renderApp(<Review engine={engine} id={id} />)
  const read = () => doc.get(id)!.deliveries!
  const write = (records: DeliveryRecord[]) => {
    updateElement(doc, id, { deliveries: records })
    doc.flush()
  }
  const video = () => screen.getByLabelText('实际导出 MP4') as HTMLVideoElement
  const ready = (at = 1.25) => {
    Object.defineProperties(video(), {
      readyState: { configurable: true, value: 2 },
      duration: { configurable: true, value: 4 },
    })
    video().currentTime = at
    fireEvent.loadedMetadata(video())
  }
  return {
    ...view,
    doc,
    id,
    engine,
    read,
    write,
    video,
    ready,
    field: () => screen.getByRole('textbox', { name: '成片时间码意见' }) as HTMLTextAreaElement,
    add: () => screen.getByRole('button', { name: '在当前时间添加意见' }),
    versions: () => screen.getByRole('combobox', { name: '交付版本' }),
  }
}

it('实际文件尚未就绪时保留草稿，失败重试与自然恢复均清理加载状态，按真实时间保存', async () => {
  const f = setup()
  Object.defineProperty(f.video(), 'readyState', { configurable: true, value: 0 })
  expect(screen.getByText('正在加载实际 MP4…')).toBeTruthy()
  await f.user.type(f.field(), '需复查')
  await f.user.click(f.add())
  expect(f.read()[0]!.notes).toEqual([])
  expect(f.field().value).toBe('需复查')
  fireEvent.error(f.video())
  expect(screen.queryByText('正在加载实际 MP4…')).toBeNull()
  await f.user.click(screen.getByRole('button', { name: '重新加载实际 MP4' }))
  expect(screen.getByText('正在加载实际 MP4…')).toBeTruthy()
  fireEvent.error(f.video())
  f.ready()
  expect(screen.queryByText('实际 MP4 加载失败，请重新加载后继续回看。')).toBeNull()
  await f.user.click(f.add())
  expect(f.read()[0]!.notes).toMatchObject([{ text: '需复查', time: 1.25, source: 'board' }])
  expect(f.field().value).toBe('')
})

it('每个版本草稿和播放位置独立，切换视图立即暂停；新导出不抢走当前版本', async () => {
  const f = setup()
  f.ready(1.5)
  await f.user.type(f.field(), '旧版草稿')
  await f.user.selectOptions(f.versions(), 'b')
  expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled()
  f.ready(2.5)
  await f.user.type(f.field(), '新版草稿')
  act(() => f.write([record('c'), ...f.read()]))
  expect((f.versions() as HTMLSelectElement).value).toBe('b')
  f.rerender(<Review engine={f.engine} id={f.id} shown={false} />)
  f.rerender(<Review engine={f.engine} id={f.id} />)
  f.ready(0)
  expect(f.video().currentTime).toBe(2.5)
  expect(f.field().value).toBe('新版草稿')
  await f.user.selectOptions(f.versions(), 'a')
  f.ready(0)
  expect(f.video().currentTime).toBe(1.5)
  expect(f.field().value).toBe('旧版草稿')
  await f.user.click(f.add())
  expect(f.read().find((r) => r.id === 'a')!.notes[0]).toMatchObject({
    time: 1.5,
    text: '旧版草稿',
  })
  await f.user.selectOptions(f.versions(), 'b')
  expect(f.field().value).toBe('新版草稿')
})

it.each(['add', 'resolve', 'delete'] as const)(
  '同帧 %s 合并最新意见列表，不覆盖同伴新增',
  async (action) => {
    const f = setup()
    act(() =>
      f.write([
        { ...record('a'), notes: [{ id: 'n', text: '原意见', time: 1, resolved: false }] },
        record('b'),
      ]),
    )
    f.ready()
    await f.user.type(f.field(), '我的意见')
    const control =
      action === 'add'
        ? f.add()
        : action === 'resolve'
          ? screen.getByRole('checkbox', { name: '已解决' })
          : screen.getByRole('button', { name: '删除' })
    act(() => {
      const [current, other] = f.read()
      updateElement(f.doc, f.id, {
        deliveries: [
          {
            ...current!,
            notes: [
              ...current!.notes,
              { id: 'remote', text: '同伴意见', time: 2, resolved: false },
            ],
          },
          other!,
        ],
      })
      fireEvent.click(control)
      f.doc.flush()
    })
    expect(f.read()[0]!.notes.some((n) => n.id === 'remote')).toBe(true)
    if (action === 'add') expect(f.read()[0]!.notes.at(-1)!.text).toBe('我的意见')
    if (action === 'resolve')
      expect(f.read()[0]!.notes.find((n) => n.id === 'n')!.resolved).toBe(true)
    if (action === 'delete') expect(f.read()[0]!.notes.some((n) => n.id === 'n')).toBe(false)
  },
)

it('同帧意见被修改时拒绝旧解决操作，重新核对后可重试', async () => {
  const f = setup()
  act(() =>
    f.write([{ ...record('a'), notes: [{ id: 'n', text: '旧意见', time: 1, resolved: false }] }]),
  )
  const control = screen.getByRole('checkbox', { name: '已解决' })
  act(() => {
    updateElement(f.doc, f.id, {
      deliveries: [
        { ...record('a'), notes: [{ id: 'n', text: '同伴新意见', time: 1, resolved: false }] },
      ],
    })
    fireEvent.click(control)
    f.doc.flush()
  })
  expect(screen.getByRole('alert').textContent).toContain('意见已变化或移除')
  expect(f.read()[0]!.notes[0]!.resolved).toBe(false)
  await f.user.click(screen.getByRole('checkbox', { name: '已解决' }))
  expect(f.read()[0]!.notes[0]!.resolved).toBe(true)
})

it.each(['readonly', 'identity'] as const)(
  '同帧 %s 变化拒绝旧添加，保留草稿供恢复重试',
  async (mode) => {
    const f = setup()
    f.ready()
    await f.user.type(f.field(), '必须保留')
    act(() => {
      if (mode === 'readonly') f.doc.readOnly = true
      else updateElement(f.doc, f.id, { deliveries: [{ ...record('a'), assetId: 'c'.repeat(64) }] })
      fireEvent.click(f.add())
      f.doc.flush()
    })
    expect(f.read()[0]!.notes).toHaveLength(0)
    expect(f.field().value).toBe('必须保留')
    expect(screen.getByRole('alert').textContent).toMatch(
      mode === 'readonly' ? /只读/ : /版本内容已变化/,
    )
    act(() => {
      f.doc.readOnly = false
      updateElement(f.doc, f.id, { name: '恢复' })
      f.doc.flush()
    })
    f.ready(2)
    await f.user.click(f.add())
    expect(f.read()[0]!.notes[0]!.time).toBe(2)
  },
)

it('意见与确认独立撤销，不撤回紧邻改名，切换版本不串写', async () => {
  const f = setup()
  f.ready()
  await f.user.type(f.field(), '意见')
  act(() => {
    updateElement(f.doc, f.id, { name: '保留改名' })
    fireEvent.click(f.add())
  })
  expect(f.read()[0]!.notes).toHaveLength(1)
  act(() => {
    f.doc.undo.undo()
    f.doc.flush()
  })
  expect(f.doc.get(f.id)!.name).toBe('保留改名')
  expect(f.read()[0]!.notes).toHaveLength(0)
  act(() => {
    f.doc.undo.redo()
    f.doc.flush()
  })
  await f.user.click(screen.getByRole('checkbox', { name: '已解决' }))
  await f.user.click(screen.getByRole('button', { name: '确认此版草稿已审阅' }))
  expect(f.read()[0]!.confirmedAt).toBeDefined()
  await f.user.selectOptions(f.versions(), 'b')
  await f.user.type(f.field(), '新版草稿')
  act(() => {
    f.doc.undo.undo()
    f.doc.flush()
  })
  expect(f.read()[0]!.confirmedAt).toBeUndefined()
  expect(f.field().value).toBe('新版草稿')
  expect((f.versions() as HTMLSelectElement).value).toBe('b')
})

it('全部版本移除显示空态，恢复后保留会话草稿；同ID新内容不复用旧播放位置', async () => {
  const f = setup()
  f.ready(3)
  await f.user.type(f.field(), '保留草稿')
  act(() => f.write([]))
  expect(screen.getByText('导出成功后，这里回看实际 MP4 并记录交付意见。')).toBeTruthy()
  act(() => f.write([{ ...record('a'), assetId: 'd'.repeat(64) }]))
  expect(f.field().value).toBe('保留草稿')
  expect(screen.getByRole('alert').textContent).toContain('版本内容已变化')
  f.ready(0)
  expect(f.video().currentTime).toBe(0)
  f.unmount()
  renderApp(<Review engine={f.engine} id={f.id} />)
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('')
})

it('时间码定位写入播放器；来源删除给出反馈，恢复后打开精确来源', async () => {
  const f = setup()
  act(() =>
    f.write([
      {
        ...record('a'),
        notes: [{ id: 'n', text: '需返工', time: 1.5, resolved: false, source: 'board' }],
      },
    ]),
  )
  await f.user.click(screen.getByRole('button', { name: '00:01.5' }))
  expect(f.video().currentTime).toBe(1.5)
  act(() => {
    f.doc.undo.stopCapturing()
    deleteElements(f.doc, ['board'])
    f.doc.undo.stopCapturing()
    f.doc.flush()
  })
  await f.user.click(screen.getByRole('button', { name: '定位镜头返工' }))
  expect(screen.getByRole('alert').textContent).toContain('已不在画布')
  act(() => {
    f.doc.undo.undo()
    f.doc.flush()
  })
  await f.user.click(screen.getByRole('button', { name: '定位镜头返工' }))
  expect(f.engine.selection.set).toHaveBeenCalledWith(['board'])
  expect(useCanvas.getState().storyboard).toBe('board')
})

it('历史范围禁止意见和确认写入，同帧变为历史也拒绝旧按钮操作', async () => {
  const f = setup()
  act(() =>
    f.write([
      {
        ...record('a'),
        confirmedAt: 1,
        notes: [{ id: 'note', text: '历史意见', time: 1, resolved: true }],
      },
    ]),
  )
  const revoke = screen.getByRole('button', { name: '撤回此版确认' })
  act(() => {
    const latest = { ...f.read()[0]!, historical: true }
    updateElement(f.doc, f.id, { deliveries: [latest] })
    fireEvent.click(revoke)
    f.doc.flush()
  })
  expect(f.read()[0]!.confirmedAt).toBe(1)
  expect(screen.getByRole('alert').textContent).toMatch(/历史范围|版本内容已变化/)
  expect(f.field().disabled).toBe(true)
  expect((screen.getByRole('checkbox', { name: '已解决' }) as HTMLInputElement).disabled).toBe(true)
  expect((screen.getByRole('button', { name: '删除' }) as HTMLButtonElement).disabled).toBe(true)
  expect(
    (screen.getByRole('button', { name: '历史范围确认只读' }) as HTMLButtonElement).disabled,
  ).toBe(true)
})
