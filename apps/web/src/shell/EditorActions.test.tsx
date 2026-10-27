// @vitest-environment happy-dom
import { expect, it, vi } from 'vite-plus/test'
import { act, fireEvent, renderApp, resetStoreAfterEach, screen, waitFor } from '../testing/render'
import { mockMatchMedia } from '../testing/browser'
import { EditorActions } from './EditorActions'
import { useTheme } from '../stores/theme'
import { useCheckpoints } from '../features/checkpoints/store'

resetStoreAfterEach(useCheckpoints)

it('画布项目信息就绪后检查点入口启用，并传递当前项目和画布', async () => {
  const { user, rerender } = renderApp(
    <EditorActions remote canvasId="canvas" onOpenSettings={() => {}} />,
  )
  const button = screen.getByRole<HTMLButtonElement>('button', { name: '检查点' })
  expect(button.disabled).toBe(true)
  await user.click(button)
  expect(useCheckpoints.getState().open).toBeNull()
  await user.click(screen.getByRole('button', { name: '画布工具' }))
  const item = screen.getByRole('menuitem', { name: '检查点' })
  expect(item.getAttribute('aria-disabled')).toBe('true')
  rerender(<EditorActions remote projectId="project" canvasId="canvas" onOpenSettings={() => {}} />)
  expect(button.disabled).toBe(false)
  expect(item.getAttribute('aria-disabled')).not.toBe('true')
  await user.click(item)
  expect(useCheckpoints.getState().open).toEqual({ projectId: 'project', canvasId: 'canvas' })
})

it('紧凑工具可打开设置、切换主题，恢复宽窗口后清理菜单状态', async () => {
  const media = mockMatchMedia((query) => query === '(prefers-reduced-motion: reduce)')
  const settings = vi.fn()
  const { user } = renderApp(
    <EditorActions remote projectId="project" canvasId="canvas" onOpenSettings={settings} />,
  )
  const trigger = screen.getByRole('button', { name: '画布工具' })
  await user.click(trigger)
  await user.click(screen.getByRole('menuitemradio', { name: '深色' }))
  expect(useTheme.getState().pref).toBe('dark')
  expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  await user.click(trigger)
  await user.click(screen.getByRole('menuitem', { name: '设置' }))
  expect(settings).toHaveBeenCalledTimes(1)
  await user.click(trigger)
  act(() => media.set('(min-width: 1280px)', true))
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  act(() => media.set('(min-width: 1280px)', false))
  expect(screen.queryByRole('menu')).toBeNull()
  await user.click(trigger)
  trigger.focus()
  for (const key of ['z', 'y'])
    expect(fireEvent.keyDown(trigger, { key, ctrlKey: true })).toBe(false)
  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  expect(document.activeElement).toBe(trigger)
})

it('本地演示无远程工具也可切换主题，不发送网络请求', async () => {
  const { user } = renderApp(
    <EditorActions remote={false} canvasId={null} onOpenSettings={() => {}} />,
  )
  await user.click(screen.getByRole('button', { name: '深色' }))
  expect(useTheme.getState().pref).toBe('dark')
  expect(screen.queryByRole('button', { name: '设置' })).toBeNull()
  await user.click(screen.getByRole('button', { name: '画布工具' }))
  expect(screen.queryByRole('menuitem', { name: '资产库' })).toBeNull()
})
