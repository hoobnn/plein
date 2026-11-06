import type {
  AgentApprovalMode,
  AgentContext,
  AgentEvent,
  AgentItem,
  AgentSettings,
  AgentSkill,
  AgentSkillDetail,
} from '@plein/protocol'
import type { AssetStore } from '../assets/store'
import type { PluginHost } from '../plugins/host'
import type { EditPlans } from '../runs/edit-plan'
import type { NodeRuns } from '../runs/runs'
import type { LibraryStore } from '../library/store'
import type { DB } from '../storage/db'
import type { Rooms } from '../sync/rooms'
import type { Approvals } from './approvals'
import type { AgentChanges } from './changes'
import type { CliEnvironment } from './cli'
import type { CliDriver } from './drivers/types'
import type { TurnExecution } from './execution'
import type { McpServer, McpTool } from './mcp'
import type { AgentPlan } from './plan'
import type { SessionRow, SessionStore } from './session-store'
import type { TurnStore } from './turn-store'

/** 一个会话在内存里的运行期状态 */
export interface Live {
  /** 空闲配置与待验证发送的代次，阻止目录查询回来后复活已取消的工作。 */
  revision: number
  active: TurnExecution | null
  row: SessionRow
  items: AgentItem[]
  /** 每轮独立进程，用 CLI 会话 id 续聊 */
  driver: CliDriver | null
  /** 这一轮已经开始到结束之间为 true，防止双击发送起两轮 */
  busy: boolean
  turnTimer: NodeJS.Timeout | null
  token: string
  mcp: McpServer
  /** 画布工具（MCP 和内置智能体共用一份，含确认关卡） */
  tools: McpTool[]
  /** 内置智能体这一轮的取消开关 */
  abort: AbortController | null
  listeners: Set<(e: AgentEvent) => void>
  stopped: boolean
  /** 当前这一轮的 id：CLI 的条目 id 加上它才保证唯一 */
  turn: string
  /** 改动集与按轮撤销 */
  changes: AgentChanges
  approvals: Approvals
  plan: AgentPlan
  /** 这一轮的确认方式 */
  mode: AgentApprovalMode
  releaseTimer: NodeJS.Timeout | null
}

/** 服务端启动智能体需要的依赖 */
export interface AgentDeps {
  canvasApi?: (ownerId: string, request: Request) => Promise<Response>
  mediaIndex?: import('../media-index/service').MediaIndex
  checkpoints?: import('../checkpoints/service').CheckpointService
  db: DB
  library: LibraryStore
  rooms: Rooms
  runs: NodeRuns
  host: PluginHost
  assets: AssetStore
  /** 文件进出服务（导入、上传、下载票据） */
  files?: import('../files/services').FileServices
  /** 修改方案（三种入口共用一份） */
  plans?: EditPlans
  dataDir: string
  /** 本机免登录模式才允许：调用 CLI 等于在服务端所在机器上以当前用户身份执行 */
  enabled: boolean
}

/**
 * 会话运行期上下文：条目事件、MCP 构造等拆出去的模块通过它读写会话。
 * 见 CONTRIBUTING.md「结构调整约定 › 数据访问」。
 */
export interface SessionEnv {
  readonly deps: AgentDeps
  readonly store: SessionStore
  readonly turns: TurnStore
}

/**
 * 会话状态机的端口：CLI 传输、内置回合等拆出去的模块只通过它驱动会话，
 * 不依赖 AgentSessions 的内部实现。
 */
export interface SessionHost {
  readonly env: SessionEnv
  /** MCP 地址：桌面端端口随机，服务端准备好后告知 */
  mcpUrl(): string
  /** 找本机 CLI；测试里换成假的 */
  detect(refresh?: boolean): Promise<CliEnvironment>
  /** 开始一轮：挂撤销栈、记用户消息、通知界面 */
  beginTurn(
    s: Live,
    text: string,
    selection?: string[],
    model?: string,
    skill?: AgentSkill,
    prompt?: string,
  ): TurnExecution
  /** 一轮结束（不论成败）：收尾工具、改动集、状态和租约 */
  endTurn(s: Live, turn: TurnExecution): void
  /** 拼这一轮发给模型的提示词 */
  prompt(s: Live, text: string, selection?: string[], skill?: AgentSkillDetail): string
  /** 停止会话当前这一轮 */
  stop(id: string, reason?: string): void
}

/** 每轮对话的上限，防止 CLI 卡住 */
export const TURN_TIMEOUT_MS = 60 * 60 * 1000
/** 没人看着（无事件订阅）也没在跑时，多久后释放画布租约；之后这个会话的改动不能再撤销 */
export const RELEASE_AFTER_MS = 10 * 60 * 1000

/** 会话配置 */
export function settingsOf(row: SessionRow): AgentSettings {
  try {
    return JSON.parse(row.settings) as AgentSettings
  } catch {
    return {}
  }
}

/** 会话的上下文统计 */
export function contextOf(row: SessionRow): AgentContext {
  try {
    return JSON.parse(row.context) as AgentContext
  } catch {
    return { source: 'unavailable', messages: 0 }
  }
}

export class AgentError extends Error {
  constructor(
    readonly code:
      | 'not_found'
      | 'busy'
      | 'disabled'
      | 'not_installed'
      | 'not_ready'
      | 'not_undoable'
      | 'invalid_input',
    message: string,
  ) {
    super(message)
  }
}
