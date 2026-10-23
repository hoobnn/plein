import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'

const runtime = vi.hoisted(() => ({
  pending: 2,
  confirmedInstall: false,
  windows: 0,
  beforeQuit: null as ((event: { preventDefault(): void }) => void) | null,
  beforeInstall: null as (() => Promise<boolean>) | null,
  confirm: vi.fn(),
  stop: vi.fn(),
  quit: vi.fn(),
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getAppPath: () => '/Applications/Plein.app',
    getPath: () => '/tmp/plein-main-contract',
    getVersion: () => '0.4.0',
    setAboutPanelOptions: vi.fn(),
    whenReady: async () => {},
    quit: runtime.quit,
    on: (event: string, listener: (event: { preventDefault(): void }) => void) => {
      if (event === 'before-quit') runtime.beforeQuit = listener
    },
  },
  BrowserWindow: class {
    constructor() {
      runtime.windows++
    }
    webContents = { on: vi.fn(), setWindowOpenHandler: vi.fn() }
    once = vi.fn()
    on = vi.fn()
    loadURL = async () => {}
    isDestroyed = () => false
  },
  dialog: { showMessageBox: runtime.confirm },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  nativeTheme: { shouldUseDarkColors: false },
  session: { defaultSession: { cookies: { set: async () => {} } } },
}))
vi.mock('./activity', () => ({
  Activity: class {
    get pending() {
      return runtime.pending
    }
    reset = vi.fn()
  },
}))
vi.mock('./paths', () => ({
  appIconPath: () => '/tmp/icon.png',
  dataDir: () => '/tmp/plein-main-contract/data',
  isDev: false,
  serverPaths: () => ({}),
}))
vi.mock('./profile', () => ({
  readProfile: () => 'production',
  profileIdentity: () => ({ productName: 'Plein', windowTitle: 'plein' }),
  initializeProfile: () => true,
  profileWindowChrome: () => ({}),
}))
vi.mock('./downloads', () => ({ handleDownloads: vi.fn(), showSavedFile: vi.fn() }))
vi.mock('./menu', () => ({ installMenu: vi.fn() }))
vi.mock('./prefs', () => ({ readPrefs: () => ({}), writePrefs: vi.fn() }))
vi.mock('./window-state', () => ({
  restoreWindowState: () => ({ maximized: false }),
  trackWindowState: vi.fn(),
}))
vi.mock('./server', () => ({
  startServer: async () => ({
    url: 'http://127.0.0.1:9876',
    token: 'contract',
    stop: runtime.stop,
    onActivity: vi.fn(),
    onExit: vi.fn(),
  }),
}))
vi.mock('./updater', () => ({
  setupUpdater: (_getWindow: unknown, beforeInstall: () => Promise<boolean>) => {
    runtime.beforeInstall = beforeInstall
    return {
      check: null,
      get installationRequested() {
        return runtime.confirmedInstall
      },
    }
  },
}))

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  runtime.pending = 2
  runtime.confirmedInstall = false
  runtime.windows = 0
  runtime.beforeQuit = null
  runtime.beforeInstall = null
  runtime.confirm.mockResolvedValue({ response: 1 })
  runtime.stop.mockResolvedValue(undefined)
  await import('./main')
  await vi.waitFor(() => expect(runtime.windows).toBe(1))
})

describe('桌面更新退出顺序', () => {
  it('安装前确认取消后保留当前窗口，普通退出仍会确认未完成任务', async () => {
    await expect(runtime.beforeInstall!()).resolves.toBe(false)
    expect(runtime.stop).not.toHaveBeenCalled()
    expect(runtime.quit).not.toHaveBeenCalled()
    const event = { preventDefault: vi.fn() }
    runtime.beforeQuit!(event)
    await vi.waitFor(() => expect(runtime.confirm).toHaveBeenCalledTimes(2))
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(runtime.stop).not.toHaveBeenCalled()
  })

  it('确认尚未结束时不重复询问，也不启动普通退出保存链', async () => {
    let resolve!: (value: { response: number }) => void
    runtime.confirm.mockReturnValueOnce(new Promise((done) => (resolve = done)))
    const confirmation = runtime.beforeInstall!()
    await expect(runtime.beforeInstall!()).resolves.toBe(false)
    runtime.beforeQuit!({ preventDefault: vi.fn() })
    expect(runtime.confirm).toHaveBeenCalledOnce()
    expect(runtime.stop).not.toHaveBeenCalled()
    resolve({ response: 1 })
    await expect(confirmation).resolves.toBe(false)
  })

  it('已确认的安装不再询问任务，仍等待服务端保存完成后退出', async () => {
    let saved!: () => void
    runtime.stop.mockReturnValueOnce(new Promise<void>((done) => (saved = done)))
    runtime.confirmedInstall = true
    const event = { preventDefault: vi.fn() }
    runtime.beforeQuit!(event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(runtime.confirm).not.toHaveBeenCalled()
    expect(runtime.stop).toHaveBeenCalledOnce()
    expect(runtime.quit).not.toHaveBeenCalled()
    saved()
    await vi.waitFor(() => expect(runtime.quit).toHaveBeenCalledOnce())
  })
})
