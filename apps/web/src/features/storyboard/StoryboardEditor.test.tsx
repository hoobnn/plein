// @vitest-environment happy-dom
import { createElement } from '@plein/doc'
import { expect, it } from 'vite-plus/test'
import { useCanvas } from '../../stores/canvas'
import { act, fireEvent, renderApp, screen, waitFor, within } from '../../testing/render'
import { StoryboardEditor } from './StoryboardEditor'
import { storyboardFixture } from './testing'

async function setup(options?: Parameters<typeof storyboardFixture>[0]) {
  const f = storyboardFixture(options)
  const rendered = renderApp(<StoryboardEditor />)
  await rendered.user.click(screen.getByRole('button', { name: '详细卡片' }))
  return { ...f, ...rendered, dialog: () => within(screen.getByRole('dialog', { name: '分镜表' })) }
}

it('同帧提交文本和另一行时长合并最新文档，清空及越界时长不丢镜头', async () => {
  const f = await setup()
  const descriptions = f.dialog().getAllByRole<HTMLTextAreaElement>('textbox', { name: '画面' })
  const durations = f.dialog().getAllByRole<HTMLInputElement>('spinbutton', { name: '时长' })
  fireEvent.change(descriptions[1]!, { target: { value: '第二镜新画面' } })
  fireEvent.blur(descriptions[1]!)
  fireEvent.change(durations[0]!, { target: { value: '31' } })
  expect(f.read()[1]!.description).toBe('第二镜新画面')
  expect(f.read()[0]!.duration).toBe(30)
  act(f.flush)
  fireEvent.blur(durations[0]!)
  expect(durations[0]!.value).toBe('30')
  fireEvent.change(durations[0]!, { target: { value: '-2' } })
  act(f.flush)
  fireEvent.blur(durations[0]!)
  expect(durations[0]!.value).toBe('1')
  fireEvent.change(durations[0]!, { target: { value: '' } })
  expect(durations[0]!.value).toBe('')
  fireEvent.blur(durations[0]!)
  expect(durations[0]!.value).toBe('1')
  fireEvent.change(durations[0]!, { target: { value: '2.5' } })
  expect(f.read()).toHaveLength(2)
  expect(f.read()[0]).toMatchObject({ duration: 2.5, description: '画面1' })
})

it.each([
  ['description', '画面', '同伴画面', '本机画面'],
  ['imagePrompt', '分镜图提示词', '同伴提示词', '本机提示词'],
  ['characters', '出场', ['同伴角色'], '@本机角色'],
] as const)('%s 同帧协作更新不被失焦覆盖，显式保留后才写入', async (key, label, remote, mine) => {
  const f = await setup()
  const input = f.dialog().getAllByRole<HTMLTextAreaElement>('textbox', { name: label })[0]!
  fireEvent.change(input, { target: { value: mine } })
  f.write(f.read().map((shot, i) => (i === 0 ? { ...shot, [key]: remote } : shot)))
  fireEvent.blur(input)
  expect(f.read()[0]![key]).toEqual(remote)
  act(f.flush)
  expect(input.value).toBe(mine)
  const cell = within(input.closest('[data-storyboard-field]') as HTMLElement)
  expect(cell.getByRole('status').textContent).toContain('已在其他位置更新')
  await f.user.click(cell.getByRole('button', { name: '保留当前输入' }))
  expect(f.read()[0]![key]).toEqual(key === 'characters' ? ['本机角色'] : mine)
  expect(document.activeElement).toBe(input)
})

it('仅聚焦时跟随远端文本；冲突选择最新内容不会产生反向写入', async () => {
  const f = await setup()
  const input = f.dialog().getAllByRole<HTMLTextAreaElement>('textbox', { name: '画面' })[0]!
  await f.user.click(input)
  act(() => {
    f.write(f.read().map((s, i) => (i === 0 ? { ...s, description: '远端画面' } : s)))
    f.flush()
  })
  fireEvent.blur(input)
  expect(input.value).toBe('远端画面')
  fireEvent.change(input, { target: { value: '本地草稿' } })
  act(() => {
    f.write(f.read().map((s, i) => (i === 0 ? { ...s, description: '第二次远端画面' } : s)))
    f.flush()
  })
  await f.user.click(screen.getByRole('button', { name: '使用最新内容' }))
  expect(input.value).toBe('第二次远端画面')
  expect(f.read()[0]!.description).toBe('第二次远端画面')
  expect(document.activeElement).toBe(input)
  expect(screen.queryByRole('status')).toBeNull()
})

it('两句台词在文档通知前连续提交，各自保留身份及内容', async () => {
  const f = await setup()
  const inputs = f.dialog().getAllByRole('textbox', { name: '台词' })
  fireEvent.change(inputs[0]!, { target: { value: '甲：第一句已改' } })
  fireEvent.blur(inputs[0]!)
  fireEvent.change(inputs[1]!, { target: { value: '乙：第二句已改' } })
  fireEvent.blur(inputs[1]!)
  expect(f.read()[0]!.dialogue).toEqual([
    { id: 'a', character: '甲', line: '第一句已改' },
    { id: 'b', character: '乙', line: '第二句已改' },
  ])
})

it.each(['update', 'move', 'delete'] as const)(
  '台词同帧 %s 后按稳定身份提交，不覆盖协作或复活删除项',
  async (operation) => {
    const f = await setup()
    const input = f.dialog().getAllByRole<HTMLTextAreaElement>('textbox', { name: '台词' })[0]!
    fireEvent.change(input, { target: { value: '甲：本机草稿\n乙：新增台词' } })
    const before = f.read()
    f.write(
      before.map((s, i) =>
        i
          ? s
          : {
              ...s,
              dialogue:
                operation === 'update'
                  ? s.dialogue.map((d) =>
                      d.id === 'a'
                        ? { ...d, line: '远端新台词', speaker: { elementId: 'speaker' } }
                        : d,
                    )
                  : operation === 'move'
                    ? [...s.dialogue].reverse()
                    : s.dialogue.filter((d) => d.id !== 'a'),
            },
      ),
    )
    fireEvent.blur(input)
    act(f.flush)
    if (operation === 'delete') {
      expect(f.read()[0]!.dialogue).toEqual([before[0]!.dialogue[1]])
      expect(f.dialog().getAllByRole('textbox', { name: '台词' })).toHaveLength(2)
    } else if (operation === 'move') {
      expect(
        f
          .read()[0]!
          .dialogue.map((d) => d.id)
          .slice(0, 2),
      ).toEqual(['b', 'a'])
      expect(f.read()[0]!.dialogue[1]!.line).toBe('本机草稿')
    } else {
      expect(f.read()[0]!.dialogue[0]!.line).toBe('远端新台词')
      await f.user.click(screen.getByRole('button', { name: '保留当前台词' }))
      expect(f.read()[0]!.dialogue[0]).toEqual({
        id: 'a',
        character: '甲',
        line: '本机草稿',
        speaker: { elementId: 'speaker' },
      })
      expect(f.read()[0]!.dialogue[1]).toMatchObject({ character: '乙', line: '新增台词' })
      expect(['a', 'b']).not.toContain(f.read()[0]!.dialogue[1]!.id)
      expect(f.read()[0]!.dialogue[2]).toEqual(before[0]!.dialogue[1])
    }
  },
)

it('台词仅聚焦跟随更新，冲突可选最新台词并恢复焦点', async () => {
  const f = await setup()
  const input = f.dialog().getAllByRole<HTMLTextAreaElement>('textbox', { name: '台词' })[0]!
  await f.user.click(input)
  const update = (line: string) => {
    f.write(
      f
        .read()
        .map((s, i) =>
          i ? s : { ...s, dialogue: s.dialogue.map((d) => (d.id === 'a' ? { ...d, line } : d)) },
        ),
    )
    f.flush()
  }
  act(() => update('远端一句'))
  fireEvent.blur(input)
  expect(input.value).toBe('甲：远端一句')
  fireEvent.change(input, { target: { value: '甲：本地草稿' } })
  act(() => update('远端二句'))
  await f.user.click(screen.getByRole('button', { name: '使用最新台词' }))
  expect(input.value).toBe('甲：远端二句')
  expect(document.activeElement).toBe(input)
  expect(f.read()[0]!.dialogue[0]!.line).toBe('远端二句')
})

it.each(['添加台词', '删除第 1 句', '下移第 1 句'])(
  '%s 与刚提交的另一句台词独立撤销',
  async (action) => {
    const f = await setup({ count: 1 })
    const second = f.dialog().getAllByRole('textbox', { name: '台词' })[1]!
    fireEvent.change(second, { target: { value: '乙：保留第二句修改' } })
    fireEvent.blur(second)
    const edited = f.read()[0]!.dialogue
    await f.user.click(f.dialog().getByRole('button', { name: action }))
    const after = f.read()[0]!.dialogue
    expect(after).not.toEqual(edited)
    act(() => f.engine.undo())
    expect(f.read()[0]!.dialogue).toEqual(edited)
    act(() => f.engine.redo())
    expect(f.read()[0]!.dialogue).toEqual(after)
  },
)

it('添加、移动及删除台词恢复相邻输入焦点，删除至空仍可重新编辑', async () => {
  const f = await setup({ count: 1 })
  await f.user.click(f.dialog().getByRole('button', { name: '添加台词' }))
  const input = screen.getAllByRole<HTMLTextAreaElement>('textbox', { name: '台词' })[2]!
  expect(document.activeElement).toBe(input)
  fireEvent.change(input, { target: { value: '甲：新增一句' } })
  fireEvent.blur(input)
  const added = f.read()[0]!.dialogue[2]
  await f.user.click(screen.getByRole('button', { name: '上移第 3 句' }))
  expect(f.read()[0]!.dialogue[1]).toEqual(added)
  expect(document.activeElement).toBe(screen.getAllByRole('textbox', { name: '台词' })[1])
  for (const label of ['删除第 2 句', '删除第 2 句', '删除第 1 句'])
    await f.user.click(screen.getByRole('button', { name: label }))
  const empty = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '台词' })
  expect(document.activeElement).toBe(empty)
  expect(empty.value).toBe('')
  fireEvent.change(empty, { target: { value: '甲：重新输入' } })
  fireEvent.blur(empty)
  expect(f.read()[0]!.dialogue[0]!.line).toBe('重新输入')
})

it.each([false, true])('审核模式 %s 添加镜头直接聚焦新画面', async (review) => {
  const f = await setup()
  if (review) await f.user.click(screen.getByRole('button', { name: '审核镜头' }))
  await f.user.click(screen.getByRole('button', { name: '添加镜头' }))
  const input = f.dialog().getAllByRole<HTMLTextAreaElement>('textbox', { name: '画面' }).at(-1)!
  expect(document.activeElement).toBe(input)
  fireEvent.change(input, { target: { value: '新增画面' } })
  fireEvent.blur(input)
  expect(f.read().at(-1)!.description).toBe('新增画面')
})

it('添加同帧撤销后重做不会消费过期焦点请求', async () => {
  const f = await setup()
  act(() => {
    fireEvent.click(screen.getByRole('button', { name: '添加镜头' }))
    f.engine.undo()
  })
  const input = screen.getAllByRole('textbox', { name: '画面' })[0]!
  await f.user.click(input)
  act(() => f.engine.redo())
  expect(screen.getAllByRole('article')).toHaveLength(3)
  expect(document.activeElement).toBe(input)
})

it.each([1, 2])('删除镜头 %i 后聚焦相邻镜头，最后一项删除后聚焦添加', async (no) => {
  const f = await setup()
  await f.user.click(screen.getByRole('button', { name: '收起全部镜头' }))
  await f.user.click(screen.getByRole('button', { name: `删除镜头 ${no}` }))
  expect(document.activeElement).toBe(screen.getByRole('button', { name: /^展开镜头 \d/ }))
  await f.user.click(screen.getByRole('button', { name: /^删除镜头 \d/ }))
  expect(document.activeElement).toBe(screen.getByRole('button', { name: '添加镜头' }))
  expect(f.read()).toEqual([])
})

it.each(['delete', 'add'] as const)('%s 镜头独立撤销，不撤回上一笔文本', async (action) => {
  const f = await setup()
  const input = screen.getAllByRole('textbox', { name: '画面' })[1]!
  fireEvent.change(input, { target: { value: '保留第二镜' } })
  fireEvent.blur(input)
  await f.user.click(
    screen.getByRole('button', { name: action === 'add' ? '添加镜头' : '删除镜头 1' }),
  )
  expect(f.read()).toHaveLength(action === 'add' ? 3 : 1)
  act(() => f.engine.undo())
  expect(f.read()).toHaveLength(2)
  expect(f.read()[1]!.description).toBe('保留第二镜')
  act(() => f.engine.redo())
  expect(f.read()).toHaveLength(action === 'add' ? 3 : 1)
  expect(f.read().find((s) => s.id === 'shot-2')!.description).toBe('保留第二镜')
})

it.each(['content', 'structure', 'readonly'] as const)(
  '删除确认期间 %s 变化拒绝旧操作，核对后可重试',
  async (change) => {
    const f = await setup({ expanded: true })
    await f.user.click(screen.getByRole('button', { name: '删除镜头 1' }))
    if (change === 'content')
      f.write(f.read().map((s, i) => (i ? s : { ...s, description: '远端新内容' })))
    else if (change === 'readonly') f.doc.readOnly = true
    else
      createElement(f.doc, {
        kind: 'node',
        nodeType: 'plein/image',
        params: { source: { storyboard: f.board, shot: 'shot-1', role: 'image' } },
        x: 1000,
        y: 0,
        w: 200,
        h: 100,
      })
    const before = [...f.doc.elements()]
    await f.user.click(
      within(await screen.findByRole('dialog', { name: '删除镜头 01？' })).getByRole('button', {
        name: '删除镜头',
      }),
    )
    expect(screen.getByRole('alert').textContent).toContain(
      change === 'readonly' ? '只读' : '已变化',
    )
    expect([...f.doc.elements()]).toEqual(before)
    f.doc.readOnly = false
    act(f.flush)
    await f.user.click(screen.getByRole('button', { name: '删除镜头 1' }))
    await f.user.click(
      within(await screen.findByRole('dialog', { name: '删除镜头 01？' })).getByRole('button', {
        name: '删除镜头',
      }),
    )
    expect(f.read()).toHaveLength(1)
    expect(
      [...f.doc.elements()]
        .filter((el) => (el.params?.source as { shot?: string })?.shot === 'shot-1')
        .every((el) => (el.params!.source as { detached?: boolean }).detached),
    ).toBe(true)
  },
)

it('已展开镜头取消无写入，确认后节点保留，撤销重做整体恢复关联', async () => {
  const f = await setup({ expanded: true })
  const before = [...f.doc.elements()]
  const remove = () => f.user.click(screen.getByRole('button', { name: '删除镜头 1' }))
  await remove()
  await f.user.click(screen.getByRole('button', { name: '取消' }))
  expect([...f.doc.elements()]).toEqual(before)
  await remove()
  const confirm = within(await screen.findByRole('dialog', { name: '删除镜头 01？' }))
  fireEvent.keyDown(confirm.getByRole('button', { name: '删除镜头' }), { key: 'z', ctrlKey: true })
  expect([...f.doc.elements()]).toEqual(before)
  await f.user.click(confirm.getByRole('button', { name: '删除镜头' }))
  const after = [...f.doc.elements()]
  expect(after.map((el) => el.id)).toEqual(before.map((el) => el.id))
  act(() => f.engine.undo())
  expect([...f.doc.elements()]).toEqual(before)
  act(() => f.engine.redo())
  expect([...f.doc.elements()]).toEqual(after)
})

it('折叠保留已提交内容和选择，复制计划切换隔离本地状态', async () => {
  const f = await setup()
  const input = screen.getAllByRole('textbox', { name: '画面' })[0]!
  await f.user.click(input)
  fireEvent.change(input, { target: { value: '折叠前草稿' } })
  await f.user.click(screen.getByRole('checkbox', { name: '选择镜头 1' }))
  await f.user.click(screen.getByRole('button', { name: '收起全部镜头' }))
  await f.user.click(screen.getByRole('button', { name: '展开全部镜头' }))
  expect((screen.getAllByRole('textbox', { name: '画面' })[0] as HTMLTextAreaElement).value).toBe(
    '折叠前草稿',
  )
  expect(screen.getByRole<HTMLInputElement>('checkbox', { name: '选择镜头 1' }).checked).toBe(true)
  const other = createElement(f.doc, {
    kind: 'node',
    nodeType: 'plein/storyboard',
    name: '复制计划',
    params: { shots: f.read() },
    x: 0,
    y: 400,
    w: 300,
    h: 200,
  })
  await f.user.click(screen.getByRole('button', { name: '收起全部镜头' }))
  act(() => useCanvas.getState().openStoryboard(other))
  expect(screen.getByRole<HTMLInputElement>('checkbox', { name: '选择镜头 1' }).checked).toBe(false)
  expect(screen.getByRole('button', { name: '收起镜头 1' })).toBeDefined()
  const otherInput = screen.getAllByRole('textbox', { name: '画面' })[0]!
  fireEvent.change(otherInput, { target: { value: '复制计划新内容' } })
  fireEvent.blur(otherInput)
  expect(f.read()[0]!.description).toBe('折叠前草稿')
})

it.each(['使用最新内容', '保留当前输入'])(
  '引用定位冲突先阻止离开，%s 后保存并定位',
  async (choice) => {
    const f = await setup({ count: 1 })
    const target = createElement(f.doc, {
      kind: 'node',
      nodeType: 'plein/character',
      name: '引用角色',
      params: {},
      x: 900,
      y: 0,
      w: 200,
      h: 200,
    })
    act(f.flush)
    const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '画面' })
    const mine = '草稿 @引用角色。'
    const remote = '远端 @引用角色。'
    fireEvent.change(input, { target: { value: mine } })
    act(() => {
      f.write([{ ...f.read()[0]!, description: remote }])
      f.flush()
    })
    input.setSelectionRange(4, 4)
    fireEvent.click(input, { ctrlKey: true })
    expect(useCanvas.getState().storyboard).toBe(f.board)
    expect(f.engine.selection.set).not.toHaveBeenCalled()
    expect(f.read()[0]!.description).toBe(remote)
    await f.user.click(screen.getByRole('button', { name: choice }))
    input.setSelectionRange(4, 4)
    fireEvent.click(input, { ctrlKey: true })
    expect(f.engine.selection.set).toHaveBeenCalledWith([target])
    expect(f.engine.zoomToFit).toHaveBeenCalledWith([target])
    expect(f.read()[0]!.description).toBe(choice === '保留当前输入' ? mine : remote)
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '分镜表' })).toBeNull())
  },
)

it('无冲突的引用定位先保存草稿，撤销重做恢复同一文本', async () => {
  const f = await setup({ count: 1 })
  createElement(f.doc, {
    kind: 'node',
    nodeType: 'plein/character',
    name: '引用角色',
    params: {},
    x: 900,
    y: 0,
    w: 200,
    h: 200,
  })
  act(f.flush)
  f.doc.undo.stopCapturing()
  const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '画面' })
  fireEvent.change(input, { target: { value: '草稿 @引用角色。' } })
  input.setSelectionRange(4, 4)
  fireEvent.click(input, { ctrlKey: true })
  expect(f.read()[0]!.description).toBe('草稿 @引用角色。')
  act(() => f.engine.undo())
  expect(f.read()[0]!.description).toBe('画面1')
  act(() => f.engine.redo())
  expect(f.read()[0]!.description).toBe('草稿 @引用角色。')
})
