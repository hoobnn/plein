import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, session, shell } from 'electron'
import { installMenu } from './menu'
import { appIconPath, DEV_WEB_URL, dataDir, isDev, serverPaths } from './paths'
import { type ServerHandle, startServer } from './server'
import { restoreWindowState, trackWindowState } from './window-state'

const DESKTOP_COOKIE = 'plein_desktop'

let server: ServerHandle | null = null
let window: BrowserWindow | null = null
let quitting = false

app.setName('plein')
if (process.platform === 'win32') app.setAppUserModelId('app.plein.desktop')
const primaryInstance = app.requestSingleInstanceLock()
if (!primaryInstance) app.quit()

function showWindow() {
  if (quitting) return null
  if (!window && server) window = createWindow(isDev ? DEV_WEB_URL : server.url)
  if (!window) return null
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
  return window
}

app.on('second-instance', showWindow)

function createWindow(url: string) {
  const origin = new URL(url).origin
  const { maximized, ...bounds } = restoreWindowState()
  const win = new BrowserWindow({
    ...bounds,
    // macOS 隐藏标题栏、红绿灯浮在应用顶栏上（顶栏可拖动、双击缩放，见 styles.css 的 .app-drag），
    // 红绿灯与首页顶栏、编辑器左上角工具条垂直居中对齐。
    // 其他平台保留系统标题栏，留住原生窗口按钮和 Windows Snap 行为。
    frame: true,
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 20, y: 27 } }
      : { titleBarStyle: 'default' as const }),
    autoHideMenuBar: false,
    title: 'plein',
    icon: appIconPath(),
    // 与网页主题的画布底色一致，避免启动时闪色
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#fcfcfb',
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  trackWindowState(win)
  win.once('ready-to-show', () => {
    if (maximized) win.maximize()
    win.show()
  })
  win.on('page-title-updated', (event) => event.preventDefault())
  // 只在窗口里打开 plein 自己的页面，外部链接交给系统浏览器
  const external = (target: string) => {
    if (/^https?:/.test(target)) void shell.openExternal(target)
  }
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    external(target)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, target) => {
    if (new URL(target).origin === origin) return
    e.preventDefault()
    external(target)
  })
  win.on('closed', () => {
    window = null
  })
  void win.loadURL(url)
  return win
}

/** 开发模式下 Vite 和桌面端一起启动，等 Vite 就绪再打开窗口 */
async function waitFor(url: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await fetch(url).then(
      (r) => r.ok,
      () => false,
    )
    if (ok) return
    await new Promise((r) => setTimeout(r, 300))
  }
}

async function boot() {
  app.dock?.setIcon(appIconPath())
  app.setAboutPanelOptions({
    applicationName: 'Plein',
    applicationVersion: app.getVersion(),
    iconPath: appIconPath(),
  })
  installMenu(showWindow)
  const dir = dataDir()
  ipcMain.handle('plein:native-edit', (event, action: unknown) => {
    if (
      !window ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    )
      return
    if (action === 'undo' || action === 'redo' || action === 'selectAll') event.sender[action]()
  })
  ipcMain.handle('plein:open-data-dir', async () => {
    const err = await shell.openPath(dir)
    if (err) throw new Error(err)
  })

  try {
    server = await startServer(serverPaths(), dir)
  } catch (err) {
    dialog.showErrorBox('plein 无法启动', (err as Error).message)
    app.exit(1)
    return
  }
  server.onExit((code) => {
    if (quitting) return
    dialog.showErrorBox('plein 服务意外退出', `退出码 ${code}，详见日志目录下的 server.log`)
    app.exit(1)
  })

  const url = isDev ? DEV_WEB_URL : server.url
  if (isDev) await waitFor(url)
  // 令牌只放在本次会话的 Cookie 里，不落盘，也不出现在地址栏
  await session.defaultSession.cookies.set({
    url,
    name: DESKTOP_COOKIE,
    value: server.token,
    httpOnly: true,
    sameSite: 'strict',
  })
  window = createWindow(url)
}

if (primaryInstance) void app.whenReady().then(boot)

app.on('activate', showWindow)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// 退出前等服务端保存文档、关闭数据库
app.on('before-quit', (e) => {
  if (quitting || !server) return
  e.preventDefault()
  quitting = true
  void server.stop().finally(() => app.quit())
})
