import type {
  DesktopUpdateProgress,
  DesktopUpdateRelease,
  DesktopUpdateState,
} from '@plein/protocol'
import { app, autoUpdater as nativeUpdater, type BrowserWindow } from 'electron'
import electronUpdater, { type UpdateInfo } from 'electron-updater'
import { canUpdate, readProfile } from './profile'

const { autoUpdater } = electronUpdater

/** 启动后等一会儿再查，不和服务端启动抢资源 */
const FIRST_CHECK_MS = 15_000
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000

type ReleaseInfo = Pick<UpdateInfo, 'version' | 'releaseName' | 'releaseDate' | 'releaseNotes'>
type Operation = 'check' | 'download' | 'install'
type Flight = { generation: number; failed: boolean }

/** 下载完成事件有时不再带说明，沿用检查时取得的完整发布信息。 */
function releaseOf(info: ReleaseInfo, previous?: DesktopUpdateRelease): DesktopUpdateRelease {
  const earlier = previous?.version === info.version ? previous : undefined
  const notes = info.releaseNotes
  return {
    version: info.version,
    name: info.releaseName ?? earlier?.name,
    date: info.releaseDate || earlier?.date,
    notes:
      notes == null
        ? (earlier?.notes ?? [])
        : typeof notes === 'string'
          ? notes.trim()
            ? [{ version: info.version, note: notes }]
            : []
          : notes
              .filter(({ note }) => typeof note === 'string' && note.trim())
              .map(({ version, note }) => ({ version, note: note! })),
  }
}

/**
 * 检查只获取版本与完整更新说明；用户主动下载，完成后在正常退出链中安装。
 * 状态保存在主进程，页面重载或重新打开窗口后仍可恢复进度与更新说明。
 */
export function setupUpdater(
  getWindow: () => BrowserWindow | null,
  beforeInstall: () => Promise<boolean> = async () => true,
) {
  const profile = readProfile(app.isPackaged, app.getAppPath())
  const enabled = canUpdate(profile, app.isPackaged, process.platform, process.env.PLEIN_UPDATE)
  let state: DesktopUpdateState = { phase: 'idle', currentVersion: app.getVersion() }

  const getState = (): DesktopUpdateState => ({
    ...state,
    ...(state.release && {
      release: { ...state.release, notes: state.release.notes.map((note) => ({ ...note })) },
    }),
    ...(state.progress && { progress: { ...state.progress } }),
    ...(state.error && { error: { ...state.error } }),
  })

  if (!enabled) {
    const reason =
      process.env.PLEIN_UPDATE === '0'
        ? '当前安装的 Plein 已关闭自动更新。'
        : profile !== 'production'
          ? '验收环境不提供自动更新，请使用正式版 Plein。'
          : !app.isPackaged
            ? '开发环境不提供自动更新。'
            : process.platform !== 'darwin'
              ? '当前平台暂不支持自动更新。'
              : '当前安装包不支持自动更新。'
    state = { ...state, phase: 'unavailable', reason }
    return {
      check: null,
      getState,
      checkForUpdates: () => Promise.resolve(),
      download: () => Promise.resolve(),
      install: () => Promise.resolve(),
      get installationRequested() {
        return false
      },
    }
  }

  // 来源默认读安装包的 app-update.yml；该变量用于本地联调更新流程。
  const url = process.env.PLEIN_UPDATE_URL
  if (url) autoUpdater.setFeedURL({ provider: 'generic', url })
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.fullChangelog = true
  autoUpdater.logger = console

  let generation = 0
  let checkFlight: Promise<void> | null = null
  let downloadFlight: Promise<void> | null = null
  let checking: Flight | null = null
  let downloading: Flight | null = null
  let nativeDownloadReady = false
  let installationRequested = false
  let installFlight: Promise<void> | null = null

  const publish = (next: DesktopUpdateState) => {
    state = next
    const win = getWindow()
    if (!win || win.isDestroyed()) return
    win.setProgressBar(state.phase === 'downloading' ? (state.progress?.percent ?? 0) / 100 : -1)
    win.webContents.send('plein:update-state', getState())
  }
  const current = (flight: Flight | null) =>
    flight !== null && flight.generation === generation && !flight.failed
  const canApplyCheck = () =>
    current(checking) && state.phase !== 'downloading' && state.phase !== 'downloaded'

  const fail = (operation: Operation, error: unknown, flight?: Flight | null) => {
    if (flight && !current(flight)) return
    if (flight) flight.failed = true
    console.error(
      `更新${operation === 'check' ? '检查' : operation === 'download' ? '下载' : '安装'}失败`,
      error,
    )
    publish({
      ...state,
      phase: 'error',
      progress: undefined,
      ...(operation === 'check' && { checkedAt: Date.now() }),
      error: { operation, message: error instanceof Error ? error.message : String(error) },
    })
  }
  const available = (info: ReleaseInfo) => {
    if (!canApplyCheck()) return
    publish({
      ...state,
      phase: 'available',
      release: releaseOf(info, state.release),
      progress: undefined,
      error: undefined,
      checkedAt: Date.now(),
    })
  }
  const upToDate = () => {
    if (!canApplyCheck()) return
    publish({
      phase: 'idle',
      currentVersion: state.currentVersion,
      checkedAt: Date.now(),
    })
  }
  const downloaded = (info?: ReleaseInfo) => {
    if (!current(downloading) || state.phase !== 'downloading' || !state.release) return
    if (info && info.version !== state.release.version) return
    publish({
      ...state,
      // macOS wrapper 在 Squirrel 校验前就发下载完成；只有 native 事件才表示可安装。
      phase: nativeDownloadReady ? 'downloaded' : 'downloading',
      release: info ? releaseOf(info, state.release) : state.release,
      progress: nativeDownloadReady ? undefined : { ...state.progress!, percent: 100 },
      error: undefined,
    })
    if (nativeDownloadReady) downloading = null
  }

  autoUpdater.on('update-available', available)
  autoUpdater.on('update-not-available', upToDate)
  autoUpdater.on('download-progress', (progress) => {
    if (!current(downloading) || state.phase !== 'downloading' || !state.release) return
    const updateProgress: DesktopUpdateProgress = {
      version: state.release.version,
      percent: progress.percent,
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond,
    }
    publish({ ...state, progress: updateProgress })
  })
  autoUpdater.on('update-downloaded', downloaded)
  nativeUpdater.on('update-downloaded', () => {
    if (!current(downloading) || state.phase !== 'downloading') return
    nativeDownloadReady = true
    downloaded()
  })
  autoUpdater.on('error', (error) => {
    if (installationRequested && state.phase === 'downloaded') {
      installationRequested = false
      fail('install', error)
    } else if (current(downloading) && state.phase === 'downloading')
      fail('download', error, downloading)
    // MacUpdater 先发 update-downloaded，再把包交给 Squirrel 校验。
    // 下载 Promise 已结束后仍可能校验失败，不能继续展示可安装状态。
    else if (state.phase === 'downloaded') fail('download', error, downloading)
    else if (canApplyCheck()) fail('check', error, checking)
  })

  const checkForUpdates = (): Promise<void> => {
    if (state.phase === 'downloading' || state.phase === 'downloaded') return Promise.resolve()
    // error 事件可能早于下载 Promise 结束；等该下载真正结束再开始检查或重试。
    if (downloadFlight) return downloadFlight
    if (checkFlight) return checkFlight
    installationRequested = false
    nativeDownloadReady = false
    const flight = { generation: ++generation, failed: false }
    checking = flight
    publish({ ...state, phase: 'checking', progress: undefined, error: undefined })
    const task = Promise.resolve()
      .then(() => autoUpdater.checkForUpdates())
      .then((result) => {
        // 事件通常先到；仅在事件缺席时采用 Promise 结果，且不能覆盖之后开始的下载。
        if (!current(flight) || state.phase !== 'checking') return
        if (result?.isUpdateAvailable) available(result.updateInfo)
        else upToDate()
      })
      .catch((error: unknown) => fail('check', error, flight))
      .finally(() => {
        if (checkFlight === task) checkFlight = null
        if (checking === flight) checking = null
      })
    checkFlight = task
    return task
  }

  const download = (): Promise<void> => {
    if (downloadFlight) return downloadFlight
    if (!state.release || (state.phase !== 'available' && state.phase !== 'error'))
      return Promise.resolve()
    installationRequested = false
    nativeDownloadReady = false
    const flight = { generation: ++generation, failed: false }
    downloading = flight
    publish({
      ...state,
      phase: 'downloading',
      error: undefined,
      progress: {
        version: state.release.version,
        percent: 0,
        transferred: 0,
        total: 0,
        bytesPerSecond: 0,
      },
    })
    const task = Promise.resolve()
      .then(() => autoUpdater.downloadUpdate())
      .then(() => {
        if (current(flight)) downloaded()
      })
      .catch((error: unknown) => fail('download', error, flight))
      .finally(() => {
        if (downloadFlight === task) downloadFlight = null
        if (downloading === flight && state.phase !== 'downloading') downloading = null
      })
    downloadFlight = task
    return task
  }

  setTimeout(() => void checkForUpdates(), FIRST_CHECK_MS)
  setInterval(() => void checkForUpdates(), CHECK_EVERY_MS)

  return {
    /** 菜单始终打开应用内更新详情；下载中或已下载时保留当前状态。 */
    check: () => {
      const win = getWindow()
      if (win && !win.isDestroyed()) win.webContents.send('plein:menu-command', 'updates')
      void checkForUpdates()
    },
    getState,
    checkForUpdates,
    download,
    /** 原生安装先关闭所有窗口；必须在委托前确认，之后 before-quit 仍等待服务端保存。 */
    install: (): Promise<void> => {
      if (installFlight) return installFlight
      if (
        installationRequested ||
        (state.phase !== 'downloaded' &&
          !(state.phase === 'error' && state.error?.operation === 'install'))
      )
        return Promise.resolve()
      const task = Promise.resolve()
        .then(beforeInstall)
        .then((confirmed) => {
          if (
            !confirmed ||
            (state.phase !== 'downloaded' &&
              !(state.phase === 'error' && state.error?.operation === 'install'))
          )
            return
          if (state.phase === 'error') publish({ ...state, phase: 'downloaded', error: undefined })
          installationRequested = true
          autoUpdater.quitAndInstall()
        })
        .catch((error: unknown) => {
          installationRequested = false
          fail('install', error)
        })
        .finally(() => {
          if (installFlight === task) installFlight = null
        })
      installFlight = task
      return task
    },
    /** 只有安装前确认成功后才为 true；主进程退出链据此跳过重复确认。 */
    get installationRequested() {
      return installationRequested
    },
  }
}
