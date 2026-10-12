import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron'
import { DEV_WEB_URL, dataDir, isDev, serverPaths } from './paths'
import { type ServerHandle, startServer } from './server'

const DESKTOP_COOKIE = 'plein_desktop'

let server: ServerHandle | null = null
let window: BrowserWindow | null = null
let quitting = false

if (!app.requestSingleInstanceLock()) app.quit()

app.on('second-instance', () => {
  if (!window) return
  if (window.isMinimized()) window.restore()
  window.focus()
})

function createWindow(url: string) {
  const origin = new URL(url).origin
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 800,
    minHeight: 560,
    title: 'plein',
    backgroundColor: '#0b0b0f',
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  win.once('ready-to-show', () => win.show())
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
  const dir = dataDir()
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

app.whenReady().then(boot)

app.on('activate', () => {
  if (!window && server) window = createWindow(isDev ? DEV_WEB_URL : server.url)
})

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
