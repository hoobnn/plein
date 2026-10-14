/** 对外开放的 MCP（让 Claude Desktop、Cursor 等连本机 Plein）：令牌只在生成时返回一次 */
export interface ExternalMcpStatus {
  enabled: boolean
  createdAt?: number
}

export interface ExternalMcpToken {
  token: string
  createdAt: number
}
