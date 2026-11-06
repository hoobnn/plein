import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ExternalMcpAuditEntry } from '@plein/protocol'

const MAX_BYTES = 1024 * 1024

/** 外部调用的审计日志（JSON Lines）：工具名、令牌名、时间、结果；不记参数，避免把大字段或隐私写进日志 */
export class McpAudit {
  private file: string

  constructor(dataDir: string) {
    this.file = join(dataDir, 'external-mcp-audit.jsonl')
  }

  record(entry: ExternalMcpAuditEntry) {
    try {
      if (existsSync(this.file) && statSync(this.file).size > MAX_BYTES)
        renameSync(this.file, `${this.file}.1`)
      appendFileSync(this.file, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
    } catch (err) {
      // 审计写不进去不应该让调用失败，但要留下线索
      console.warn('[mcp] 审计日志写入失败：', err)
    }
  }

  /** 最近的记录，新的在前 */
  recent(limit = 100): ExternalMcpAuditEntry[] {
    if (!existsSync(this.file)) return []
    const lines = readFileSync(this.file, 'utf8').trim().split('\n').filter(Boolean)
    return lines
      .slice(-limit)
      .reverse()
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as ExternalMcpAuditEntry]
        } catch {
          return []
        }
      })
  }
}
