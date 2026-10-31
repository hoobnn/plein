import { z } from 'zod'

export const MaintenanceSettings = z.object({
  autoBackup: z.boolean().default(true),
  intervalHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 30)
    .default(24),
  keepBackups: z.number().int().min(1).max(100).default(7),
  /** 最近上传的素材留足使用窗口；引用中的素材始终保留。 */
  unusedDays: z.number().int().min(1).max(3650).default(30),
  trashDays: z.number().int().min(1).max(365).default(30),
})
export type MaintenanceSettings = z.infer<typeof MaintenanceSettings>

export interface LocalBackup {
  id: string
  createdAt: number
  bytes: number
  files: number
  path: string
  /** 未纳入备份的符号链接路径（相对数据目录）。 */
  skippedSymlinks: string[]
  /** 原文件被符号链接替换而未纳入备份的素材 id。 */
  missingAssets: string[]
}

export interface MaintenanceStatus {
  settings: MaintenanceSettings
  running: 'backup' | 'cleanup' | 'restore' | 'settings' | null
  nextBackupAt: number | null
  lastAttemptAt: number | null
  lastBackupAt: number | null
  lastError: string | null
  backups: LocalBackup[]
  trash: Array<{ id: string; createdAt: number; assets: number; bytes: number; expiresAt: number }>
  /** 数据目录里被跳过的符号链接路径（相对数据目录）。 */
  skippedSymlinks: string[]
  /** 因权限不足而跳过、未纳入统计的目录（相对数据目录）。 */
  unreadableDirs: string[]
}

export interface DataSpace {
  total: number
  database: number
  originals: number
  derivatives: number
  temporary: number
  backups: number
  trash: number
  restored: number
  other: number
  assets: number
  referencedAssets: number
  unusedAssets: number
  reclaimableBytes: number
}

export interface CleanupPreview {
  token: string
  expiresAt: number
  assets: number
  bytes: number
  unusedDays: number
  /** 跨所有者、所有画布与历史候选、任务、资产库、模板和命名检查点共同保护。 */
  protectedAssets: number
}

export const MaintenanceToken = z.object({ token: z.string().uuid() })
export interface CleanupResult {
  id: string | null
  assets: number
  bytes: number
  expiresAt: number
}
export interface BackupRestored {
  path: string
  /** 在一个新目录生成完整副本；切换前先关闭 Plein。 */
  restartRequired: true
  /** 备份时原文件是符号链接而未纳入副本的素材 id。 */
  missingAssets: string[]
}
