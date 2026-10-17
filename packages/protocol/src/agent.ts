import { z } from 'zod'
import { ApplyEditPlan, type EditPlan, EditScope } from './edit-plan'

/**
 * 智能体：
 * - builtin 内置：用已启用平台里支持工具调用的对话模型（如千问），不用装 CLI；
 * - claude / codex：服务端调用用户电脑上已安装、已登录的 CLI，通过 Plein 的 MCP 工具读写画布，
 *   只在本机免登录模式（含桌面端）可用。
 */
export const AgentKind = z.enum(['builtin', 'claude', 'codex'])
export type AgentKind = z.infer<typeof AgentKind>

/**
 * 智能体花钱、删东西前要不要问用户：
 * rules 视频、整组运行、删用户已有的东西、一轮运行超过 6 次时问；always 每次运行和删除都问；auto 都不问。
 */
export const AgentApprovalMode = z.enum(['rules', 'always', 'auto'])
export type AgentApprovalMode = z.infer<typeof AgentApprovalMode>

/**
 * 本机 CLI（Claude Code、Codex）能在电脑上做多少事：
 * auto 读文件、查资料直接做，改文件、跑命令、用你自己的 MCP 工具前先在面板里问；full 完全放开，不再询问。
 * 画布上花钱、删除的确认仍按 AgentApprovalMode。
 */
export const AgentAccess = z.enum(['auto', 'full'])
export type AgentAccess = z.infer<typeof AgentAccess>

/** 本机 CLI 的安装、登录和版本状态（设置页用） */
export interface LocalCliInfo {
  id: Exclude<AgentKind, 'builtin'>
  name: string
  installed: boolean
  version?: string
  /** 可执行文件路径 */
  path?: string
  /** 是否已登录；null 表示查不出来（版本太旧或检查超时） */
  loggedIn: boolean | null
  /** npm 上的最新版本；查不到时没有 */
  latest?: string
  updateAvailable: boolean
  /** 一键更新会执行的命令；没有时只能手动更新 */
  updateCommand?: string
  /** 在终端里安装的命令 */
  installCommand: string
  /** 在终端里登录的命令 */
  loginCommand: string
}

export interface LocalCliUpdateResult {
  ok: boolean
  /** 命令输出的最后一段，失败时给用户看 */
  output: string
  cli: LocalCliInfo
}

export interface AgentCli {
  id: AgentKind
  name: string
  /** 能用：CLI 在本机找到了可执行文件；内置的有支持工具调用的对话模型 */
  available: boolean
  version?: string
  /** 内置智能体用的模型（给人看） */
  model?: string
}

export interface AgentStatus {
  /** 服务端是否允许启动本机智能体 */
  enabled: boolean
  /** 不可用的原因（给用户看） */
  reason?: string
  agents: AgentCli[]
}

/** 对话里的一项：用户消息、智能体回复、一次工具调用或错误 */
export type AgentItem =
  | { id: string; type: 'user'; text: string; selection?: string[]; at: number }
  | { id: string; type: 'text'; text: string; at: number }
  | {
      id: string
      type: 'tool'
      /** 工具名（Plein 工具不带 MCP 前缀） */
      name: string
      /** 参数摘要，给人看 */
      detail?: string
      status: 'running' | 'done' | 'error'
      /** 结果摘要 */
      output?: string
      at: number
    }
  | { id: string; type: 'error'; text: string; at: number }
  | {
      id: string
      /** 一轮对话对画布的改动，可整轮撤销 */
      type: 'changes'
      turn: string
      created: string[]
      updated: string[]
      deleted: string[]
      /** 新增与删除的连线数 */
      edges: number
      runs: number
      /** 现在能撤销：只能从最近一轮往回撤，服务重启或会话空闲太久后不能再撤 */
      undoable: boolean
      undone?: boolean
      at: number
    }
  | {
      id: string
      /** 计划：大任务先列步骤，用户同意后执行，逐步打勾。id 就是确认单 id */
      type: 'plan'
      summary?: string
      steps: Array<{ title: string; status: 'todo' | 'doing' | 'done' | 'skipped' }>
      status: 'pending' | 'approved' | 'denied' | 'expired'
      at: number
    }
  | {
      id: string
      /**
       * 修改方案：用户按范围批准（只改文字 / 只出候选图 / 完整方案）后服务端执行。
       * id 是确认单 id，plan 是方案的最新状态
       */
      type: 'edit_plan'
      plan: EditPlan
      status: 'pending' | 'approved' | 'denied' | 'expired'
      /** 用户批准的范围 */
      scope?: EditScope
      at: number
    }
  | {
      id: string
      /** 等用户确认的操作：允许后服务端直接执行 */
      type: 'approval'
      tool: string
      reason: string
      /** 相关元素 */
      ids: string[]
      status: 'pending' | 'approved' | 'denied' | 'expired'
      at: number
    }

export interface AgentSession {
  id: string
  canvasId: string
  agent: AgentKind
  title: string
  status: 'idle' | 'running'
  createdAt: number
  updatedAt: number
  items: AgentItem[]
  lastTurn?: AgentTurnSummary
}

export interface AgentTurnSummary {
  id: string
  state: 'running' | 'stopping' | 'completed' | 'failed' | 'stopped' | 'interrupted'
  reason?: string
  runs: Array<{ nodeId: string; runId: string }>
  groups: string[]
}

export type AgentSessionSummary = Omit<AgentSession, 'items'>

export const CreateAgentSession = z.object({ agent: AgentKind })
export type CreateAgentSession = z.infer<typeof CreateAgentSession>

export const SendAgentMessage = z.object({
  text: z.string().trim().min(1).max(20_000),
  /** 用户当前选中的元素 id，作为上下文告诉智能体 */
  selection: z.array(z.string().max(200)).max(200).optional(),
  /** 这一轮的确认方式，默认 rules */
  approval: AgentApprovalMode.optional(),
  /** 计划模式：先列计划，用户同意后才动手 */
  plan: z.boolean().optional(),
  /** 本机 CLI 的电脑权限，默认 auto */
  access: AgentAccess.optional(),
})
export type SendAgentMessage = z.infer<typeof SendAgentMessage>

/**
 * 用户处理一张确认单；修改方案的卡片允许时带上批准范围，
 * 以及逐项勾选的结果：只批准哪些目标（only）、哪些步骤不运行（skip）
 */
export const DecideAgentApproval = z.object({
  allow: z.boolean(),
  scope: EditScope.optional(),
  only: ApplyEditPlan.shape.only,
  skip: ApplyEditPlan.shape.skip,
})
export type DecideAgentApproval = z.infer<typeof DecideAgentApproval>

/** 会话事件流（SSE）：先推一次完整会话，之后推增量 */
export type AgentEvent =
  | { type: 'session'; session: AgentSession }
  | { type: 'item'; item: AgentItem }
  | { type: 'status'; status: AgentSession['status']; lastTurn?: AgentTurnSummary }
  /** 智能体刚改动了这些元素（画布上短暂高亮） */
  | { type: 'touch'; ids: string[] }
  /** 智能体请用户的画布执行界面动作：平滑定位到元素 / 选中元素 */
  | { type: 'ui'; action: 'focus' | 'select'; ids: string[] }
