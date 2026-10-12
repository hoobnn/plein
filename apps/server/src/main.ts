import { serve } from '@hono/node-server'
import { WebSocketServer } from 'ws'
import { createServer } from './app'
import { loadConfig } from './config'

const config = loadConfig()
const server = await createServer(config)
const wss = new WebSocketServer({ noServer: true })

const http = serve(
  { fetch: server.app.fetch, hostname: config.host, port: config.port, websocket: { server: wss } },
  (info) => {
    const host = info.family === 'IPv6' ? `[${info.address}]` : info.address
    console.log(`plein 已启动：http://${host}:${info.port}`)
    console.log(`数据目录：${config.dataDir}`)
    if (!config.webDist)
      console.log('未找到前端构建产物，开发时请另开 pnpm --filter @plein/web dev')
    if (config.auth === 'password') console.log('已开启登录；首次访问时创建所有者账号')
    else console.log('未开启登录，只应在本机访问')
  },
)

let closing = false
function shutdown(signal: string) {
  if (closing) return
  closing = true
  console.log(`收到 ${signal}，正在保存并退出…`)
  for (const ws of wss.clients) ws.close(1001, 'server shutdown')
  server.close()
  http.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000).unref()
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
