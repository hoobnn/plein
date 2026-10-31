// @vitest-environment happy-dom
import type { DesktopUpdatePreferences } from '@plein/protocol'
import { beforeEach, expect, it, vi } from 'vite-plus/test'
import { renderApp, screen, waitFor } from '../testing/render'
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
