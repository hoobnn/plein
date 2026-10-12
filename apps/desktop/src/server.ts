import { randomBytes } from 'node:crypto'
import { createWriteStream, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app, type UtilityProcess, utilityProcess } from 'electron'
import { DEV_SERVER_PORT, isDev, type ServerPaths } from './paths'

export interface ServerHandle {
  /** 服务端实际地址 */
  url: string
  /** 本次启动的令牌，写进窗口 Cookie 后才能访问服务端 */
  token: string
  /** 通知服务端保存并退出，超时后强制结束 */
  stop(): Promise<void>
  /** 服务端意外退出时回调 */
  onExit(fn: (code: number) => void): void
}

type ServerMessage =
  | { type: 'ready'; port: number; url: string }
  | { type: 'error'; message: string }

/** 在 utilityProcess 里启动 apps/server，等它报告实际端口 */
export function startServer(paths: ServerPaths, dataDir: string): Promise<ServerHandle> {
  const token = randomBytes(32).toString('hex')
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PLEIN_HOST: '127.0.0.1',
    PLEIN_PORT: String(isDev ? DEV_SERVER_PORT : 0),
    PLEIN_AUTH: 'none',
    PLEIN_DATA_DIR: dataDir,
    PLEIN_DESKTOP_TOKEN: token,
  }
  if (paths.webDist) env.PLEIN_WEB_DIST = paths.webDist
  if (paths.ffmpeg) env.PLEIN_FFMPEG_PATH = paths.ffmpeg
  if (paths.ffprobe) env.PLEIN_FFPROBE_PATH = paths.ffprobe
  if (isDev) env.PLEIN_MOCK_PROVIDER ??= '1'

  const child: UtilityProcess = utilityProcess.fork(paths.entry, [], {
    cwd: paths.cwd,
    env,
    serviceName: 'plein-server',
    stdio: 'pipe',
  })

  // 服务端日志同时写到控制台和 <userData>/logs/server.log
  const logDir = join(app.getPath('userData'), 'logs')
  mkdirSync(logDir, { recursive: true })
  const log = createWriteStream(join(logDir, 'server.log'), { flags: 'a' })
  child.stdout?.on('data', (d: Buffer) => {
    process.stdout.write(d)
    log.write(d)
  })
  child.stderr?.on('data', (d: Buffer) => {
    process.stderr.write(d)
    log.write(d)
  })

  let exited = false
  const exitListeners: Array<(code: number) => void> = []
  const exit = new Promise<number>((resolve) => {
    child.once('exit', (code) => {
      exited = true
      log.end()
      resolve(code)
      for (const fn of exitListeners) fn(code)
    })
  })

  return new Promise((resolve, reject) => {
    child.on('message', (msg: ServerMessage) => {
      if (msg.type === 'error') reject(new Error(msg.message))
      if (msg.type !== 'ready') return
      resolve({
        url: msg.url,
        token,
        async stop() {
          if (exited) return
          child.postMessage({ type: 'shutdown' })
          const timer = setTimeout(() => child.kill(), 5000)
          await exit
          clearTimeout(timer)
        },
        onExit(fn) {
          exitListeners.push(fn)
        },
      })
    })
    void exit.then((code) => reject(new Error(`服务端启动失败（退出码 ${code}），详见 server.log`)))
  })
}
