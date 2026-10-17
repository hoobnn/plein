import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import { WebSocketServer } from 'ws'
import { createServer, type Server } from './app'
import type { Config } from './config'

export interface RunningServer {
  server: Server
  /** 实际监听的端口；配置为 0 时由系统分配 */
  port: number
  url: string
  /** 断开所有连接、保存文档并关闭数据库 */
  close(): Promise<void>
}

/** 启动 HTTP + WebSocket 服务；命令行入口和桌面端都通过它启动 */
export async function startServer(config: Config): Promise<RunningServer> {
  const server = await createServer(config)
  const wss = new WebSocketServer({ noServer: true })
  const http = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
    const s = serve(
      {
        fetch: server.app.fetch,
        hostname: config.host,
        port: config.port,
        websocket: { server: wss },
      },
      () => resolve(s),
    )
    s.once('error', reject)
  })
  const { address, port, family } = http.address() as AddressInfo
  const host = family === 'IPv6' ? `[${address}]` : address
  // 智能体 CLI 和服务端在同一台机器上，走回环地址
  server.agents.setMcpUrl(`http://127.0.0.1:${port}/mcp`)

  let closing: Promise<void> | null = null
  return {
    server,
    port,
    url: `http://${host}:${port}`,
    close() {
      closing ??= (async () => {
        for (const ws of wss.clients) ws.close(1001, 'server shutdown')
        await server.close()
        await new Promise<void>((resolve) => {
          http.close(() => resolve())
          // Only bound HTTP draining; never close SQLite underneath a backup.
          setTimeout(resolve, 3000).unref()
        })
      })()
      return closing
    },
  }
}
