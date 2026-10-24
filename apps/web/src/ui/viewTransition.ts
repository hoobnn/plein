import { flushSync } from 'react-dom'

interface TransitionRun {
  transition: ViewTransition
  finish(): void
}
let active: TransitionRun | undefined

/** 再次选择当前可见视图时，也要取消尚未执行的另一个目标。 */
export function cancelViewTransition() {
  active?.transition.skipTransition()
  active?.finish()
}

/**
 * 同一时间只保留最新的转场。连续点击时先还原旧转场的临时标记，
 * 旧的 finished 回调不能再清除新转场的属性；skip 后的 ready 拒绝也被消费。
 */
function runTransition(
  update: () => void,
  prepare: (restore: (cleanup: () => void) => void) => (() => void) | undefined,
) {
  cancelViewTransition()
  if (
    !document.startViewTransition ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ) {
    update()
    return
  }
  const cleanups: Array<() => void> = []
  const restore = (cleanup: () => void) => cleanups.push(cleanup)
  const after = prepare(restore)
  let done = false
  const finish = () => {
    if (done) return
    done = true
    for (const cleanup of cleanups.reverse()) cleanup()
    if (active?.finish === finish) active = undefined
  }
  const transition = document.startViewTransition(() => {
    // 被后续操作取代但尚未执行的快照回调，不再改变页面。
    if (done) return
    flushSync(update)
    after?.()
  })
  active = { transition, finish }
  void transition.ready.catch(() => {})
  void transition.finished.then(finish, finish)
}

function mark(key: string, value: string, restore: (cleanup: () => void) => void) {
  const root = document.documentElement
  root.setAttribute(key, value)
  restore(() => root.removeAttribute(key))
}

/** 临时共享元素名称：结束后还原原来的内联样式，提前释放也可重复清理。 */
function nameStage(
  el: Element | null | undefined,
  name: string,
  restore: (cleanup: () => void) => void,
) {
  if (!(el instanceof HTMLElement)) return () => {}
  const previous = el.style.getPropertyValue('view-transition-name')
  const priority = el.style.getPropertyPriority('view-transition-name')
  let named = true
  el.style.setProperty('view-transition-name', name)
  const reset = () => {
    if (!named) return
    named = false
    if (previous) el.style.setProperty('view-transition-name', previous, priority)
    else el.style.removeProperty('view-transition-name')
  }
  restore(reset)
  return reset
}

/** 整页同级切换（工作流 ↔ 故事板）：保留方向关系，顶栏位置不变。 */
export function slideView(dir: 'next' | 'prev', update: () => void) {
  runTransition(update, (restore) => {
    mark('data-view-slide', dir, restore)
    return undefined
  })
}

/** 首页 ↔ 画布：封面放大成画布；返回时缩回原来的项目封面。 */
export function zoomView(
  dir: 'enter' | 'leave',
  update: () => void,
  opts: { from?: Element | null; to?: () => Element | null; shape?: 'rect' } = {},
) {
  runTransition(update, (restore) => {
    mark('data-view-zoom', dir, restore)
    if (opts.shape) mark('data-view-zoom-shape', opts.shape, restore)
    const reset = nameStage(opts.from, 'app-stage', restore)
    return () => {
      reset()
      const to = opts.to?.()
      if (to && inViewport(to)) nameStage(to, 'app-stage', restore)
    }
  })
}

function inViewport(el: Element) {
  const r = el.getBoundingClientRect()
  return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth
}

/** 资产卡 ↔ 档案：共享封面保持连续，其余内容交叉淡化。 */
export function morphView(
  update: () => void,
  from: Element | null | undefined,
  to: () => Element | null,
) {
  runTransition(update, (restore) => {
    mark('data-view-morph', '', restore)
    const src = from instanceof HTMLElement && inViewport(from) ? from : null
    const reset = nameStage(src, 'app-morph', restore)
    return () => {
      reset()
      const dst = to()
      if (src && dst && inViewport(dst)) nameStage(dst, 'app-morph', restore)
    }
  })
}
