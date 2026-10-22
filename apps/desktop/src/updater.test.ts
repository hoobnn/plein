import type { BrowserWindow } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

const desktop = vi.hoisted(() => ({
  canUpdate: vi.fn(() => true),
  showMessageBox: vi.fn((..._args: unknown[]) => Promise.resolve({ response: 1 })),
}))
vi.mock('electron', () => ({
  app: { isPackaged: true, getAppPath: () => '/Applications/Plein.app', getVersion: () => '0.3.0' },
  dialog: { showMessageBox: desktop.showMessageBox },
}))
vi.mock('electron-updater', async () => {
  const { EventEmitter } = await import('node:events')
  const autoUpdater = Object.assign(new EventEmitter(), {
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(() => Promise.resolve(null)),
    quitAndInstall: vi.fn(),
  })
  return { default: { autoUpdater } }
})
vi.mock('./profile', () => ({ canUpdate: desktop.canUpdate, readProfile: () => 'production' }))

const { setupUpdater } = await import('./updater')
const { autoUpdater: updater } = (await import('electron-updater')).default as unknown as {
  autoUpdater: import('node:events').EventEmitter & {
    checkForUpdates: ReturnType<typeof vi.fn>
    quitAndInstall: ReturnType<typeof vi.fn>
  }
}
const { showMessageBox } = desktop

function setup() {
  const send = vi.fn()
  const setProgressBar = vi.fn()
  const win = { isDestroyed: () => false, setProgressBar, webContents: { send } }
  const { check } = setupUpdater(() => win as unknown as BrowserWindow)
  return { check: check!, send, setProgressBar }
}
const messages = () =>
  showMessageBox.mock.calls.map((call) => (call.at(-1) as { message: string }).message)

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  updater.removeAllListeners()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.clearAllMocks()
  vi.restoreAllMocks()
  desktop.canUpdate.mockReturnValue(true)
})

describe('自动更新', () => {
  it('不满足更新条件时不检查，也不提供菜单入口', () => {
    desktop.canUpdate.mockReturnValue(false)
    expect(setupUpdater(() => null).check).toBeNull()
    vi.advanceTimersByTime(24 * 60 * 60 * 1000)
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('后台定时检查没有新版本或出错时不打扰用户，出错收起进度', () => {
    const { send, setProgressBar } = setup()
    vi.advanceTimersByTime(15_000)
    expect(updater.checkForUpdates).toHaveBeenCalledOnce()
    updater.emit('update-not-available')
    updater.emit('error', new Error('网络断开'))
    expect(showMessageBox).not.toHaveBeenCalled()
    expect(setProgressBar).toHaveBeenLastCalledWith(-1)
    expect(send).toHaveBeenLastCalledWith('plein:update-progress', null)
    vi.advanceTimersByTime(6 * 60 * 60 * 1000)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2)
  })

  it('手动检查的结果只提示一次，之后的后台结果不再弹窗', () => {
    const { check } = setup()
    check()
    updater.emit('update-not-available')
    updater.emit('update-not-available')
    check()
    updater.emit('error', new Error('证书无效'))
    updater.emit('error', new Error('证书无效'))
    expect(messages()).toEqual(['已经是最新版本', '检查更新失败'])
  })

  it('下载进度带上版本号，同一版本下载完成只提示一次，只有立即重启才安装', async () => {
    const { send, setProgressBar } = setup()
    updater.emit('update-available', { version: '0.3.1' })
    const progress = { percent: 40, transferred: 4, total: 10, bytesPerSecond: 2 }
    updater.emit('download-progress', progress)
    expect(send).toHaveBeenLastCalledWith('plein:update-progress', {
      version: '0.3.1',
      ...progress,
    })
    expect(setProgressBar).toHaveBeenLastCalledWith(0.4)
    updater.emit('update-downloaded', { version: '0.3.1' })
    updater.emit('update-downloaded', { version: '0.3.1' })
    await vi.advanceTimersByTimeAsync(0)
    expect(messages()).toEqual(['新版本 0.3.1 已下载'])
    expect(send).toHaveBeenLastCalledWith('plein:update-progress', null)
    expect(updater.quitAndInstall).not.toHaveBeenCalled()

    showMessageBox.mockResolvedValueOnce({ response: 0 })
    updater.emit('update-downloaded', { version: '0.3.2' })
    await vi.advanceTimersByTimeAsync(0)
    expect(updater.quitAndInstall).toHaveBeenCalledOnce()
  })

  it('已经下载好时，菜单检查直接提示重启，不再重新检查', () => {
    const { check } = setup()
    updater.emit('update-downloaded', { version: '0.3.1' })
    showMessageBox.mockClear()
    check()
    expect(messages()).toEqual(['新版本 0.3.1 已下载'])
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
  })
})
