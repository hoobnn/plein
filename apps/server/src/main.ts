import { loadConfig } from './config'
import { startServer } from './start'

/** Electron utilityProcess 里运行时，主进程通过 parentPort 与服务端通信 */
interface ParentPort {
  postMessage(message: unknown): void
  on(event: 'message', listener: (e: { data: unknown }) => void): void
}
const parentPort = (process as { parentPort?: ParentPort }).parentPort

const config = loadConfig()
const running = await startServer(config).catch((err: Error) => {
  console.error('plein 启动失败：', err)
  parentPort?.postMessage({ type: 'error', message: err.message })
  process.exit(1)
})

console.log(`plein 已启动：${running.url}`)
console.log(`数据目录：${config.dataDir}`)
if (!config.webDist) console.log('未找到前端构建产物，开发时请另开 pnpm --filter @plein/web dev')
if (config.desktopToken) console.log('桌面端模式：只接受桌面端窗口的请求')
else if (config.auth === 'password') console.log('已开启登录；首次访问时创建所有者账号')
else console.log('未开启登录，只应在本机访问')
parentPort?.postMessage({ type: 'ready', port: running.port, url: running.url })
// 任务动态交给桌面端主进程：Dock 徽标、系统通知、退出前确认
if (parentPort)
  running.server.runs.onActivity((activity) =>
    parentPort.postMessage({ type: 'activity', activity }),
  )

let closing = false
async function shutdown(reason: string) {
  if (closing) return
  closing = true
  console.log(`收到 ${reason}，正在保存并退出…`)
  await running.close()
  process.exit(0)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
parentPort?.on('message', (e) => {
  if ((e.data as { type?: string } | null)?.type === 'shutdown') void shutdown('退出请求')
})
