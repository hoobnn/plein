import type { DesktopUpdateProgress } from '@plein/protocol'
import { app, type BrowserWindow, dialog } from 'electron'
import electronUpdater from 'electron-updater'

const { autoUpdater } = electronUpdater

/** 启动后等一会儿再查，不和服务端启动抢资源 */
const FIRST_CHECK_MS = 15_000
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000

/**
 * 自动更新：从 GitHub Releases 的 latest-mac.yml 查新版本（release.yml 发版时生成），
 * 后台下载，进度推给页面并显示在 Dock 图标上，下载完提示重启；不重启的话，下次退出时安装。
 * 只在安装包里启用：开发模式和 ad-hoc 签名的本地包无法通过 Squirrel 的签名校验。
 */
export function setupUpdater(getWindow: () => BrowserWindow | null) {
  if (!app.isPackaged || process.platform !== 'darwin' || process.env.PLEIN_UPDATE === '0')
    return { check: null }

  // 来源默认读安装包里的 app-update.yml（GitHub Releases，见 electron-builder.config.mjs）；
  // PLEIN_UPDATE_URL 换成放着 latest-mac.yml 的目录地址，用于本地联调更新流程
  const url = process.env.PLEIN_UPDATE_URL
  if (url) autoUpdater.setFeedURL({ provider: 'generic', url })
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = console

  /** 用户从菜单手动检查时，没有更新或出错也要告诉他 */
  let manual = false
  let downloaded: string | null = null
  /** 正在下载的版本；download-progress 事件里不带版本号 */
  let downloading = ''

  const show = async (options: Electron.MessageBoxOptions) => {
    const win = getWindow()
    return win && !win.isDestroyed()
      ? dialog.showMessageBox(win, options)
      : dialog.showMessageBox(options)
  }

  autoUpdater.on('update-not-available', () => {
    if (!manual) return
    manual = false
    void show({ type: 'info', message: '已经是最新版本', detail: `当前版本 ${app.getVersion()}` })
  })
  autoUpdater.on('update-available', (info) => {
    downloading = info.version
    if (!manual) return
    manual = false
    void show({
      type: 'info',
      message: `发现新版本 ${info.version}`,
      detail: '正在后台下载，窗口顶部会显示进度，下载完会提示重启。',
    })
  })

  /** 推给页面，同时显示在 Dock 图标上；null 表示下载结束，收起进度 */
  const report = (progress: DesktopUpdateProgress | null) => {
    const win = getWindow()
    if (!win || win.isDestroyed()) return
    win.setProgressBar(progress ? progress.percent / 100 : -1)
    win.webContents.send('plein:update-progress', progress)
  }
  autoUpdater.on('download-progress', (p) => {
    report({
      version: downloading,
      percent: p.percent,
      transferred: p.transferred,
      total: p.total,
      bytesPerSecond: p.bytesPerSecond,
    })
  })

  autoUpdater.on('error', (err) => {
    console.error('检查更新失败', err)
    report(null)
    if (!manual) return
    manual = false
    void show({ type: 'warning', message: '检查更新失败', detail: err.message })
  })
  /** 提示重启；退出流程照常走 before-quit：有任务时先确认，再等服务端保存 */
  const offerRestart = async (version: string) => {
    const { response } = await show({
      type: 'info',
      message: `新版本 ${version} 已下载`,
      detail: '重启 Plein 即可完成更新；选「稍后」会在下次退出时安装。',
      buttons: ['立即重启', '稍后'],
      defaultId: 0,
      cancelId: 1,
    })
    if (response === 0) autoUpdater.quitAndInstall()
  }
  autoUpdater.on('update-downloaded', (info) => {
    report(null)
    // 定时检查会重复触发同一个版本，只提示一次
    if (downloaded === info.version) return
    downloaded = info.version
    void offerRestart(info.version)
  })

  const run = () => {
    // 失败已经由 error 事件处理；检查和随后的自动下载各是一个 Promise，都接住，不变成未处理的 rejection
    autoUpdater
      .checkForUpdates()
      .then((r) => r?.downloadPromise?.catch(() => {}))
      .catch(() => {})
  }
  setTimeout(run, FIRST_CHECK_MS)
  setInterval(run, CHECK_EVERY_MS)

  return {
    /** 菜单「检查更新…」：已经下载好就直接提示重启 */
    check: () => {
      if (downloaded) return void offerRestart(downloaded)
      manual = true
      run()
    },
  }
}
