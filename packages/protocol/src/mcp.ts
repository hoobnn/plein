import { z } from 'zod'

/** 对外开放的 MCP（让 Claude Desktop、Cursor 等连本机 Plein）：令牌只在生成时返回一次 */

/** 令牌权限：对应能力的副作用等级，令牌只能调用 scope 内的工具 */
export const EXTERNAL_MCP_SCOPES = ['read', 'edit', 'run', 'destructive'] as const
export type ExternalMcpScope = (typeof EXTERNAL_MCP_SCOPES)[number]

/** 令牌的公开信息（不含令牌本身） */
export interface ExternalMcpTokenInfo {
  id: string
  name: string
  scopes: ExternalMcpScope[]
  createdAt: number
  /** 最近一次被使用（进程内记录，重启后清空） */
  lastUsedAt?: number
  /** 每天最多运行（花钱）类调用次数；不设置 = 不限 */
  dailyRunLimit?: number
}

export interface ExternalMcpStatus {
  enabled: boolean
  /** 最早一枚令牌的创建时间 */
  createdAt?: number
  tokens: ExternalMcpTokenInfo[]
}

export const IssueExternalMcpToken = z.object({
  name: z.string().trim().min(1).max(40).default('未命名令牌'),
  scopes: z
    .array(z.enum(EXTERNAL_MCP_SCOPES))
    .min(1)
    .default([...EXTERNAL_MCP_SCOPES]),
  dailyRunLimit: z.number().int().min(1).max(10000).optional(),
})
export type IssueExternalMcpToken = z.input<typeof IssueExternalMcpToken>

export interface ExternalMcpToken extends ExternalMcpTokenInfo {
  token: string
}

/** 审计日志的一条记录：只记工具名、令牌、结果，不记参数 */
export interface ExternalMcpAuditEntry {
  at: number
  token: string
  tool: string
  ok: boolean
  code?: string
  canvasId?: string
}
