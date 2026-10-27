// @vitest-environment happy-dom
import type { StoryboardBatchPlan, StoryboardBatchRequest } from '@plein/protocol'
import { useEffect, useState } from 'react'
import { expect, it } from 'vite-plus/test'
import { mockFetch } from '../../testing/fetch'
import { act, fireEvent, renderApp, screen, waitFor, within } from '../../testing/render'
import { Modal, ModalHeader } from '../../ui/Modal'
import { StoryboardEditor } from './StoryboardEditor'
import { storyboardFixture } from './testing'

async function setup(expanded = true) {
  const f = storyboardFixture({ count: 1, expanded })
  const requests: StoryboardBatchRequest[] = []
  mockFetch(async (request) => {
    if (
      new URL(request.url).pathname.endsWith('/storyboard-batch/preview') &&
      request.method === 'POST'
    ) {
      const body = (await request.json()) as StoryboardBatchRequest
      requests.push(body)
      return Response.json({
        token: 'plan',
        expiresAt: Date.now() + 10000,
        sourceId: f.board,
        request: body,
        rows: [],
        summary: { run: 0, reuse: 0, blocked: 0, skip: 0, calls: 0, prices: [], unknownCalls: 0 },
      } satisfies StoryboardBatchPlan)
    }
  })
  let showTop!: (open: boolean) => void
  function Harness() {
    const [top, setTop] = useState(false)
    useEffect(() => {
      showTop = setTop
    }, [])
    return (
      <>
        <StoryboardEditor />
        {top && (
          <Modal label="上层窗口" top onClose={() => setTop(false)}>
            <ModalHeader title="上层窗口" onClose={() => setTop(false)} />
          </Modal>
        )}
      </>
    )
  }
  const app = renderApp(<Harness />)
  await app.user.click(screen.getByRole('button', { name: '详细卡片' }))
  const trigger = () => screen.getByRole<HTMLButtonElement>('button', { name: '全部重新生成' })
  const menu = () => screen.findByRole('menu', { name: '全部重新生成' })
  return { ...f, ...app, requests, trigger, menu, showTop: () => act(() => showTop(true)) }
}

it('未展开节点禁用重新生成入口', async () => {
  const f = await setup(false)
  expect(f.trigger().disabled).toBe(true)
  expect(screen.queryByRole('menu')).toBeNull()
  expect(f.requests).toEqual([])
})

it('菜单 Esc 仅收起菜单、还原焦点，按钮上的撤销重做仍作用于文档', async () => {
  const f = await setup()
  const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '画面' })
  fireEvent.change(input, { target: { value: '菜单前修改' } })
  fireEvent.blur(input)
  act(f.flush)
  await f.user.click(f.trigger())
  await f.menu()
  await f.user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  expect(screen.getByRole('dialog', { name: '分镜表' })).toBeDefined()
  expect(document.activeElement).toBe(f.trigger())
  fireEvent.keyDown(f.trigger(), { key: 'z', ctrlKey: true })
  expect(input.value).toBe('画面1')
  fireEvent.keyDown(f.trigger(), { key: 'z', ctrlKey: true, shiftKey: true })
  expect(input.value).toBe('菜单前修改')
  expect(f.requests).toEqual([])
})

it.each([
  ['分镜图', 'image'],
  ['视频', 'video'],
  ['配音', 'speech'],
  ['音效', 'sfx'],
] as const)('重新生成 %s 只请求对应清单，取消不提交并可再次打开', async (label, role) => {
  const f = await setup()
  for (let attempt = 0; attempt < 2; attempt++) {
    await f.user.click(f.trigger())
    await f.user.click(within(await f.menu()).getByRole('menuitem', { name: label }))
    const checklist = await screen.findByRole('dialog', { name: '批量生成清单' })
    await within(checklist).findByLabelText('清单汇总')
    expect(f.requests.at(-1)).toEqual({ shotIds: ['shot-1'], role, reuseExisting: false })
    expect(checklist.contains(document.activeElement)).toBe(true)
    await f.user.click(within(checklist).getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '批量生成清单' })).toBeNull())
    expect(document.activeElement).toBe(f.trigger())
  }
  expect(f.requests).toHaveLength(2)
})

it.each([false, true])('上层窗口出现时菜单让位，待展开=%s，不抢按键或丢失编辑', async (pending) => {
  const f = await setup()
  if (pending) {
    const trigger = f.trigger()
    fireEvent.pointerDown(trigger, { button: 0 })
    f.showTop()
    fireEvent.click(trigger)
  } else {
    await f.user.click(f.trigger())
    await f.menu()
    f.showTop()
  }
  const top = await screen.findByRole('dialog', { name: '上层窗口' })
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  await f.user.click(within(top).getByRole('button', { name: '关闭' }))
  expect(screen.getByRole('dialog', { name: '分镜表' })).toBeDefined()
  await f.user.click(f.trigger())
  await f.menu()
  await f.user.keyboard('{Escape}')
  expect(f.requests).toEqual([])
})

it('菜单方向键 Home / End 导航，外部点击只收起菜单', async () => {
  const f = await setup()
  f.trigger().focus()
  await f.user.keyboard('{ArrowDown}')
  const menu = within(await f.menu())
  expect(document.activeElement).toBe(menu.getByRole('menuitem', { name: '分镜图' }))
  await f.user.keyboard('{End}')
  expect(document.activeElement).toBe(menu.getByRole('menuitem', { name: '音效' }))
  await f.user.keyboard('{Home}')
  expect(document.activeElement).toBe(menu.getByRole('menuitem', { name: '分镜图' }))
  await f.user.click(screen.getByRole('heading', { name: '分镜测试' }))
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  expect(screen.getByRole('dialog', { name: '分镜表' })).toBeDefined()
})

it.each(['sync', 'batch'])('%s 子窗口叠加上层窗口，Esc 逐层关闭并恢复焦点', async (kind) => {
  const f = await setup()
  const input = screen.getByRole('textbox', { name: '分镜图提示词' })
  fireEvent.change(input, { target: { value: '计划修改' } })
  fireEvent.blur(input)
  act(f.flush)
  await f.user.click(
    screen.getByRole('button', { name: kind === 'sync' ? /^查看差异/ : '批量出分镜图' }),
  )
  const child = await screen.findByRole('dialog', {
    name: kind === 'sync' ? '计划差异' : '批量生成清单',
  })
  if (kind === 'batch') await within(child).findByLabelText('清单汇总')
  const close = within(child).getByRole('button', { name: '关闭' })
  close.focus()
  f.showTop()
  const top = await screen.findByRole('dialog', { name: '上层窗口' })
  within(top).getByRole('button', { name: '关闭' }).focus()
  await f.user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '上层窗口' })).toBeNull())
  expect(document.activeElement).toBe(close)
  await f.user.keyboard('{Escape}')
  await waitFor(() =>
    expect(
      screen.queryByRole('dialog', { name: kind === 'sync' ? '计划差异' : '批量生成清单' }),
    ).toBeNull(),
  )
  expect(screen.getByRole('dialog', { name: '分镜表' })).toBeDefined()
  await f.user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '分镜表' })).toBeNull())
})
