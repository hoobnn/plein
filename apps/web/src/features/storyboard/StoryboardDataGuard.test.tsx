// @vitest-environment happy-dom
import { createElement } from '@plein/doc'
import { expect, it } from 'vite-plus/test'
import { useCanvas } from '../../stores/canvas'
import { act, fireEvent, renderApp, screen, within } from '../../testing/render'
import { StoryboardEditor } from './StoryboardEditor'
import { storyboardFixture } from './testing'

function setup() {
  const f = storyboardFixture()
  const app = renderApp(<StoryboardEditor />)
  const problem = () => within(screen.getByRole('dialog', { name: '分镜数据问题' }))
  const change = (raw: unknown) =>
    act(() => {
      f.write(raw)
      f.flush()
    })
  return { ...f, ...app, problem, change }
}

it('损坏行保留原始数据，只修复无效字段，撤销重做恢复原值', async () => {
  const f = setup()
  const before = f.doc.get(f.board)!.params!.shots as Record<string, unknown>[]
  const broken = [before[0], { ...before[1], duration: -2, custom: 'keep' }]
  f.change(broken)
  expect(f.problem().getByRole('alert').textContent).toContain('第 2 行')
  expect(f.doc.get(f.board)!.params!.shots).toEqual(broken)
  await f.user.click(f.problem().getByRole('button', { name: '关闭' }))
  act(() => useCanvas.getState().openStoryboard(f.board))
  await f.user.click(f.problem().getByRole('button', { name: '恢复第 2 行无效字段' }))
  expect(f.doc.get(f.board)!.params!.shots).toEqual([
    before[0],
    { ...before[1], duration: 5, custom: 'keep' },
  ])
  act(() => f.engine.undo())
  expect(f.doc.get(f.board)!.params!.shots).toEqual(broken)
  await f.user.click(f.problem().getByRole('button', { name: '重做' }))
  expect(screen.getByRole('dialog', { name: '分镜表' })).toBeDefined()
})

it('坏台词列表说明整体恢复，只读不能恢复，重置整表后可撤销并继续添加', async () => {
  const f = setup()
  const before = f.doc.get(f.board)!.params!.shots as Record<string, unknown>[]
  const broken = [before[0], { ...before[1], dialogue: [{ character: '甲', line: 7 }] }]
  f.doc.readOnly = true
  // 协作更新直接到文档；只读只限制用户操作。
  ;(f.doc.mutable(f.board)!.get('params') as { set(key: string, value: unknown): void }).set(
    'shots',
    broken,
  )
  act(f.flush)
  expect(f.problem().getByText(/台词列表会整体重置/)).toBeDefined()
  expect(
    f.problem().getByRole<HTMLButtonElement>('button', { name: '恢复第 2 行无效字段' }).disabled,
  ).toBe(true)
  expect(f.problem().getByRole<HTMLButtonElement>('button', { name: '撤销' }).disabled).toBe(true)
  f.doc.readOnly = false
  f.doc.mutable(f.board)!.set('name', '恢复可写')
  act(f.flush)
  await f.user.click(f.problem().getByRole('button', { name: '恢复第 2 行无效字段' }))
  expect(f.doc.get(f.board)!.params!.shots).toEqual([before[0], { ...before[1], dialogue: [] }])
  f.change(null)
  expect(f.problem().getByText(/重置会将损坏的镜头列表清空/)).toBeDefined()
  await f.user.click(f.problem().getByRole('button', { name: '重置镜头列表' }))
  expect(f.read()).toEqual([])
  act(() => f.engine.undo())
  expect(f.doc.get(f.board)!.params!.shots).toBeNull()
  await f.user.click(f.problem().getByRole('button', { name: '重做' }))
  await f.user.click(screen.getByRole('button', { name: '添加镜头' }))
  expect(f.read()).toHaveLength(1)
})

it('重复与空标识修复不改变已有素材关联，重做保留生成的标识', async () => {
  const f = setup()
  const before = f.read()
  const source = { storyboard: f.board, shot: before[0]!.id, role: 'image' }
  const material = createElement(f.doc, {
    kind: 'node',
    nodeType: 'plein/image',
    params: { source },
    x: 500,
    y: 0,
    w: 200,
    h: 200,
  })
  f.change([
    before[0],
    { ...before[1], id: before[0]!.id },
    { id: '', no: 3, description: '第三镜' },
  ])
  expect(f.problem().getAllByText(/已有素材仍关联原标识/)).toHaveLength(2)
  for (const row of [2, 3])
    await f.user.click(f.problem().getByRole('button', { name: `恢复第 ${row} 行无效字段` }))
  const fixed = f.read()
  expect(new Set(fixed.map((s) => s.id)).size).toBe(3)
  expect(fixed[0]).toEqual(before[0])
  expect(f.doc.get(material)!.params!.source).toEqual(source)
  act(() => f.engine.undo())
  expect(f.problem().getByRole('alert').textContent).toContain('第 3 行')
  await f.user.click(f.problem().getByRole('button', { name: '重做' }))
  expect(f.read()).toEqual(fixed)
  expect(f.doc.get(material)!.params!.source).toEqual(source)
})

it('旧添加及恢复按钮拒绝未通知的坏数据与协作内容，核对后可恢复', async () => {
  const f = setup()
  const before = f.read()
  const broken = [before[0], { ...before[1], duration: -2 }]
  f.write(broken)
  fireEvent.click(screen.getByRole('button', { name: '添加镜头' }))
  expect(f.doc.get(f.board)!.params!.shots).toEqual(broken)
  act(f.flush)
  const restore = f.problem().getByRole('button', { name: '恢复第 2 行无效字段' })
  const changed = [{ ...before[0], description: '协作写入' }, broken[1]]
  f.write(changed)
  fireEvent.click(restore)
  expect(useCanvas.getState().notice).toContain('数据已变化')
  expect(f.doc.get(f.board)!.params!.shots).toEqual(changed)
  act(f.flush)
  await f.user.click(restore)
  expect(f.doc.get(f.board)!.params!.shots).toEqual([changed[0], { ...before[1], duration: 5 }])
})

it('删除确认期间其他镜头损坏，不删除镜头或脱离已有素材', async () => {
  const f = storyboardFixture({ expanded: true })
  const { user } = renderApp(<StoryboardEditor />)
  await user.click(screen.getByRole('button', { name: '删除镜头 1' }))
  const confirmation = await screen.findByRole('dialog', { name: '删除镜头 01？' })
  const button = within(confirmation).getByRole('button', { name: '删除镜头' })
  const materials = [...f.doc.elements()].filter((el) => el.id !== f.board)
  const broken = f.read().map((s, i) => (i ? { ...s, duration: -2 } : s))
  f.write(broken)
  fireEvent.click(button)
  act(f.flush)
  expect(screen.getByRole('dialog', { name: '分镜数据问题' })).toBeDefined()
  expect(f.doc.get(f.board)!.params!.shots).toEqual(broken)
  expect([...f.doc.elements()].filter((el) => el.id !== f.board)).toEqual(materials)
})
