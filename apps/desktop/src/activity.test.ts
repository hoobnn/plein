import { EventEmitter } from 'node:events'
import type { DesktopOpenNode, RunActivity } from '@plein/protocol'
import type { BrowserWindow } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { Activity } from './activity'

const desktop = vi.hoisted(() => ({
  badge: vi.fn(),
  start: vi.fn(() => 7),
  stop: vi.fn(),
  supported: true,
  notifications: [] as Array<{ title: string; body: string; click: () => void }>,
}))
vi.mock('electron', () => ({
  app: { dock: { setBadge: desktop.badge } },
  powerSaveBlocker: { start: desktop.start, stop: desktop.stop },
  Notification: class extends EventEmitter {
    static isSupported() {
      return desktop.supported
    }
    constructor(private options: { title: string; body: string }) {
      super()
    }
    show() {
      desktop.notifications.push({ ...this.options, click: () => this.emit('click') })
    }
  },
}))

const finished = (patch: Partial<Extract<RunActivity, { type: 'job-finished' }>> = {}) => ({
  type: 'job-finished' as const,
  canvasId: 'canvas',
  nodeId: 'node',
  title: '镜头',
  status: 'succeeded' as const,
  ...patch,
})

let activity: Activity
let open: ReturnType<typeof vi.fn<(target: DesktopOpenNode) => void>>
let win: {
  isDestroyed: () => boolean
  isVisible: () => boolean
  isFocused: () => boolean
  setProgressBar: ReturnType<typeof vi.fn>
}

beforeEach(() => {
  vi.useFakeTimers()
  desktop.notifications.length = 0
  desktop.supported = true
  win = {
    isDestroyed: () => false,
    isVisible: () => true,
    isFocused: () => false,
    setProgressBar: vi.fn(),
  }
  open = vi.fn()
  activity = new Activity(() => win as unknown as BrowserWindow, open)
})
afterEach(() => {
  activity.reset()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('桌面任务动态', () => {
  it('任务数和进度更新，休眠阻止只申请一次，结束时释放', () => {
    activity.handle({ type: 'jobs', queued: 2, running: 1, progress: 0.25 })
    activity.handle({ type: 'jobs', queued: 0, running: 1 })
    expect(activity.pending).toBe(1)
    expect(desktop.badge).toHaveBeenLastCalledWith('1')
    expect(win.setProgressBar.mock.calls).toEqual([[0.25], [-1]])
    expect(desktop.start).toHaveBeenCalledTimes(1)
    activity.handle({ type: 'jobs', queued: 0, running: 0 })
    expect(desktop.stop).toHaveBeenCalledExactlyOnceWith(7)
    expect(desktop.badge).toHaveBeenLastCalledWith('')
  })

  it('连续任务合并通知，优先定位失败节点', () => {
    activity.handle(finished())
    vi.advanceTimersByTime(1000)
    activity.handle(finished({ nodeId: 'failed', status: 'failed', error: '平台故障' }))
    vi.advanceTimersByTime(1499)
    expect(desktop.notifications).toHaveLength(0)
    vi.advanceTimersByTime(1)
    expect(desktop.notifications).toHaveLength(1)
    expect(desktop.notifications[0]?.title).toBe('1 个任务完成，1 个失败')
    desktop.notifications[0]!.click()
    expect(open).toHaveBeenCalledExactlyOnceWith({ canvasId: 'canvas', nodeId: 'failed' })
  })

  it('单任务失败保留错误信息', () => {
    activity.handle(finished({ status: 'failed', error: '平台故障' }))
    vi.advanceTimersByTime(1500)
    expect(desktop.notifications[0]).toMatchObject({ title: '生成失败：镜头', body: '平台故障' })
  })

  it('组内单任务和取消的任务不单独通知', () => {
    activity.handle(finished({ groupId: 'group' }))
    activity.handle(finished({ status: 'canceled' }))
    vi.advanceTimersByTime(2000)
    expect(desktop.notifications).toHaveLength(0)
  })

  it('前台任务不通知，也不在后续离开窗口时补发', () => {
    win.isFocused = () => true
    activity.handle(finished())
    vi.advanceTimersByTime(1500)
    win.isFocused = () => false
    vi.advanceTimersByTime(2000)
    expect(desktop.notifications).toHaveLength(0)
  })

  it('重启时清除计数、通知计时器与休眠阻止', () => {
    activity.handle({ type: 'jobs', queued: 0, running: 1 })
    activity.handle(finished())
    activity.reset()
    expect(activity.pending).toBe(0)
    expect(desktop.stop).toHaveBeenCalledExactlyOnceWith(7)
    vi.advanceTimersByTime(2000)
    expect(desktop.notifications).toHaveLength(0)
  })

  it('整组完成通知汇总并定位 Frame，取消时不通知', () => {
    const group = {
      type: 'group-finished' as const,
      canvasId: 'canvas',
      frameId: 'frame',
      title: '分镜',
      status: 'done' as const,
      summary: { succeeded: 1, cached: 2, failed: 1, canceled: 0, skipped: 3 },
    }
    activity.handle({ ...group, status: 'canceled' })
    activity.handle(group)
    expect(desktop.notifications).toHaveLength(1)
    expect(desktop.notifications[0]).toMatchObject({
      title: '批量运行有失败：分镜',
      body: '成功 1 · 沿用 2 · 失败 1 · 跳过 3',
    })
    desktop.notifications[0]!.click()
    expect(open).toHaveBeenCalledWith({ canvasId: 'canvas', nodeId: 'frame' })
  })

  it('系统不支持通知时正常结束', () => {
    desktop.supported = false
    activity.handle(finished())
    vi.advanceTimersByTime(1500)
    expect(desktop.notifications).toHaveLength(0)
  })
})
