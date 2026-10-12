import type { DesktopOpenNode, RunActivity } from '@plein/protocol'
import { app, type BrowserWindow, Notification, powerSaveBlocker } from 'electron'

/** 连续结束的任务攒一会儿再发通知，批量生成时不刷屏 */
const NOTIFY_DELAY_MS = 1500

type Finished = Extract<RunActivity, { type: 'job-finished' }>

/**
 * 服务端任务动态在桌面上的表现：
 * - Dock 徽标显示排队和运行中的任务数，Dock 图标上显示平均进度；
 * - 有任务时阻止系统休眠（屏幕可以关）；
 * - 窗口不在前台时，任务和整组运行结束发系统通知，点通知回到对应节点。
 */
export class Activity {
  /** 排队和运行中的任务数，退出前确认用 */
  pending = 0
  private blocker: number | null = null
  private finished: Finished[] = []
  private timer: NodeJS.Timeout | null = null

  constructor(
    private window: () => BrowserWindow | null,
    private open: (target: DesktopOpenNode) => void,
  ) {}

  handle(e: RunActivity) {
    if (e.type === 'jobs') return this.jobs(e.queued + e.running, e.progress)
    if (e.type === 'group-finished') return this.group(e)
    // 整组里的单个任务不单独通知，等整组结束
    if (e.groupId || e.status === 'canceled') return
    this.finished.push(e)
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), NOTIFY_DELAY_MS)
  }

  /** 服务端重启或退出：之前的计数作废 */
  reset() {
    this.jobs(0)
    this.finished = []
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private jobs(pending: number, progress?: number) {
    this.pending = pending
    app.dock?.setBadge(pending ? String(pending) : '')
    const win = this.window()
    if (win && !win.isDestroyed())
      win.setProgressBar(pending && progress !== undefined ? progress : -1)
    if (pending && this.blocker === null)
      this.blocker = powerSaveBlocker.start('prevent-app-suspension')
    if (!pending && this.blocker !== null) {
      powerSaveBlocker.stop(this.blocker)
      this.blocker = null
    }
  }

  /** 用户正看着窗口时，画布上的状态和提示已经够了 */
  private away() {
    const win = this.window()
    return !win || win.isDestroyed() || !win.isVisible() || !win.isFocused()
  }

  private flush() {
    this.timer = null
    const list = this.finished
    this.finished = []
    if (!list.length || !this.away()) return
    const failed = list.filter((e) => e.status === 'failed')
    const first = failed[0] ?? list[0]!
    if (list.length === 1) {
      this.notify(
        first.status === 'failed' ? `生成失败：${first.title}` : `生成完成：${first.title}`,
        first.status === 'failed' ? (first.error ?? '点击查看详情') : '点击回到画布查看结果',
        first,
      )
      return
    }
    const ok = list.length - failed.length
    this.notify(
      failed.length ? `${ok} 个任务完成，${failed.length} 个失败` : `${ok} 个任务已完成`,
      list
        .slice(0, 3)
        .map((e) => e.title)
        .join('、') + (list.length > 3 ? ' 等' : ''),
      first,
    )
  }

  private group(e: Extract<RunActivity, { type: 'group-finished' }>) {
    if (e.status === 'canceled' || !this.away()) return
    const s = e.summary
    const parts = [
      s.succeeded && `成功 ${s.succeeded}`,
      s.cached && `沿用 ${s.cached}`,
      s.failed && `失败 ${s.failed}`,
      s.skipped && `跳过 ${s.skipped}`,
    ].filter(Boolean)
    this.notify(
      s.failed ? `批量运行有失败：${e.title}` : `批量运行完成：${e.title}`,
      parts.join(' · ') || '没有需要运行的节点',
      { canvasId: e.canvasId, nodeId: e.frameId },
    )
  }

  private notify(title: string, body: string, target: DesktopOpenNode) {
    if (!Notification.isSupported()) return
    const n = new Notification({ title, body })
    n.on('click', () => this.open({ canvasId: target.canvasId, nodeId: target.nodeId }))
    n.show()
  }
}
