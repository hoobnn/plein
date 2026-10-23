import type { AgentAccess, AgentContext, AgentSettings } from '@plein/protocol'

/** CLI 想做一件需要用户点头的事（改文件、跑命令、用用户自己的 MCP 工具等） */
export interface PermissionAsk {
  /** 工具名，给人看 */
  tool: string
  /** 一句话说明要做什么 */
  reason: string
}

/** 驱动把 CLI 的事件翻译成这些回调，由会话层落到对话记录里 */
export interface DriverHooks {
  /** CLI 自己的会话 id（下次启动时接上） */
  session(id: string): void
  /** 一段回复文字；done 为 false 时是流式的中间状态 */
  text(id: string, text: string, done: boolean): void
  toolStart(id: string, name: string, detail?: string): void
  toolEnd(
    id: string,
    error: boolean,
    output?: string,
    fallback?: { name: string; detail?: string },
  ): void
  error(text: string): void
  /** 这一轮结束（成功、失败或被打断） */
  turnEnd(): void
  /** 进程退出；还在一轮中间时带上给用户看的原因 */
  exit(reason?: string): void
  /** 等用户在面板里允许或拒绝；signal 中止表示 CLI 不再需要这个答复 */
  permission(ask: PermissionAsk, signal: AbortSignal): Promise<boolean>
  /** 当前上下文占用；不能用累计计费 token 代替。 */
  context?(context: AgentContext): void
}

export interface DriverOptions {
  /** 可执行文件 */
  bin: string
  name: string
  cwd: string
  env: NodeJS.ProcessEnv
  /** 接上的 CLI 会话 id */
  resume: string | null
  access: AgentAccess
  /** Plein 画布工具的 MCP 地址与会话令牌 */
  mcpUrl: string
  token: string
  instructions: string
  settings?: AgentSettings
  /** 本轮显式选择、由服务端目录验证的 Codex 原生技能。 */
  skill?: { name: string; path: string }
}

/** 一个轮次的 CLI 进程；下一轮通过 resume 延续原 CLI 会话。 */
export interface CliDriver {
  readonly access: AgentAccess
  readonly alive: boolean
  /** 开始新的一轮 */
  send(prompt: string): void
  /** 打断这一轮，收尾后关闭进程 */
  interrupt(): void
  /** 结束进程 */
  close(): void
}

/** MCP 服务名：Claude Code 里工具名是 mcp__plein__<工具> */
export const MCP_NAME = 'plein'
export const TOKEN_ENV = 'PLEIN_AGENT_TOKEN'
