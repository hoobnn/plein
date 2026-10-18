import type { Engine } from '@plein/canvas-core'
import { useLayoutEffect, useRef, useState } from 'react'
import { downloadAll, type DownloadItem } from '../canvas/grid'
import { useCanvas } from '../stores/canvas'

interface State {
  running: boolean
  total: number
  done: number
  failed: number
  remaining: DownloadItem[]
  cancelled: boolean
}
const empty: State = {
  running: false,
  total: 0,
  done: 0,
  failed: 0,
  remaining: [],
  cancelled: false,
}

/** 固定点击时的素材快照；选区变化不替换队列，换画布则中止后续读取。 */
export function useBatchDownload(engine: Engine) {
  const [state, setState] = useState(empty)
  const canvasId = useCanvas((s) => s.canvasId)
  const pending = useRef<AbortController | null>(null)
  useLayoutEffect(() => {
    setState(empty)
    return () => {
      pending.current?.abort()
      pending.current = null
    }
  }, [engine, canvasId])

  const start = async (items: readonly DownloadItem[]) => {
    if (pending.current || !items.length) return
    const current = useCanvas.getState()
    if (current.engine !== engine || current.canvasId !== canvasId) return
    const controller = new AbortController()
    pending.current = controller
    const snapshot = items.map((item) => ({ ...item }))
    const active = () =>
      pending.current === controller &&
      useCanvas.getState().engine === engine &&
      useCanvas.getState().canvasId === canvasId
    setState({ ...empty, running: true, total: snapshot.length })
    const result = await downloadAll(snapshot, controller.signal, (done, failed) => {
      if (active()) setState((s) => ({ ...s, done, failed }))
    })
    if (!active()) return
    pending.current = null
    const cancelled = controller.signal.aborted
    setState({
      running: false,
      total: snapshot.length,
      done: result.started,
      failed: result.failed.length,
      remaining: result.remaining,
      cancelled,
    })
    const message = cancelled
      ? `已取消后续下载，${result.remaining.length} 个文件未下载`
      : result.failed.length
        ? `${result.failed.length} 个文件读取失败：${result.failed.map((item) => item.name).join('、')}`
        : `已交给浏览器下载 ${result.started} 个文件，请在浏览器中查看保存状态`
    current.notify(
      message,
      result.remaining.length
        ? {
            label: cancelled ? '继续下载' : '重试未下载',
            run: () => {
              void start(result.remaining)
            },
          }
        : undefined,
    )
  }
  return { ...state, start, cancel: () => pending.current?.abort() }
}
