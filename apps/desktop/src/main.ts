import { join } from 'node:path'
import type { DesktopOpenNode } from '@plein/protocol'
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, session, shell } from 'electron'
import { Activity } from './activity'
import { handleDownloads, showSavedFile } from './downloads'
import { installMenu } from './menu'
import { appIconPath, DEV_WEB_URL, dataDir, isDev, serverPaths } from './paths'
import { readPrefs, writePrefs } from './prefs'
import { type ServerHandle, startServer } from './server'
import { restoreWindowState, trackWindowState } from './window-state'

const DESKTOP_COOKIE = 'plein_desktop'
/** 服务端意外退出后自动重启；这段时间内又退出就不再重启，提示用户看日志 */
const RESTART_WINDOW_MS = 60_000

let server: ServerHandle | null = null
let window: BrowserWindow | null = null
let quitting = false
let lastCrash = 0

const activity = new Activity(() => window, openNode)

/** 点通知时要定位的节点；页面注册好监听后再发，窗口刚新建时也不会丢 */
let pendingOpen: DesktopOpenNode | null = null
let openReady = false

/** 系统通知被点击：回到窗口，让页面打开画布并定位节点 */
function openNode(target: DesktopOpenNode) {
  pendingOpen = target
  showWindow()
  flushOpen()
}

function flushOpen() {
  if (!pendingOpen || !openReady || !window || window.isDestroyed()) return
  window.webContents.send('plein:open-node', pendingOpen)
  pendingOpen = null
}

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
  // 整页重新载入后要等页面重新注册监听
  win.webContents.on('did-navigate', () => {
    openReady = false
  })
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
    // 服务端重启后端口可能变了，按当前地址判断
    if (new URL(target).origin === new URL(pageUrl()).origin) return
    e.preventDefault()
    external(target)
  })
  win.on('closed', () => {
    window = null
    openReady = false
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
  ipcMain.on('plein:open-node-ready', (event) => {
    if (!window || event.sender !== window.webContents) return
    openReady = true
    flushOpen()
  })
  ipcMain.handle('plein:show-saved-file', (event, path: unknown) => {
    if (window && event.sender === window.webContents) showSavedFile(path)
  })
  handleDownloads(session.defaultSession, () => window)

  try {
    await launchServer()
  } catch (err) {
    await fatal('Plein 无法启动', (err as Error).message)
    return
  }
  window = createWindow(pageUrl())
}

const pageUrl = () => (isDev ? DEV_WEB_URL : server!.url)

/**
 * 启动服务端并把令牌写进窗口的 Cookie。
 * 尽量沿用上次的端口（网页的本地设置按端口保存），端口被占用时换一个。
 */
async function launchServer() {
  const preferred = readPrefs().port ?? 0
  const paths = serverPaths()
  const dir = dataDir()
  server = await startServer(paths, dir, preferred).catch((err: Error) => {
    if (!preferred || isDev) throw err
    console.warn(`端口 ${preferred} 不可用，改用随机端口：${err.message}`)
    return startServer(paths, dir, 0)
  })
  const port = Number(new URL(server.url).port)
  if (!isDev && port !== preferred) writePrefs({ port })
  server.onActivity((e) => activity.handle(e))
  server.onExit((code) => void crashed(code))

  const url = pageUrl()
  if (isDev) await waitFor(url)
  // 令牌只放在本次会话的 Cookie 里，不落盘，也不出现在地址栏
  await session.defaultSession.cookies.set({
    url,
    name: DESKTOP_COOKIE,
    value: server.token,
    httpOnly: true,
    sameSite: 'strict',
  })
}

/** 服务端意外退出：自动重启一次并重新载入页面；短时间内再次退出才报错 */
async function crashed(code: number) {
  if (quitting) return
  activity.reset()
  const now = Date.now()
  const again = now - lastCrash < RESTART_WINDOW_MS
  lastCrash = now
  console.error(`服务端意外退出（退出码 ${code}）${again ? '' : '，正在重启'}`)
  if (!again) {
    try {
      await launchServer()
      if (window && !window.isDestroyed()) void window.loadURL(pageUrl())
      return
    } catch (err) {
      console.error('服务端重启失败', err)
    }
  }
  await fatal('Plein 服务意外退出', `退出码 ${code}。可以在日志目录的 server.log 里查看原因。`)
}

/** 无法继续运行：提示并提供打开日志目录 */
async function fatal(title: string, detail: string) {
  const { response } = await dialog.showMessageBox({
    type: 'error',
    message: title,
    detail,
    buttons: ['退出', '打开日志目录'],
    defaultId: 0,
  })
  if (response === 1) await shell.openPath(join(app.getPath('userData'), 'logs'))
  app.exit(1)
}

if (primaryInstance) void app.whenReady().then(boot)

app.on('activate', showWindow)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

let confirming = false

// 退出前：有任务时先确认，再等服务端保存文档、关闭数据库
app.on('before-quit', (e) => {
  if (quitting || !server) return
  e.preventDefault()
  if (confirming) return
  if (activity.pending) {
    confirming = true
    void confirmQuit(activity.pending).then((ok) => {
      confirming = false
      if (ok) stop()
    })
    return
  }
  stop()
})

function stop() {
  quitting = true
  activity.reset()
  void server!.stop().finally(() => app.quit())
}

async function confirmQuit(pending: number) {
  const parent = window && !window.isDestroyed() ? window : undefined
  const options = {
    type: 'question' as const,
    message: `还有 ${pending} 个任务没有完成，确定退出吗？`,
    detail: '已经提交给模型平台的生成会在下次打开 Plein 时继续查询结果，排队中的任务也会接着运行。',
    buttons: ['退出', '取消'],
    defaultId: 1,
    cancelId: 1,
  }
  const { response } = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options)
  return response === 0
}
