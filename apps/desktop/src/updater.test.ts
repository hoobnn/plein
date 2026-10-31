import type { DesktopUpdateState } from '@plein/protocol'
import type { BrowserWindow } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

const desktop = vi.hoisted(() => ({
  canUpdate: vi.fn(() => true),
  readProfile: vi.fn(() => 'production'),
}))
const prefs = vi.hoisted(() => ({
  readUpdatePreferences: vi.fn(() => ({ checkOnLaunch: true, intervalHours: 6 })),
  writeUpdatePreferences: vi.fn((next: { checkOnLaunch: boolean; intervalHours: number }) => next),
}))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    app: {
      isPackaged: true,
      getAppPath: () => '/Applications/Plein.app',
      getVersion: () => '0.3.0',
    },
    autoUpdater: new EventEmitter(),
  }
})
vi.mock('electron-updater', async () => {
  const { EventEmitter } = await import('node:events')
  const autoUpdater = Object.assign(new EventEmitter(), {
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(() => Promise.resolve(null)),
    downloadUpdate: vi.fn(() => Promise.resolve([])),
    quitAndInstall: vi.fn(),
  })
  return { default: { autoUpdater } }
})
vi.mock('./profile', () => desktop)
vi.mock('./prefs', () => prefs)

const { setupUpdater } = await import('./updater')
const { autoUpdater: nativeUpdater } = await import('electron')
const { autoUpdater: updater } = (await import('electron-updater')).default as unknown as {
  autoUpdater: import('node:events').EventEmitter & {
    autoDownload: boolean
    autoInstallOnAppQuit: boolean
    fullChangelog: boolean
    setFeedURL: ReturnType<typeof vi.fn>
    checkForUpdates: ReturnType<typeof vi.fn>
    downloadUpdate: ReturnType<typeof vi.fn>
    quitAndInstall: ReturnType<typeof vi.fn>
  }
}

const info = {
  version: '0.3.2',
  releaseName: 'Plein 0.3.2',
  releaseDate: '2026-10-23T00:00:00.000Z',
  releaseNotes: [
    {
      version: '0.3.2',
      note: '## 新功能\n\n- 完整 **Markdown**\n<a href="https://example.com">详情</a>',
    },
    { version: '0.3.1', note: '修复上一版本的问题' },
  ],
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function setup(beforeInstall?: () => Promise<boolean>) {
  const send = vi.fn()
  const setProgressBar = vi.fn()
  let destroyed = false
  let closed = false
  const win = { isDestroyed: () => destroyed, setProgressBar, webContents: { send } }
  const controller = setupUpdater(
    () => (closed ? null : (win as unknown as BrowserWindow)),
    beforeInstall,
  )
  return {
    ...controller,
    check: controller.check!,
    send,
    setProgressBar,
    get installationRequested() {
      return controller.installationRequested
    },
    isDestroyed: () => destroyed,
    destroy: () => (destroyed = true),
    close: () => (closed = true),
  }
}

async function findUpdate(controller: ReturnType<typeof setup>, metadata = info) {
  updater.checkForUpdates.mockImplementationOnce(async () => {
    updater.emit('update-available', metadata)
    return { isUpdateAvailable: true, updateInfo: metadata }
  })
  await controller.checkForUpdates()
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-23T01:00:00.000Z'))
  vi.stubEnv('PLEIN_UPDATE', undefined)
  vi.stubEnv('PLEIN_UPDATE_URL', undefined)
  desktop.canUpdate.mockReturnValue(true)
  desktop.readProfile.mockReturnValue('production')
  prefs.readUpdatePreferences.mockReturnValue({ checkOnLaunch: true, intervalHours: 6 })
  updater.checkForUpdates.mockResolvedValue(null)
  updater.downloadUpdate.mockImplementation(async () => {
    nativeUpdater.emit('update-downloaded')
    return []
  })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  updater.removeAllListeners()
  nativeUpdater.removeAllListeners()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.resetAllMocks()
  vi.restoreAllMocks()
})

describe('应用内更新状态', () => {
  it('禁用更新时提供原因和可读取状态，不注册事件、不设定时器或调用更新服务', async () => {
    desktop.canUpdate.mockReturnValue(false)
    desktop.readProfile.mockReturnValue('acceptance')
    const controller = setupUpdater(() => null)
    expect(controller.check).toBeNull()
    expect(controller.getState()).toEqual({
      phase: 'unavailable',
      currentVersion: '0.3.0',
      reason: '验收环境不提供自动更新，请使用正式版 Plein。',
    })
    await controller.checkForUpdates()
    await controller.download()
    await controller.install()
    expect(vi.getTimerCount()).toBe(0)
    expect(updater.eventNames()).toEqual([])
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
    expect(updater.downloadUpdate).not.toHaveBeenCalled()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('使用自定义源、完整更新说明和主动下载配置，菜单先打开应用内更新界面', async () => {
    vi.stubEnv('PLEIN_UPDATE_URL', 'http://127.0.0.1:8080/updates')
    const controller = setup()
    expect(updater.setFeedURL).toHaveBeenCalledWith({
      provider: 'generic',
      url: 'http://127.0.0.1:8080/updates',
    })
    expect(updater.autoDownload).toBe(false)
    expect(updater.autoInstallOnAppQuit).toBe(true)
    expect(updater.fullChangelog).toBe(true)
    controller.check()
    // 菜单命令先发给页面，再是检查中的状态
    const menuAt = controller.send.mock.calls.findIndex((call) => call[0] === 'plein:menu-command')
    const checkingAt = controller.send.mock.calls.findIndex((call) => call[1]?.phase === 'checking')
    expect(menuAt).toBeGreaterThanOrEqual(0)
    expect(menuAt).toBeLessThan(checkingAt)
    expect(controller.getState().phase).toBe('checking')
    await vi.advanceTimersByTimeAsync(0)
    expect(controller.getState()).toEqual({
      phase: 'idle',
      currentVersion: '0.3.0',
      checkedAt: Date.now(),
      nextCheckAt: Date.now() + 6 * 60 * 60 * 1000,
    })
    expect(updater.downloadUpdate).not.toHaveBeenCalled()
  })

  it('定时、菜单和页面检查共用同一请求，完成后才允许下一次检查', async () => {
    const pending = deferred<null>()
    updater.checkForUpdates.mockReturnValueOnce(pending.promise)
    const controller = setup()
    const first = controller.checkForUpdates()
    expect(controller.checkForUpdates()).toBe(first)
    controller.check()
    await vi.advanceTimersByTimeAsync(15_000 + 6 * 60 * 60 * 1000)
    expect(updater.checkForUpdates).toHaveBeenCalledOnce()
    expect(controller.getState().phase).toBe('checking')
    pending.resolve(null)
    await first
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2)
    expect(controller.getState().phase).toBe('idle')
  })

  it('保留跨版本说明与发布元数据，页面重载可读取独立快照', async () => {
    const controller = setup()
    await findUpdate(controller)
    const expected: DesktopUpdateState = {
      phase: 'available',
      currentVersion: '0.3.0',
      release: {
        version: info.version,
        name: info.releaseName,
        date: info.releaseDate,
        notes: info.releaseNotes,
      },
      checkedAt: Date.now(),
      nextCheckAt: Date.now() + 6 * 60 * 60 * 1000,
      progress: undefined,
      error: undefined,
    }
    expect(controller.getState()).toEqual(expected)
    expect(controller.send).toHaveBeenLastCalledWith('plein:update-state', expected)
    const snapshot = controller.getState()
    snapshot.release!.notes[0]!.note = '页面改写'
    expect(controller.getState().release?.notes).toEqual(info.releaseNotes)
    expect(updater.downloadUpdate).not.toHaveBeenCalled()
  })

  it('支持字符串和空更新说明，也在无事件时采用检查 Promise 结果', async () => {
    const controller = setup()
    updater.checkForUpdates.mockResolvedValueOnce({
      isUpdateAvailable: true,
      updateInfo: { version: '0.3.3', releaseNotes: '<p>原始 HTML</p>' },
    })
    await controller.checkForUpdates()
    expect(controller.getState().release).toMatchObject({
      version: '0.3.3',
      notes: [{ version: '0.3.3', note: '<p>原始 HTML</p>' }],
    })
    updater.checkForUpdates.mockResolvedValueOnce({
      isUpdateAvailable: true,
      updateInfo: { version: '0.3.4', releaseNotes: null },
    })
    await controller.checkForUpdates()
    expect(controller.getState().release?.notes).toEqual([])
    updater.checkForUpdates.mockResolvedValueOnce({
      isUpdateAvailable: true,
      updateInfo: { version: '0.3.5', releaseNotes: [{ version: '0.3.5', note: null }] },
    })
    await controller.checkForUpdates()
    expect(controller.getState().release?.notes).toEqual([])
    updater.checkForUpdates.mockResolvedValueOnce({
      isUpdateAvailable: true,
      updateInfo: { version: '0.3.6', releaseNotes: ' \n\t ' },
    })
    await controller.checkForUpdates()
    expect(controller.getState().release?.notes).toEqual([])
    updater.checkForUpdates.mockResolvedValueOnce({
      isUpdateAvailable: true,
      updateInfo: {
        version: '0.3.7',
        releaseNotes: [
          { version: '0.3.7', note: '  ## 保留格式\n' },
          { version: '0.3.6', note: '\n\t' },
          { version: '0.3.5', note: null },
        ],
      },
    })
    await controller.checkForUpdates()
    expect(controller.getState().release?.notes).toEqual([
      { version: '0.3.7', note: '  ## 保留格式\n' },
    ])
  })

  it('检查 Promise 失败和 error 事件都能显示错误并重试，重复失败不覆盖重试结果', async () => {
    const controller = setup()
    updater.checkForUpdates.mockRejectedValueOnce(new Error('网络断开'))
    await controller.checkForUpdates()
    expect(controller.getState()).toMatchObject({
      phase: 'error',
      error: { operation: 'check', message: '网络断开' },
    })
    const pending = deferred<null>()
    updater.checkForUpdates.mockReturnValueOnce(pending.promise)
    const retry = controller.checkForUpdates()
    await Promise.resolve()
    updater.emit('error', new Error('证书无效'))
    pending.reject(new Error('同一次请求随后 reject'))
    await retry
    expect(controller.getState().error?.message).toBe('证书无效')
    await findUpdate(controller)
    expect(controller.getState().phase).toBe('available')
    expect(controller.getState().error).toBeUndefined()
  })

  it('主动下载 single flight，推送完整进度，完成后保留说明且菜单不再检查', async () => {
    const controller = setup()
    await findUpdate(controller)
    const pending = deferred<string[]>()
    updater.downloadUpdate.mockReturnValueOnce(pending.promise)
    const first = controller.download()
    expect(controller.download()).toBe(first)
    await Promise.resolve()
    expect(updater.downloadUpdate).toHaveBeenCalledOnce()
    const progress = { percent: 40, transferred: 4, total: 10, bytesPerSecond: 2 }
    updater.emit('download-progress', progress)
    expect(controller.getState()).toMatchObject({
      phase: 'downloading',
      progress: { version: '0.3.2', ...progress },
    })
    expect(controller.setProgressBar).toHaveBeenLastCalledWith(0.4)
    controller.check()
    await vi.advanceTimersByTimeAsync(15_000 + 6 * 60 * 60 * 1000)
    expect(updater.checkForUpdates).toHaveBeenCalledOnce()
    updater.emit('update-downloaded', { version: info.version })
    expect(controller.getState().phase).toBe('downloading')
    nativeUpdater.emit('update-downloaded')
    expect(controller.getState()).toMatchObject({
      phase: 'downloaded',
      release: { notes: info.releaseNotes, name: info.releaseName, date: info.releaseDate },
    })
    expect(controller.getState().progress).toBeUndefined()
    expect(controller.setProgressBar).toHaveBeenLastCalledWith(-1)
    pending.resolve(['/tmp/Plein.zip'])
    await first
    controller.check()
    await controller.download()
    expect(updater.checkForUpdates).toHaveBeenCalledOnce()
    expect(updater.downloadUpdate).toHaveBeenCalledOnce()
    expect(controller.send).toHaveBeenLastCalledWith('plein:menu-command', 'updates')
  })

  it('下载事件或 Promise 失败保留版本与说明，重试可成功完成', async () => {
    const controller = setup()
    await findUpdate(controller)
    const pending = deferred<string[]>()
    updater.downloadUpdate.mockReturnValueOnce(pending.promise)
    const first = controller.download()
    await Promise.resolve()
    updater.emit('error', new Error('下载中断'))
    updater.emit('download-progress', { percent: 60 })
    updater.emit('update-downloaded', { version: info.version })
    expect(controller.getState()).toMatchObject({
      phase: 'error',
      error: { operation: 'download', message: '下载中断' },
      release: { version: info.version, notes: info.releaseNotes },
    })
    expect(controller.getState().progress).toBeUndefined()
    expect(controller.setProgressBar).toHaveBeenLastCalledWith(-1)
    expect(controller.checkForUpdates()).toBe(first)
    expect(controller.download()).toBe(first)
    expect(updater.checkForUpdates).toHaveBeenCalledOnce()
    pending.reject(new Error('同一次下载随后 reject'))
    await first
    expect(controller.getState().error?.message).toBe('下载中断')
    updater.downloadUpdate.mockRejectedValueOnce(new Error('磁盘空间不足'))
    await controller.download()
    expect(controller.getState().error).toEqual({ operation: 'download', message: '磁盘空间不足' })
    await controller.download()
    expect(controller.getState().phase).toBe('downloaded')
    expect(controller.getState().error).toBeUndefined()
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(3)
  })

  it.each(['resolve', 'reject'] as const)(
    '下载开始后，旧检查的结果、事件和拒绝都不能覆盖下载或已下载状态（%s）',
    async (outcome) => {
      const controller = setup()
      const checking = deferred<{ isUpdateAvailable: boolean; updateInfo: typeof info }>()
      updater.checkForUpdates.mockReturnValueOnce(checking.promise)
      const check = controller.checkForUpdates()
      await Promise.resolve()
      updater.emit('update-available', info)
      const pending = deferred<string[]>()
      updater.downloadUpdate.mockReturnValueOnce(pending.promise)
      const download = controller.download()
      await Promise.resolve()
      updater.emit('update-not-available')
      updater.emit('update-available', { version: '0.3.1' })
      expect(controller.getState().phase).toBe('downloading')
      expect(controller.getState().release?.version).toBe('0.3.2')
      updater.emit('update-downloaded', { version: '0.3.1' })
      expect(controller.getState().phase).toBe('downloading')
      updater.emit('update-downloaded', { version: '0.3.2' })
      nativeUpdater.emit('update-downloaded')
      if (outcome === 'reject') checking.reject(new Error('旧检查的迟到错误'))
      else checking.resolve({ isUpdateAvailable: false, updateInfo: info })
      pending.resolve([])
      await Promise.all([check, download])
      updater.emit('update-not-available')
      expect(controller.getState().phase).toBe('downloaded')
      expect(controller.getState().release?.version).toBe('0.3.2')
    },
  )

  it('macOS 下载完成后的原生校验失败仍可见，并允许重试下载', async () => {
    const controller = setup()
    await findUpdate(controller)
    await controller.download()
    expect(controller.getState().phase).toBe('downloaded')
    updater.emit('error', new Error('Squirrel 更新签名校验失败'))
    expect(controller.getState()).toMatchObject({
      phase: 'error',
      error: { operation: 'download', message: 'Squirrel 更新签名校验失败' },
      release: { version: info.version, notes: info.releaseNotes },
    })
    await controller.install()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    await controller.download()
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(2)
    expect(controller.getState().phase).toBe('downloaded')
  })

  it('macOS wrapper 和下载 Promise 都完成后仍等原生校验，期间不能提前安装', async () => {
    const controller = setup()
    await findUpdate(controller)
    updater.downloadUpdate.mockImplementationOnce(async () => {
      updater.emit('update-downloaded', { version: info.version })
      return []
    })
    await controller.download()
    expect(controller.getState()).toMatchObject({
      phase: 'downloading',
      progress: { percent: 100 },
    })
    await controller.install()
    await controller.install()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    nativeUpdater.emit('update-downloaded')
    expect(controller.getState().phase).toBe('downloaded')
    await controller.install()
    await controller.install()
    expect(updater.quitAndInstall).toHaveBeenCalledOnce()
  })

  it('原生校验晚于下载 Promise 失败后可重试，新下载不会继承旧的就绪状态', async () => {
    const controller = setup()
    await findUpdate(controller)
    await controller.download()
    updater.emit('error', new Error('原生包不可用'))
    updater.downloadUpdate.mockImplementationOnce(async () => {
      updater.emit('update-downloaded', { version: info.version })
      return []
    })
    await controller.download()
    expect(controller.getState().phase).toBe('downloading')
    updater.emit('error', new Error('原生签名不匹配'))
    expect(controller.getState()).toMatchObject({
      phase: 'error',
      error: { operation: 'download', message: '原生签名不匹配' },
    })
    nativeUpdater.emit('update-downloaded')
    expect(controller.getState().phase).toBe('error')
    await controller.download()
    expect(controller.getState().phase).toBe('downloaded')
  })

  it('下载完成事件早于校验时，保留首次原生失败而不被 Promise 的重复错误覆盖', async () => {
    const controller = setup()
    await findUpdate(controller)
    const pending = deferred<string[]>()
    updater.downloadUpdate.mockReturnValueOnce(pending.promise)
    const download = controller.download()
    await Promise.resolve()
    updater.emit('update-downloaded', info)
    updater.emit('error', new Error('Squirrel 更新签名校验失败'))
    pending.reject(new Error('校验请求随后 reject'))
    await download
    expect(controller.getState()).toMatchObject({
      phase: 'error',
      error: { operation: 'download', message: 'Squirrel 更新签名校验失败' },
    })
  })

  it('窗口关闭或销毁时仍保留状态，安装只在下载完成后进入退出链', async () => {
    const controller = setup()
    await controller.install()
    await controller.download()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    expect(updater.downloadUpdate).not.toHaveBeenCalled()
    await findUpdate(controller)
    await controller.install()
    controller.destroy()
    const calls = controller.send.mock.calls.length
    await controller.download()
    expect(controller.getState().phase).toBe('downloaded')
    expect(controller.send).toHaveBeenCalledTimes(calls)
    controller.close()
    controller.check()
    await controller.install()
    expect(updater.quitAndInstall).toHaveBeenCalledOnce()
    expect(controller.getState().phase).toBe('downloaded')
  })

  it('安装同步异常作为可读状态返回，修复错误后允许重新安装', async () => {
    const controller = setup()
    await findUpdate(controller)
    await controller.download()
    updater.quitAndInstall.mockImplementationOnce(() => {
      throw new Error('安装器不可用')
    })
    await expect(controller.install()).resolves.toBeUndefined()
    expect(controller.getState()).toMatchObject({
      phase: 'error',
      error: { operation: 'install', message: '安装器不可用' },
      release: { version: info.version, notes: info.releaseNotes },
    })
    await controller.install()
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(2)
    expect(controller.getState().phase).toBe('downloaded')
    expect(controller.getState().error).toBeUndefined()
  })

  it('任务确认期间仅保留一份安装请求，确认成功前不触及原生退出或确认标记', async () => {
    const confirmation = deferred<boolean>()
    const beforeInstall = vi.fn(() => confirmation.promise)
    const controller = setup(beforeInstall)
    await findUpdate(controller)
    await controller.download()
    const first = controller.install()
    expect(controller.install()).toBe(first)
    await Promise.resolve()
    expect(beforeInstall).toHaveBeenCalledOnce()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    expect(controller.installationRequested).toBe(false)
    confirmation.resolve(true)
    await first
    expect(updater.quitAndInstall).toHaveBeenCalledOnce()
    expect(controller.installationRequested).toBe(true)
  })

  it('取消任务确认不关闭窗口，再次安装会重新确认', async () => {
    const beforeInstall = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const controller = setup(beforeInstall)
    updater.quitAndInstall.mockImplementationOnce(() => controller.destroy())
    await findUpdate(controller)
    await controller.download()
    await controller.install()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    expect(controller.isDestroyed()).toBe(false)
    expect(controller.installationRequested).toBe(false)
    await controller.install()
    expect(beforeInstall).toHaveBeenCalledTimes(2)
    expect(updater.quitAndInstall).toHaveBeenCalledOnce()
    expect(controller.isDestroyed()).toBe(true)
  })

  it('确认期间更新失效时不继续安装，原生调用失败后不保留跳过普通退出确认的标记', async () => {
    const confirmation = deferred<boolean>()
    const controller = setup(() => confirmation.promise)
    await findUpdate(controller)
    await controller.download()
    const install = controller.install()
    await Promise.resolve()
    updater.emit('error', new Error('更新包失效'))
    confirmation.resolve(true)
    await install
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    expect(controller.installationRequested).toBe(false)
    await controller.download()
    updater.quitAndInstall.mockImplementationOnce(() => {
      throw new Error('安装器不可用')
    })
    await controller.install()
    expect(controller.installationRequested).toBe(false)
    expect(controller.getState().error?.operation).toBe('install')
  })

  it('请求安装后的 error 事件识别为安装失败，并允许重试一次', async () => {
    const controller = setup()
    await findUpdate(controller)
    await controller.download()
    await controller.install()
    updater.emit('error', new Error('安装器启动失败'))
    expect(controller.getState()).toMatchObject({
      phase: 'error',
      error: { operation: 'install', message: '安装器启动失败' },
    })
    await controller.install()
    expect(controller.getState().phase).toBe('downloaded')
    // 同一次安装未失败时，后续点击不再重复委托。
    await controller.install()
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(2)
  })
})

describe('更新检查计划', () => {
  const HOUR = 60 * 60 * 1000

  it('启动时按开关决定是否检查，默认 15 秒后查一次', async () => {
    const controller = setup()
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(updater.checkForUpdates).toHaveBeenCalledOnce()
    expect(controller.getState().phase).toBe('idle')
    // 之后按间隔轮询
    expect(controller.getState().nextCheckAt).toBe(Date.now() + 6 * HOUR)
    await vi.advanceTimersByTimeAsync(6 * HOUR)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2)
  })

  it('关掉启动检查后不在启动时检查，只按间隔轮询', async () => {
    prefs.readUpdatePreferences.mockReturnValue({ checkOnLaunch: false, intervalHours: 6 })
    const controller = setup()
    const started = Date.now()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
    expect(controller.getState().nextCheckAt).toBe(started + 6 * HOUR)
    await vi.advanceTimersByTimeAsync(6 * HOUR)
    expect(updater.checkForUpdates).toHaveBeenCalledOnce()
  })

  it('间隔改小后按上次检查时间重排，已过期时尽快检查', async () => {
    const controller = setup()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(updater.checkForUpdates).toHaveBeenCalledOnce()
    controller.setPreferences({ checkOnLaunch: true, intervalHours: 24 })
    expect(controller.getState().nextCheckAt).toBe(Date.now() + 24 * HOUR)
    await vi.advanceTimersByTimeAsync(2 * HOUR)
    expect(updater.checkForUpdates).toHaveBeenCalledOnce()
    controller.setPreferences({ checkOnLaunch: true, intervalHours: 1 })
    // 上次检查已经超过新间隔，尽快检查
    await vi.advanceTimersByTimeAsync(0)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2)
    expect(controller.getState().nextCheckAt).toBe(Date.now() + HOUR)
  })

  it('间隔设为不定期后不再安排检查，启动检查仍按开关执行', async () => {
    const controller = setup()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(updater.checkForUpdates).toHaveBeenCalledOnce()
    controller.setPreferences({ checkOnLaunch: true, intervalHours: 0 })
    expect(vi.getTimerCount()).toBe(0)
    expect(controller.getState().nextCheckAt).toBeUndefined()
    await vi.advanceTimersByTimeAsync(24 * HOUR)
    expect(updater.checkForUpdates).toHaveBeenCalledOnce()
  })

  it('下载中和待安装时跳过定时检查', async () => {
    const controller = setup()
    await findUpdate(controller)
    const pending = deferred<string[]>()
    updater.downloadUpdate.mockReturnValueOnce(pending.promise)
    const first = controller.download()
    await Promise.resolve()
    expect(controller.getState().phase).toBe('downloading')
    await vi.advanceTimersByTimeAsync(6 * HOUR)
    expect(updater.checkForUpdates).toHaveBeenCalledOnce()
    nativeUpdater.emit('update-downloaded')
    pending.resolve(['/tmp/Plein.zip'])
    await first
    expect(controller.getState().phase).toBe('downloaded')
    await vi.advanceTimersByTimeAsync(6 * HOUR)
    expect(updater.checkForUpdates).toHaveBeenCalledOnce()
  })

  it('保存偏好后落盘，非法取值不写入', () => {
    const controller = setup()
    expect(controller.getPreferences()).toEqual({ checkOnLaunch: true, intervalHours: 6 })
    controller.setPreferences({ checkOnLaunch: false, intervalHours: 3 })
    expect(prefs.writeUpdatePreferences).toHaveBeenCalledWith({
      checkOnLaunch: false,
      intervalHours: 3,
    })
    expect(controller.getPreferences()).toEqual({ checkOnLaunch: false, intervalHours: 3 })
    expect(() => controller.setPreferences({ checkOnLaunch: true, intervalHours: 5 })).toThrow(
      '更新偏好取值不合法',
    )
    expect(prefs.writeUpdatePreferences).toHaveBeenCalledTimes(1)
  })
})
