import type { Engine } from '@plein/canvas-core'
import { type NoticeAction, useCanvas } from '../stores/canvas'

interface Batch {
  done: number
  total: number
  finished: boolean
  notes: string[]
  action?: NoticeAction
}

const groups = new Map<Engine, Set<Batch>>()

/** 所有素材入口共用进度；切换画布后取消旧操作，迟到回调不影响新画布。 */
export function beginImport(engine: Engine, total: number) {
  const controller = new AbortController()
  const batch: Batch = { done: 0, total, finished: false, notes: [] }
  const group = groups.get(engine) ?? new Set<Batch>()
  groups.set(engine, group)
  group.add(batch)
  let off = () => {}
  const publish = () => {
    if (useCanvas.getState().engine !== engine) return
    useCanvas.getState().setImporting(
      [...group].reduce((sum, b) => ({ done: sum.done + b.done, total: sum.total + b.total }), {
        done: 0,
        total: 0,
      }),
    )
  }
  const finish = (notes: string[] = [], action?: NoticeAction) => {
    if (batch.finished) return
    batch.finished = true
    batch.done = batch.total
    batch.notes = notes
    batch.action = action
    off()
    if ([...group].every((b) => b.finished)) {
      groups.delete(engine)
      if (useCanvas.getState().engine !== engine) return
      useCanvas.getState().setImporting(null)
      const messages = [...group].flatMap((b) => b.notes)
      const action = [...group]
        .map((b) => b.action)
        .filter((a) => !!a)
        .at(-1)
      // 全部导入入口都结束时一定给个结论；否则进度条消失得太突然，用户不知道是否成功。
      useCanvas.getState().notify(messages.join('；') || '素材已就绪', action)
    } else publish()
  }
  if (useCanvas.getState().engine !== engine) {
    controller.abort()
    finish()
  } else {
    off = useCanvas.subscribe((state) => {
      if (state.engine !== engine) {
        controller.abort()
        finish()
      }
    })
    useCanvas.getState().notify(null)
    publish()
  }
  return {
    signal: controller.signal,
    progress(done: number, nextTotal = total) {
      if (batch.finished) return
      batch.done = done
      batch.total = nextTotal
      publish()
    },
    finish,
  }
}
