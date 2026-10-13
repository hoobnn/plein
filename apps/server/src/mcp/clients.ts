import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { McpToolInfo } from '@plein/protocol'
import { detectClis } from '../agent/cli'
import type { McpServerConfig, McpServerStore } from './store'

/** 连接（含 stdio 进程启动、握手）的时限 */
const CONNECT_MS = 30_000
/** 工具列表缓存多久 */
const TOOLS_TTL_MS = 60_000
/** 多久没用就断开（stdio 会结束进程） */
const IDLE_MS = 5 * 60_000
/** 单次工具调用的时限 */
const CALL_MS = 10 * 60_000

/** 外部 MCP 服务出错：连不上、工具不存在、调用失败；消息给人看 */
export class McpError extends Error {}

export type McpContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

export interface McpCallResult {
  content: McpContent[]
  isError: boolean
}

interface Conn {
  client: Client
  /** 连接时的配置：配置改了要重连 */
  key: string
  tools?: { at: number; list: McpToolInfo[] }
  idle: NodeJS.Timeout | null
}

/**
 * 外部 MCP 服务的客户端：按需连接，空闲一段时间后断开；配置改了自动重连。
 * 节点执行器、智能体能力和设置页共用。
 */
export class McpClients {
  private conns = new Map<string, Conn>()
  private connecting = new Map<string, Promise<Conn>>()

  constructor(readonly store: McpServerStore) {}

  /** 已启用的服务 */
  servers() {
    return this.store.list().filter((s) => s.enabled)
  }

  /** 工具列表（带缓存）；refresh 时重新拉 */
  async tools(serverId: string, refresh = false): Promise<McpToolInfo[]> {
    const conn = await this.conn(serverId)
    if (!refresh && conn.tools && Date.now() - conn.tools.at < TOOLS_TTL_MS) return conn.tools.list
    const list: McpToolInfo[] = []
    let cursor: string | undefined
    do {
      const page = await this.guard(serverId, conn.client.listTools(cursor ? { cursor } : {}))
      for (const t of page.tools)
        list.push({
          name: t.name,
          ...(t.title ? { title: t.title } : {}),
          ...(t.description ? { description: t.description } : {}),
          inputSchema: t.inputSchema as Record<string, unknown>,
          ...(t.annotations?.readOnlyHint ? { readOnly: true } : {}),
        })
      cursor = page.nextCursor
    } while (cursor && list.length < 1000)
    conn.tools = { at: Date.now(), list }
    return list
  }

  /** 缓存里的工具信息（同步，取不到就是不知道） */
  cachedTool(serverId: string, tool: string): McpToolInfo | undefined {
    return this.conns.get(serverId)?.tools?.list.find((t) => t.name === tool)
  }

  async call(
    serverId: string,
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpCallResult> {
    const conn = await this.conn(serverId)
    const res = await this.guard(
      serverId,
      conn.client.callTool({ name: tool, arguments: args }, undefined, {
        signal,
        timeout: CALL_MS,
        resetTimeoutOnProgress: true,
      }),
    )
    const content: McpContent[] = []
    for (const c of (res.content ?? []) as Array<Record<string, unknown>>) {
      if (c.type === 'text') content.push({ type: 'text', text: String(c.text ?? '') })
      else if (c.type === 'image' && typeof c.data === 'string')
        content.push({ type: 'image', data: c.data, mimeType: String(c.mimeType ?? 'image/png') })
      else if (c.type === 'resource') {
        const r = c.resource as { text?: unknown; uri?: unknown } | undefined
        if (typeof r?.text === 'string') content.push({ type: 'text', text: r.text })
        else if (r?.uri) content.push({ type: 'text', text: `（资源：${String(r.uri)}）` })
      } else if (c.type === 'resource_link')
        content.push({ type: 'text', text: `（资源：${String(c.uri ?? '')}）` })
    }
    if (!content.length && res.structuredContent)
      content.push({ type: 'text', text: JSON.stringify(res.structuredContent, null, 1) })
    return { content, isError: res.isError === true }
  }

  /** 断开一个服务（配置改了、删了） */
  async disconnect(serverId: string) {
    const conn = this.conns.get(serverId)
    this.conns.delete(serverId)
    if (!conn) return
    if (conn.idle) clearTimeout(conn.idle)
    await conn.client.close().catch(() => {})
  }

  async close() {
    await Promise.all([...this.conns.keys()].map((id) => this.disconnect(id)))
  }

  private async conn(serverId: string): Promise<Conn> {
    const config = this.store.get(serverId)
    if (!config) throw new McpError('这个 MCP 服务已经删除了')
    if (!config.enabled) throw new McpError(`MCP 服务「${config.name}」已停用`)
    const key = JSON.stringify(config)
    const existing = this.conns.get(serverId)
    if (existing && existing.key !== key) await this.disconnect(serverId)
    const live = this.conns.get(serverId)
    if (live) return this.touch(serverId, live)
    let pending = this.connecting.get(serverId)
    if (!pending) {
      pending = this.open(config, key).finally(() => this.connecting.delete(serverId))
      this.connecting.set(serverId, pending)
    }
    return this.touch(serverId, await pending)
  }

  private async open(config: McpServerConfig, key: string): Promise<Conn> {
    const client = new Client({ name: 'plein', version: '0.1.0' })
    const transport =
      config.transport === 'stdio'
        ? new StdioClientTransport({
            command: config.command!,
            args: config.args ?? [],
            // 桌面端从访达启动时 PATH 很短，npx / uvx 找不到：用登录 shell 的 PATH
            env: { ...getDefaultEnvironment(), PATH: (await detectClis()).path, ...config.secrets },
            stderr: 'ignore',
          })
        : new StreamableHTTPClientTransport(new URL(config.url!), {
            requestInit: { headers: config.secrets },
          })
    try {
      await client.connect(transport, { timeout: CONNECT_MS })
    } catch (err) {
      await client.close().catch(() => {})
      throw new McpError(`连不上 MCP 服务「${config.name}」：${(err as Error).message}`)
    }
    const conn: Conn = { client, key, idle: null }
    client.onclose = () => {
      if (this.conns.get(config.id) === conn) this.conns.delete(config.id)
    }
    this.conns.set(config.id, conn)
    return conn
  }

  private touch(serverId: string, conn: Conn) {
    if (conn.idle) clearTimeout(conn.idle)
    conn.idle = setTimeout(() => void this.disconnect(serverId), IDLE_MS)
    conn.idle.unref()
    return conn
  }

  /** 请求失败时断开连接（下次重连），错误改成给人看的话 */
  private async guard<T>(serverId: string, p: Promise<T>): Promise<T> {
    try {
      return await p
    } catch (err) {
      if (err instanceof McpError) throw err
      const name = this.store.get(serverId)?.name ?? serverId
      if ((err as { code?: unknown }).code !== -32602) await this.disconnect(serverId)
      throw new McpError(`MCP 服务「${name}」出错：${(err as Error).message}`)
    }
  }
}
