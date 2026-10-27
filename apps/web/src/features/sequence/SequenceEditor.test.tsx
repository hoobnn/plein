// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { connect, deleteElements, setParam, updateElement } from '@plein/doc'
import { useCanvas } from '../../stores/canvas'
import { mockFetch } from '../../testing/fetch'
import { mockResizeObserver } from '../../testing/browser'
import { act, fireEvent, renderApp, screen, waitFor } from '../../testing/render'
import { SequenceEditor } from './SequenceEditor'
import { Transport } from './Transport'
import { sequenceFixture } from './testing'

vi.mock('./SequencePreview', () => ({
  SequencePreview: (props: Parameters<typeof import('./SequencePreview').SequencePreview>[0]) => (
    <div data-testid="preview" data-readonly={props.readOnly}>
      <Transport playhead={props.playhead} total={props.timeline.total} note="测试预览" />
    </div>
  ),
}))
vi.mock('./media', async (original) => ({
  ...(await original<typeof import('./media')>()),
  Filmstrip: () => null,
  Waveform: () => null,
}))

const documents: ReturnType<typeof sequenceFixture>['doc'][] = []
afterEach(() => {
  for (const doc of documents.splice(0)) doc.destroy()
})
function setup(options: Parameters<typeof sequenceFixture>[0] = { animatic: true }) {
  mockResizeObserver()
  const f = sequenceFixture(options)
  documents.push(f.doc)
  return { ...f, ...renderApp(<SequenceEditor />) }
}
async function videoSetup() {
  const asset = crypto.randomUUID().replaceAll('-', '').repeat(2)
  mockFetch((request) => {
    if (new URL(request.url).pathname === `/api/assets/${asset}/meta`)
      return Response.json({
        id: asset,
        kind: 'video',
        name: '视频',
        duration: 2,
        width: 96,
        height: 64,
        mime: 'video/webm',
      })
  })
  const f = setup({ videos: [asset] })
  await waitFor(() =>
    expect(screen.getByRole<HTMLInputElement>('spinbutton', { name: '入点（秒）' }).max).toBe('2'),
  )
  act(() =>
    f.patch({
      subtitles: true,
      clips: (f.params().clips as Array<Record<string, unknown>>).map((row) => ({
        ...row,
        in: 0,
        out: 1.8,
        subtitle: '初始字幕',
      })),
    }),
  )
  return f
}
const field = (name: string) => screen.getByRole<HTMLInputElement>('spinbutton', { name })
const clip = (f: ReturnType<typeof setup>) =>
  (f.params().clips as Array<Record<string, unknown>>)[0]!

it('异常参数仅显式恢复无效字段，撤销重做保留镜头和其他设置', async () => {
  const f = setup({
    params: {
      instanceVersion: undefined,
      resolution: '8K',
      clipVolume: 0.25,
      clips: [{ source: 'retained', in: 0.2 }],
    },
  })
  expect(screen.getByRole('alert').textContent).toContain('分辨率')
  expect(f.params().resolution).toBe('8K')
  await f.user.click(screen.getByRole('button', { name: '恢复无效字段默认值' }))
  expect(f.params()).toMatchObject({
    resolution: '1080p',
    clipVolume: 0.25,
    clips: [{ source: 'retained', in: 0.2 }],
  })
  act(() => f.engine.undo())
  expect(screen.getByRole('dialog', { name: '序列参数问题' })).toBeTruthy()
  await f.user.click(screen.getByRole('button', { name: '重做' }))
  expect(screen.getByRole('dialog', { name: '序列' })).toBeTruthy()
})

it('锁定参数恢复与预览编辑都遵守只读状态', async () => {
  const f = setup({ animatic: true })
  act(() => {
    updateElement(f.doc, f.id, { locked: true })
    f.refresh()
  })
  expect(screen.getByTestId('preview').dataset.readonly).toBe('true')
  expect(field('样片镜头时长（秒）').closest('fieldset')?.disabled).toBe(true)
  act(() => f.patch({ resolution: '8K' }))
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: '恢复无效字段默认值' }).disabled,
  ).toBe(true)
})

it('样片小数草稿失焦后才提交，空白拒绝且撤销可恢复', async () => {
  const f = setup()
  const input = field('样片镜头时长（秒）')
  await f.user.click(input)
  fireEvent.change(input, { target: { value: '4.5' } })
  expect((f.params().shots as Array<{ duration: number }>)[0]!.duration).toBe(3)
  await f.user.tab()
  expect((f.params().shots as Array<{ duration: number }>)[0]!.duration).toBe(4.5)
  act(() => f.engine.undo())
  expect(input.value).toBe('3')
  await f.user.clear(input)
  await f.user.tab()
  expect(input.value).toBe('3')
  expect(screen.getByRole('alert').textContent).toContain('已保留原设置')
})

it('样片同帧提交保留其他镜头及并发修改的其他字段', async () => {
  const f = setup()
  const input = field('样片镜头时长（秒）')
  await f.user.click(input)
  fireEvent.change(input, { target: { value: '4.5' } })
  act(() => {
    setParam(f.doc, f.id, 'shots', [
      { shotId: 'one', duration: 3, lineDelay: 2, dialogue: [] },
      { shotId: 'new', duration: 5, dialogue: [] },
    ])
    input.blur()
    f.doc.flush()
  })
  expect(f.params().shots).toMatchObject([
    { shotId: 'one', duration: 4.5, lineDelay: 2 },
    { shotId: 'new', duration: 5 },
  ])
})

it.each(['使用最新数值', '保留当前数值'])(
  '秒数同帧更新保留草稿，明确%s后才解决冲突',
  async (choice) => {
    const f = await videoSetup()
    const input = field('入点（秒）')
    await f.user.click(input)
    fireEvent.change(input, { target: { value: '0.4' } })
    act(() => {
      setParam(f.doc, f.id, 'clips', [{ ...clip(f), in: 0.2, out: 1.4 }])
      input.blur()
      f.doc.flush()
    })
    expect(clip(f)).toMatchObject({ in: 0.2, out: 1.4 })
    expect(input.value).toBe('0.4')
    await f.user.click(screen.getByRole('button', { name: choice }))
    expect(clip(f)).toMatchObject({ in: choice === '保留当前数值' ? 0.4 : 0.2, out: 1.4 })
    expect(document.activeElement).toBe(input)
  },
)

it.each(['in', 'out'])('修剪 %s 以同帧最新边界校验，不覆盖其他字段', async (key) => {
  const f = await videoSetup()
  const input = field(key === 'in' ? '入点（秒）' : '出点（秒）')
  await f.user.click(input)
  fireEvent.change(input, { target: { value: key === 'in' ? '0.4' : '0.8' } })
  act(() => {
    setParam(f.doc, f.id, 'clips', [{ ...clip(f), ...(key === 'in' ? { out: 0.2 } : { in: 1 }) }])
    input.blur()
    f.doc.flush()
  })
  expect(clip(f)).toMatchObject(key === 'in' ? { in: 0, out: 0.2 } : { in: 1, out: 1.8 })
  expect(screen.getByRole('alert').textContent).toContain(
    key === 'in' ? '入点需要早于' : '出点需要晚于',
  )
})

it.each(['使用最新字幕', '保留当前字幕'])(
  '字幕同帧协作更新需明确%s，组字不提交或退出',
  async (choice) => {
    const f = await videoSetup()
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: '字幕' })
    await f.user.click(input)
    fireEvent.change(input, { target: { value: '本机草稿' } })
    for (const key of ['Enter', 'Escape']) fireEvent.keyDown(input, { key, isComposing: true })
    expect(clip(f).subtitle).toBe('初始字幕')
    act(() => {
      setParam(f.doc, f.id, 'clips', [{ ...clip(f), subtitle: '同伴字幕', out: 1.4 }])
      input.blur()
      f.doc.flush()
    })
    expect(input.value).toBe('本机草稿')
    expect(clip(f)).toMatchObject({ subtitle: '同伴字幕', out: 1.4 })
    await f.user.click(screen.getByRole('button', { name: choice }))
    expect(clip(f)).toMatchObject({
      subtitle: choice === '保留当前字幕' ? '本机草稿' : '同伴字幕',
      out: 1.4,
    })
    expect(document.activeElement).toBe(input)
  },
)

it.each(['pointercancel', 'blur', 'external'])(
  '混音滑杆 %s 取消草稿，迟到松手不提交且可重新操作',
  async (cancel) => {
    const f = setup()
    await f.user.click(screen.getByRole('button', { name: '成片' }))
    const input = screen.getByRole<HTMLInputElement>('slider', { name: '对白' })
    fireEvent.pointerDown(input, { pointerId: 1, button: 0 })
    fireEvent.change(input, { target: { value: '1.5' } })
    expect(f.params().dialogueVolume).toBeUndefined()
    if (cancel === 'external') act(() => f.patch({ dialogueVolume: 0.4 }))
    else if (cancel === 'blur') fireEvent(window, new Event('blur'))
    else fireEvent.pointerCancel(window, { pointerId: 1 })
    fireEvent.change(input, { target: { value: '1.8' } })
    fireEvent.pointerUp(window, { pointerId: 1 })
    expect(input.value).toBe(cancel === 'external' ? '0.4' : '1')
    fireEvent.pointerDown(input, { pointerId: 2, button: 0 })
    fireEvent.change(input, { target: { value: '0.5' } })
    fireEvent.pointerUp(window, { pointerId: 2 })
    expect(f.params().dialogueVolume).toBe(0.5)
  },
)

it('未就绪的前序素材阻止后镜头定位，完成元信息后恢复', async () => {
  const assets = ['a', 'b'].map(() => crypto.randomUUID().replaceAll('-', '').repeat(2))
  let release!: (response: Response) => void
  const gate = new Promise<Response>((resolve) => {
    release = resolve
  })
  mockFetch((request) => {
    const path = new URL(request.url).pathname
    if (path === `/api/assets/${assets[0]}/meta`) return gate
    if (path === `/api/assets/${assets[1]}/meta`) return Response.json({ duration: 0.6 })
  })
  const f = setup({ videos: assets })
  const second = await screen.findByRole('button', { name: '视频 2' })
  expect(second.getAttribute('aria-disabled')).toBe('true')
  await f.user.click(second)
  expect(document.querySelector('.seq-time')?.textContent).toBe('0:00.0 / 0:02.6')
  await act(async () => {
    release(Response.json({ duration: 0.6 }))
    await gate
  })
  await waitFor(() => expect(second.hasAttribute('aria-disabled')).toBe(false))
  await f.user.click(second)
  expect(document.querySelector('.seq-time')?.textContent).toBe('0:00.6 / 0:01.2')
})

it('打开唯一关联成片之前同步增加歧义时不使用旧按钮导航', async () => {
  const f = setup({ animatic: true, params: { boardId: 'board' } })
  const media = f.add({
    nodeType: 'plein/video',
    params: { source: { storyboard: 'board', shot: 'one', role: 'video' } },
    ports: { inputs: [], outputs: [{ id: 'video', type: 'video', label: '视频' }] },
  })
  const addFilm = () => {
    const film = f.add({
      nodeType: 'plein/sequence',
      params: {},
      name: '成片',
      ports: {
        inputs: [{ id: 'clips', type: 'video', label: '镜头', multiple: true }],
        outputs: [],
      },
    })
    connect(f.doc, [media, 'video'], [film, 'clips'])
    return film
  }
  const target = addFilm()
  act(() => f.refresh())
  const button = screen.getByRole('button', { name: '切回成片' })
  act(() => {
    addFilm()
    button.click()
    f.doc.flush()
  })
  expect(useCanvas.getState().sequence).toBe(f.id)
  expect(screen.getByRole('alert').textContent).toContain('关联成片已变化')
  expect(f.doc.has(target)).toBe(true)
})

async function subtitleSetup(recovery = false) {
  const asset = crypto.randomUUID().replaceAll('-', '').repeat(2)
  let release!: (response: Response) => void
  const pending = new Promise<Response>((resolve) => {
    release = resolve
  })
  const calls: Array<{ path: string; body: unknown }> = []
  const fetcher = mockFetch(async (request) => {
    const path = new URL(request.url).pathname
    if (path === `/api/assets/${asset}/meta`) return Response.json({ duration: 2 })
    if (path === '/api/media/subtitle-recognition')
      return Response.json(
        recovery
          ? {
              model: 'plein/mock:audio',
              assetId: asset,
              expected: 'revision',
              recovery: { state: 'submit_unknown', attachable: true },
            }
          : null,
      )
    if (request.method === 'POST') {
      calls.push({ path, body: await request.json() })
      return pending
    }
  })
  const f = setup({
    animatic: true,
    params: {
      subtitles: true,
      model: 'plein/mock:audio',
      shots: [
        {
          shotId: 'one',
          duration: 3,
          dialogue: [{ source: 'line', assetId: asset, caption: '原始台词' }],
        },
      ],
    },
  })
  await f.user.click(screen.getByRole('button', { name: '字幕' }))
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: '识别全部对白并重建字幕' }).disabled,
    ).toBe(false),
  )
  return { ...f, asset, release, pending, calls, fetcher }
}

it.each(['close', 'reopen', 'switch'])(
  '识别等待中 %s，迟到结果不写回旧编辑会话',
  async (action) => {
    const f = await subtitleSetup()
    await f.user.click(screen.getByRole('button', { name: '识别全部对白并重建字幕' }))
    await waitFor(() => expect(f.calls).toHaveLength(1))
    await f.user.click(screen.getByRole('button', { name: '关闭' }))
    if (action === 'reopen') act(() => useCanvas.getState().openSequence(f.id))
    if (action === 'switch') {
      const other = f.add({
        nodeType: 'plein/animatic',
        params: { shots: [{ shotId: 'two', duration: 2, dialogue: [] }] },
      })
      act(() => useCanvas.getState().openSequence(other))
    }
    await act(async () => {
      f.release(
        Response.json({ transcripts: { [f.asset]: [{ start: 0, end: 1, text: '迟到台词' }] } }),
      )
      await f.pending
    })
    expect(f.params().subtitleTrack).toBeUndefined()
    expect(f.calls).toHaveLength(1)
  },
)

it('恢复等待中关闭重开，恢复仍完成但不自动发起旧会话识别', async () => {
  const f = await subtitleSetup(true)
  await f.user.type(
    await screen.findByRole('textbox', { name: '字幕识别平台任务 ID' }),
    'existing-task',
  )
  await f.user.click(screen.getByRole('button', { name: '关联任务并续查' }))
  await waitFor(() => expect(f.calls).toHaveLength(1))
  expect(f.calls[0]).toMatchObject({
    path: '/api/media/subtitle-recover',
    body: { expected: 'revision', operation: { action: 'attach', remoteId: 'existing-task' } },
  })
  await f.user.click(screen.getByRole('button', { name: '关闭' }))
  act(() => useCanvas.getState().openSequence(f.id))
  await act(async () => {
    f.release(Response.json({ ok: true }))
    await f.pending
  })
  expect(f.calls).toHaveLength(1)
  expect(f.params().subtitleTrack).toBeUndefined()
})

it('持久字幕逐句修改、隐藏和撤销；等待中的识别不能覆盖过期轨上的输入草稿', async () => {
  const f = await subtitleSetup()
  await f.user.click(screen.getByRole('button', { name: '按当前台词创建字幕' }))
  const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '镜头 1 字幕 1 文本' })
  fireEvent.change(input, { target: { value: '人工修改' } })
  const track = () => f.params().subtitleTrack as { cues: Array<{ text: string; hidden: boolean }> }
  expect(track().cues[0]!.text).toBe('人工修改')
  await f.user.click(screen.getByRole('checkbox', { name: '显示字幕 1' }))
  expect(track().cues[0]!.hidden).toBe(true)
  act(() => f.engine.undo())
  expect(track().cues[0]!.hidden).toBe(false)
  act(() => f.patch({ shots: [{ ...(f.params().shots as object[])[0], lineDelay: 0.3 }] }))
  expect(screen.getAllByText(/字幕已过期/).length).toBeGreaterThan(0)
  await f.user.click(screen.getByRole('button', { name: '识别全部对白并重建字幕' }))
  await waitFor(() => expect(f.calls).toHaveLength(1))
  fireEvent.change(input, { target: { value: '识别期间继续输入' } })
  await act(async () => {
    f.release(
      Response.json({ transcripts: { [f.asset]: [{ start: 0, end: 1, text: '识别台词' }] } }),
    )
    await f.pending
  })
  expect(screen.getByRole('alert').textContent).toContain('未覆盖编辑')
  expect(input.value).toBe('识别期间继续输入')
  expect(track().cues[0]!.text).toBe('人工修改')
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '导出工程' }).disabled).toBe(true)
})

it('编辑器撤销路由尊重原生文本输入和同帧只读，按钮与复选框可用撤销重做', async () => {
  const f = await videoSetup()
  const undo = vi.spyOn(f.engine, 'undo'),
    redo = vi.spyOn(f.engine, 'redo')
  const input = screen.getByRole('textbox', { name: '字幕' })
  act(() => input.focus())
  fireEvent.keyDown(input, { key: 'z', ctrlKey: true })
  expect(undo).not.toHaveBeenCalled()
  const button = screen.getByRole('button', { name: '回到开头' })
  act(() => button.focus())
  fireEvent.keyDown(button, { key: 'z', metaKey: true })
  fireEvent.keyDown(button, { key: 'z', metaKey: true, shiftKey: true })
  fireEvent.keyDown(button, { key: 'y', ctrlKey: true })
  expect(undo).toHaveBeenCalledTimes(1)
  expect(redo).toHaveBeenCalledTimes(2)
  undo.mockClear()
  act(() => {
    updateElement(f.doc, f.id, { locked: true })
    fireEvent.keyDown(button, { key: 'z', ctrlKey: true })
    f.refresh()
  })
  expect(undo).not.toHaveBeenCalled()
})

it('手动入出点拒绝交叉边界，清空恢复完整素材', async () => {
  const errors = vi.spyOn(console, 'error')
  const f = await videoSetup()
  const input = field('入点（秒）')
  await f.user.click(input)
  fireEvent.change(input, { target: { value: '1.9' } })
  await f.user.tab()
  expect(clip(f).in).toBe(0)
  expect(screen.getByRole('alert').textContent).toContain('入点需要早于出点')
  const out = field('出点（秒）')
  await f.user.clear(out)
  await f.user.tab()
  expect(clip(f).out).toBeUndefined()
  expect(errors.mock.calls.flat().join(' ')).not.toContain('same key')
})

it('样片同字段同帧冲突拒绝覆盖，重新核对修改后清除旧错误', async () => {
  const f = setup()
  const input = field('样片镜头时长（秒）')
  await f.user.click(input)
  fireEvent.change(input, { target: { value: '4.5' } })
  act(() => {
    setParam(f.doc, f.id, 'shots', [{ shotId: 'one', duration: 5, dialogue: [] }])
    input.blur()
    f.doc.flush()
  })
  expect((f.params().shots as Array<{ duration: number }>)[0]!.duration).toBe(5)
  expect(screen.getByRole('alert').textContent).toContain('镜头设置已更新')
  await f.user.click(input)
  fireEvent.change(input, { target: { value: '6' } })
  await f.user.tab()
  expect((f.params().shots as Array<{ duration: number }>)[0]!.duration).toBe(6)
  expect(screen.queryByRole('alert')).toBeNull()
})

it('样片转场不完整指数拒绝清空，Escape放弃草稿，清空才恢复默认', async () => {
  const f = setup({ animatic: true, params: { transition: '淡入淡出', transitionDuration: 0.8 } })
  await f.user.click(screen.getByRole('button', { name: '成片' }))
  const input = field('转场时长（秒）')
  await f.user.click(input)
  fireEvent.change(input, { target: { value: '0.9' } })
  Object.defineProperty(input, 'validity', { configurable: true, value: { badInput: true } })
  fireEvent.change(input, { target: { value: '' } })
  await f.user.tab()
  expect(f.params().transitionDuration).toBe(0.8)
  Object.defineProperty(input, 'validity', { configurable: true, value: { badInput: false } })
  await f.user.click(input)
  fireEvent.change(input, { target: { value: '1.2' } })
  fireEvent.keyDown(input, { key: 'Escape' })
  expect(f.params().transitionDuration).toBe(0.8)
})

it('关联同名成片可用键盘选择，旧选项删除后拒绝导航并能选择剩余成片', async () => {
  const f = setup({ animatic: true, params: { boardId: 'board' } })
  const media = f.add({
    nodeType: 'plein/video',
    params: { source: { storyboard: 'board', shot: 'one', role: 'video' } },
    ports: { inputs: [], outputs: [{ id: 'video', type: 'video', label: '视频' }] },
  })
  const targets = [1, 2].map(() => {
    const id = f.add({
      nodeType: 'plein/sequence',
      name: '导演版',
      params: {},
      ports: {
        inputs: [{ id: 'clips', type: 'video', label: '镜头', multiple: true }],
        outputs: [],
      },
    })
    connect(f.doc, [media, 'video'], [id, 'clips'])
    return id
  })
  act(() => f.refresh())
  const chooser = screen.getByRole('combobox', { name: '选择成片序列' })
  await f.user.click(chooser)
  const options = screen.getAllByRole('option').filter((o) => o.textContent?.includes('导演版'))
  expect(new Set(options.map((o) => o.textContent)).size).toBe(2)
  fireEvent.keyDown(options[0]!, { key: 'Escape' })
  expect(useCanvas.getState().sequence).toBe(f.id)
  await f.user.click(chooser)
  const stale = screen.getByRole('option', { name: new RegExp(targets[1]!.slice(-6)) })
  act(() => {
    deleteElements(f.doc, [targets[1]!])
    stale.click()
    f.doc.flush()
  })
  expect(useCanvas.getState().sequence).toBe(f.id)
  expect(screen.getByRole('alert').textContent).toContain('已变化')
  await f.user.click(screen.getByRole('button', { name: '切回成片' }))
  expect(useCanvas.getState().sequence).toBe(targets[0])
})

it('固定历史候选读取中关闭不写入，重试固定只改变实例，不改变原采用项', async () => {
  const assets = ['a', 'b'].map(() => crypto.randomUUID().replaceAll('-', '').repeat(2))
  let release!: (response: Response) => void
  const gate = new Promise<Response>((resolve) => {
    release = resolve
  })
  mockFetch((request) => {
    const path = new URL(request.url).pathname
    if (path === `/api/assets/${assets[0]}/meta`) return Response.json({ duration: 2 })
    if (path === `/api/assets/${assets[1]}/meta`) return gate
  })
  mockResizeObserver()
  const base = sequenceFixture({})
  documents.push(base.doc)
  const source = base.add({
    nodeType: 'plein/video',
    adopted: 'current',
    params: {},
    ports: { inputs: [], outputs: [{ id: 'video', type: 'video', label: '视频' }] },
    results: assets.map((assetId, index) => ({
      id: index === 0 ? 'current' : 'history',
      runId: `run-${index}`,
      port: 'video',
      at: 2 - index,
      value: { type: 'video' as const, assetId },
    })),
  })
  connect(base.doc, [source, 'video'], [base.id, 'clips'])
  base.refresh()
  const f = { ...base, ...renderApp(<SequenceEditor />) }
  await waitFor(() => expect(field('入点（秒）').max).toBe('2'))
  const before = f.params().clips
  const choose = async () => {
    await f.user.click(screen.getByRole('button', { name: '选定候选并固定素材' }))
    await f.user.selectOptions(
      screen.getByRole('combobox', { name: '固定具体视频候选' }),
      'history',
    )
    await f.user.selectOptions(
      screen.getByRole('combobox', { name: '明确选择新实例声音路线' }),
      'native',
    )
    await f.user.click(screen.getByRole('button', { name: '确认本次实例操作' }))
  }
  await choose()
  const modal = screen.getByRole('dialog', { name: '固定素材与实例操作' })
  fireEvent.click(modal.querySelector('button[aria-label="关闭"]')!)
  await act(async () => {
    release(Response.json({ kind: 'video', duration: 2 }))
    await gate
  })
  expect(f.params().clips).toEqual(before)
  await choose()
  await waitFor(() => expect(clip(f).segment).toBeTruthy())
  expect(clip(f).segment).toMatchObject({
    asset: { assetId: assets[1] },
    selection: { nodeId: source, resultId: 'history', runId: 'run-1' },
  })
  expect(f.doc.get(source)!.adopted).toBe('current')
})

it('逐句字幕空文本和倒置时间指向具体字段，隐藏解除导出限制，保留旧轨原值', async () => {
  const f = await subtitleSetup()
  await f.user.click(screen.getByRole('button', { name: '按当前台词创建字幕' }))
  const input = screen.getByRole('textbox', { name: '镜头 1 字幕 1 文本' })
  fireEvent.change(input, { target: { value: '' } })
  expect(input.getAttribute('aria-invalid')).toBe('true')
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '导出样片 MP4' }).disabled).toBe(
    true,
  )
  fireEvent.change(input, { target: { value: '修正文本' } })
  const start = field('镜头 1 字幕 1 开始（秒）')
  fireEvent.change(start, { target: { value: '2' } })
  expect(start.getAttribute('aria-invalid')).toBe('true')
  await f.user.click(screen.getByRole('checkbox', { name: '显示字幕 1' }))
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '导出样片 MP4' }).disabled).toBe(
    false,
  )
  const old = { text: '旧字幕 @角色', originalExtra: { preserve: true } }
  act(() =>
    f.patch({
      subtitleTrack: {
        ...(f.params().subtitleTrack as object),
        unmappedCues: [{ reason: '旧来源已删除', cue: old }],
        legacyTrack: { cues: [old] },
      },
    }),
  )
  expect(JSON.parse(screen.getByLabelText('未映射字幕 1 原值').textContent!)).toEqual(old)
  expect(
    screen.getByRole('region', { name: '未映射旧字幕' }).querySelector('input,textarea,button'),
  ).toBeNull()
  const undo = vi.spyOn(f.engine, 'undo')
  const box = screen.getByRole('checkbox', { name: '显示字幕 1' })
  act(() => box.focus())
  fireEvent.keyDown(box, { key: 'z', ctrlKey: true })
  expect(undo).toHaveBeenCalledTimes(1)
})

it.each(['in', 'out'])(
  '素材同帧替换不把旧%s数值草稿保存到新文件，字幕草稿仍可继续编辑',
  async (key) => {
    const f = await videoSetup()
    const asset = crypto.randomUUID().replaceAll('-', '').repeat(2)
    mockFetch((request) =>
      new URL(request.url).pathname === `/api/assets/${asset}/meta`
        ? Response.json({ kind: 'video', duration: 0.2 })
        : undefined,
    )
    const input = field(key === 'in' ? '入点（秒）' : '出点（秒）')
    await f.user.click(input)
    fireEvent.change(input, { target: { value: '0.5' } })
    act(() => {
      updateElement(f.doc, f.sources[0]!, { assetId: asset })
      input.blur()
      f.refresh()
    })
    expect(clip(f)).toMatchObject({ in: 0, out: 1.8 })
    await waitFor(() => expect(field('入点（秒）').max).toBe('0.2'))
    const subtitle = screen.getByRole<HTMLInputElement>('textbox', { name: '字幕' })
    await f.user.click(subtitle)
    fireEvent.change(subtitle, { target: { value: '还在输入' } })
    act(() => {
      updateElement(f.doc, f.sources[0]!, { name: '新名称' })
      f.refresh()
    })
    expect(subtitle.value).toBe('还在输入')
    await f.user.tab()
    expect(clip(f).subtitle).toBe('还在输入')
  },
)

it.each(['dialogue', 'sfx', 'music'])(
  '%s 上游无结果阻止静默缺声导出，采用有效输出后恢复',
  async (port) => {
    const assets = ['a', 'b'].map(() => crypto.randomUUID().replaceAll('-', '').repeat(2))
    mockFetch((request) => {
      const path = new URL(request.url).pathname
      if (path === `/api/assets/${assets[0]}/meta`)
        return Response.json({ kind: 'video', duration: 2 })
      if (path === `/api/assets/${assets[1]}/meta`)
        return Response.json({ kind: 'audio', duration: 0.5 })
    })
    mockResizeObserver()
    const base = sequenceFixture({ videos: [assets[0]!] })
    documents.push(base.doc)
    const source = base.add({
      nodeType: 'plein/speech',
      name: '待确认声音',
      ports: { inputs: [], outputs: [{ id: 'audio', type: 'audio', label: '声音' }] },
      params: {},
    })
    connect(base.doc, [source, 'audio'], [base.id, port])
    base.refresh()
    const f = { ...base, ...renderApp(<SequenceEditor />) }
    expect(screen.getAllByText(/还没有结果/).length).toBeGreaterThan(0)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '导出 MP4' }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '导出工程' }).disabled).toBe(true)
    act(() => {
      f.doc.mutable(source)!.set('results', [
        {
          id: 'audio',
          runId: 'run',
          at: 1,
          port: 'audio',
          value: { type: 'audio', assetId: assets[1] },
        },
      ])
      f.refresh()
    })
    await waitFor(() =>
      expect(screen.getByRole<HTMLButtonElement>('button', { name: '导出工程' }).disabled).toBe(
        false,
      ),
    )
    expect(screen.queryByText(/还没有结果/)).toBeNull()
  },
)

it('连续新增字幕、修改与重建各自可撤销，空时间草稿失焦恢复保存值', async () => {
  const f = await subtitleSetup()
  await f.user.click(screen.getByRole('button', { name: '按当前台词创建字幕' }))
  const add = screen.getByRole('button', { name: '新增字幕' })
  await f.user.click(add)
  await f.user.click(add)
  const texts = () =>
    screen.getAllByRole<HTMLTextAreaElement>('textbox', { name: /镜头 1 字幕 \d 文本/ })
  expect(texts()).toHaveLength(3)
  await f.user.click(texts()[2]!)
  fireEvent.change(texts()[2]!, { target: { value: '独立新字幕' } })
  await f.user.click(screen.getByRole('button', { name: '回到开头' }))
  act(() => f.engine.undo())
  expect(texts()[2]!.value).toBe('新字幕')
  act(() => f.engine.undo())
  expect(texts()).toHaveLength(2)
  act(() => f.engine.undo())
  expect(texts()).toHaveLength(1)
  act(() => {
    f.engine.redo()
    f.engine.redo()
    f.engine.redo()
  })
  expect(texts()[2]!.value).toBe('独立新字幕')
  const before = f.params().subtitleTrack
  await f.user.click(screen.getByRole('button', { name: '按当前台词重建字幕（替换手改）' }))
  expect(texts()).toHaveLength(1)
  act(() => f.engine.undo())
  expect(f.params().subtitleTrack).toEqual(before)
  const start = field('镜头 1 字幕 1 开始（秒）')
  await f.user.clear(start)
  expect(start.value).toBe('')
  expect(start.getAttribute('aria-invalid')).toBe('true')
  await f.user.tab()
  expect(start.value).toBe('0')
  expect(f.params().subtitleTrack).toEqual(before)
})

it('时间线全局 Space 播放暂停，Home 和 End 定位且不修改剪辑', async () => {
  vi.useFakeTimers()
  const f = setup()
  const timeline = screen.getByRole('region', { name: '时间线' })
  const time = screen.getByTestId('preview').querySelector('.seq-time')!
  const original = structuredClone(f.params())
  act(() => timeline.focus())
  await f.user.keyboard(' ')
  expect(screen.getByRole('button', { name: '暂停' })).toBeTruthy()
  await f.user.keyboard(' ')
  expect(screen.getByRole('button', { name: '播放' })).toBeTruthy()
  await f.user.keyboard('{End}')
  expect(time.textContent).toBe('0:03.0 / 0:03.0')
  await f.user.keyboard('{Home}')
  expect(time.textContent).toBe('0:00.0 / 0:03.0')
  expect(document.activeElement).toBe(timeline)
  expect(f.params()).toEqual(original)
})

it('文本框 Space 保留文本输入，缩放 range 的 Arrow Home End 不控制全局播放头', async () => {
  vi.useFakeTimers()
  const f = await videoSetup()
  const timeline = screen.getByRole('region', { name: '时间线' })
  const time = screen.getByTestId('preview').querySelector('.seq-time')!
  act(() => timeline.focus())
  await f.user.keyboard('{Shift>}{ArrowRight}{/Shift}')
  expect(time.textContent).toBe('0:01.0 / 0:01.8')
  const subtitle = screen.getByRole<HTMLInputElement>('textbox', { name: '字幕' })
  await f.user.click(subtitle)
  await f.user.keyboard('{End} ')
  expect(subtitle.value).toBe('初始字幕 ')
  expect(clip(f).subtitle).toBe('初始字幕')
  expect(screen.getByRole('button', { name: '播放' })).toBeTruthy()
  expect(time.textContent).toBe('0:01.0 / 0:01.8')
  act(() => timeline.focus())
  await f.user.keyboard(' ')
  expect(screen.getByRole('button', { name: '暂停' })).toBeTruthy()
  const zoom = screen.getByRole<HTMLInputElement>('slider', { name: '缩放' })
  expect(zoom.type).toBe('range')
  act(() => zoom.focus())
  for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) {
    // DOM 层验证事件仍可交给原生range，不声称happy-dom实现浏览器滑杆步进。
    expect(fireEvent.keyDown(zoom, { key })).toBe(true)
    expect(time.textContent).toBe('0:01.0 / 0:01.8')
    expect(screen.getByRole('button', { name: '暂停' })).toBeTruthy()
  }
  expect(document.activeElement).toBe(zoom)
})
