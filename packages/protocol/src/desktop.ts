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
export type DesktopMenuCommand = DesktopEditCommand | 'settings'

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
  /** 更新包下载中持续推送进度，下载结束（成功或失败）推送 null */
  onUpdateProgress(listener: (progress: DesktopUpdateProgress | null) => void): () => void
}
