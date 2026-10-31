import { z } from 'zod'
import { type GroupRunSummary, type JobStatus } from './runs'

/**
 * 服务端任务动态。桌面端里服务端经 parentPort 发给主进程，
 * 主进程据此显示 Dock 徽标和进度、发系统通知、有任务时退出前确认、阻止系统休眠。
 */
export type RunActivity =
  | {
      type: 'jobs'
      queued: number
      running: number
      /** 运行中且报告了进度的任务的平均进度（0–1）；都没报告时不给 */
      progress?: number
    }
  | {
      type: 'job-finished'
      canvasId: string
      nodeId: string
      groupId?: string
      /** 节点名，没有时用节点类型的标题 */
      title: string
      status: JobStatus
      error?: string
    }
  | {
      type: 'group-finished'
      canvasId: string
      /** 整组运行的 Frame，或“运行到此处 / 运行下游”的起点节点 */
      frameId: string
      title: string
      status: 'done' | 'canceled'
      summary: GroupRunSummary
    }

/** 桌面端 preload 暴露给页面的原生能力；浏览器里不存在（window.pleinDesktop 为 undefined） */
export type DesktopEditCommand = 'undo' | 'redo' | 'selectAll'
export type DesktopMenuCommand = DesktopEditCommand | 'settings' | 'updates'

/** 系统通知被点击：打开画布并定位到节点 */
export interface DesktopOpenNode {
  canvasId: string
  nodeId: string
}

/** 文件保存结果：savePath 只在保存成功时有 */
export interface DesktopSaved {
  name: string
  state: 'completed' | 'cancelled' | 'interrupted'
  savePath?: string
}

/** 新版本安装包的下载进度；字节数可能为 0（服务器没给长度） */
export interface DesktopUpdateProgress {
  version: string
  /** 0–100 */
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}

/** 来自更新源的版本说明；GitHub feed 提供 HTML，generic feed 也可提供 Markdown。 */
export interface DesktopUpdateRelease {
  version: string
  name?: string
  date?: string
  notes: Array<{ version: string; note: string }>
}

/** 主进程持有完整快照，页面重新加载后仍能恢复更新状态。 */
export interface DesktopUpdateState {
  phase: 'unavailable' | 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error'
  currentVersion: string
  release?: DesktopUpdateRelease
  progress?: DesktopUpdateProgress
  checkedAt?: number
  /** 下次自动检查的时刻；没有安排检查时没有 */
  nextCheckAt?: number
  error?: { operation: 'check' | 'download' | 'install'; message: string }
  reason?: string
}

/** 应用打开期间的检查间隔（小时）；0 表示不定期检查 */
export const UpdateIntervalHours = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(3),
  z.literal(6),
  z.literal(12),
  z.literal(24),
])
export type DesktopUpdateIntervalHours = z.infer<typeof UpdateIntervalHours>

/** 自动更新偏好：启动时是否检查、应用打开期间多久检查一次 */
export const UpdatePreferences = z.object({
  checkOnLaunch: z.boolean(),
  intervalHours: UpdateIntervalHours,
})
export type DesktopUpdatePreferences = z.infer<typeof UpdatePreferences>

/** 默认启动时检查一次，应用打开期间每 6 小时检查一次 */
export const DEFAULT_UPDATE_PREFERENCES: DesktopUpdatePreferences = {
  checkOnLaunch: true,
  intervalHours: 6,
}

export interface DesktopBridge {
  platform: string
  onMenuCommand(listener: (command: DesktopMenuCommand) => void): () => void
  nativeEdit(command: DesktopEditCommand): Promise<void>
  /** 在系统文件管理器里打开数据目录 */
  openDataDir(): Promise<void>
  /** 点击系统通知后要定位的节点 */
  onOpenNode(listener: (target: DesktopOpenNode) => void): () => void
  /** 下载（另存为）结束 */
  onSaved(listener: (saved: DesktopSaved) => void): () => void
  /** 在访达 / 资源管理器里显示刚保存的文件；只接受本次运行中保存过的路径 */
  showSavedFile(path: string): Promise<void>
  getUpdateState(): Promise<DesktopUpdateState>
  checkForUpdates(): Promise<void>
  downloadUpdate(): Promise<void>
  installUpdate(): Promise<void>
  onUpdateState(listener: (state: DesktopUpdateState) => void): () => void
  /** 读取自动更新偏好 */
  getUpdatePreferences(): Promise<DesktopUpdatePreferences>
  /** 保存自动更新偏好；取值不合法时主进程拒绝写入 */
  setUpdatePreferences(preferences: DesktopUpdatePreferences): Promise<DesktopUpdatePreferences>
}
