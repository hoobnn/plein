// @vitest-environment happy-dom
import type { DesktopUpdatePreferences } from '@plein/protocol'
import { beforeEach, expect, it, vi } from 'vite-plus/test'
import { act, renderApp, screen, waitFor, within } from '../testing/render'
import { useUpdate } from './desktopUpdateState'
import { UpdateContent } from './DesktopUpdates'

const bridge = vi.hoisted(() => ({
  preferences: { checkOnLaunch: true, intervalHours: 6 } as DesktopUpdatePreferences,
  getUpdatePreferences: vi.fn(async () => bridge.preferences),
  setUpdatePreferences: vi.fn(async (next: DesktopUpdatePreferences) => next),
}))
vi.mock('../desktop', () => ({ desktop: bridge }))

beforeEach(() => {
  bridge.preferences = { checkOnLaunch: true, intervalHours: 6 }
  bridge.getUpdatePreferences.mockImplementation(async () => bridge.preferences)
  bridge.setUpdatePreferences.mockImplementation(async (next: DesktopUpdatePreferences) => next)
  bridge.getUpdatePreferences.mockClear()
  bridge.setUpdatePreferences.mockClear()
  useUpdate.setState({
    state: null,
    preferences: null,
    open: false,
    pending: null,
    bridgeError: null,
  })
})

it('可以改启动检查开关和检查频率，并看到上次与下次检查时间', async () => {
  useUpdate.setState({
    state: {
      phase: 'idle',
      currentVersion: '2.1.0',
      checkedAt: Date.now() - 5 * 60 * 1000,
      nextCheckAt: Date.now() + 6 * 60 * 60 * 1000,
    },
  })
  const { user } = renderApp(<UpdateContent />)
  await waitFor(() => expect(bridge.getUpdatePreferences).toHaveBeenCalled())

  const toggle = screen.getByRole('switch', { name: '启动时自动检查更新' })
  expect(toggle.getAttribute('aria-checked')).toBe('true')
  await user.click(toggle)
  await waitFor(() =>
    expect(bridge.setUpdatePreferences).toHaveBeenCalledWith({
      checkOnLaunch: false,
      intervalHours: 6,
    }),
  )

  await user.click(screen.getByRole('combobox', { name: '应用打开期间检查频率' }))
  await user.click(screen.getByRole('option', { name: '每小时' }))
  await waitFor(() =>
    expect(bridge.setUpdatePreferences).toHaveBeenCalledWith({
      checkOnLaunch: false,
      intervalHours: 1,
    }),
  )

  expect(screen.getByText(/^上次检查：/).textContent).toContain('5分钟前')
  expect(screen.getByText(/^下次检查：/).textContent).not.toBe('下次检查：不定期')
})

it('上次检查的相对时间会随时间更新', async () => {
  vi.useFakeTimers()
  useUpdate.setState({
    state: {
      phase: 'idle',
      currentVersion: '2.1.0',
      checkedAt: Date.now() - 5 * 60 * 1000,
    },
  })
  renderApp(<UpdateContent />)
  await waitFor(() => expect(bridge.getUpdatePreferences).toHaveBeenCalled())
  expect(screen.getByText(/^上次检查：/).textContent).toContain('5分钟前')
  await act(async () => {
    await vi.advanceTimersByTimeAsync(90_000)
  })
  expect(screen.getByText(/^上次检查：/).textContent).toContain('6分钟前')
})

it('不提供自动更新的环境里禁用开关和频率，并说明正式版生效', async () => {
  useUpdate.setState({
    state: {
      phase: 'unavailable',
      currentVersion: '2.1.0',
      reason: '开发环境不提供自动更新。',
    },
  })
  renderApp(<UpdateContent />)
  await waitFor(() => expect(bridge.getUpdatePreferences).toHaveBeenCalled())
  expect(screen.getByText('当前环境不提供自动更新，这里的设置在正式版生效。')).toBeTruthy()
  expect(screen.getByRole('switch', { name: '启动时自动检查更新' }).hasAttribute('disabled')).toBe(
    true,
  )
  expect(
    screen.getByRole('combobox', { name: '应用打开期间检查频率' }).hasAttribute('disabled'),
  ).toBe(true)
})

it('读取偏好失败时给出重试入口，写入成功后清掉旧错误', async () => {
  bridge.getUpdatePreferences.mockRejectedValueOnce(new Error('主进程暂时不可用'))
  useUpdate.setState({
    state: { phase: 'idle', currentVersion: '2.1.0' },
    bridgeError: '上次的错误',
  })
  const { user } = renderApp(<UpdateContent />)
  await waitFor(() => expect(screen.getByText(/读取检查偏好失败/)).toBeTruthy())
  const section = screen.getByRole('region', { name: '更新检查计划' })
  expect(within(section).getByRole('alert').textContent).toContain('主进程暂时不可用')

  await user.click(screen.getByRole('button', { name: '重试读取' }))
  await waitFor(() =>
    expect(screen.getByRole('switch', { name: '启动时自动检查更新' })).toBeTruthy(),
  )
  // 写入成功后不再残留旧错误
  await user.click(screen.getByRole('switch', { name: '启动时自动检查更新' }))
  await waitFor(() => expect(bridge.setUpdatePreferences).toHaveBeenCalled())
  expect(useUpdate.getState().bridgeError).toBeNull()
})
