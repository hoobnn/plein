import { flushSync } from 'react-dom'

/**
 * 整页级的同级切换（工作流 ↔ 故事板）：用 View Transitions 把旧画面往一侧滑出、新画面从另一侧滑入。
 * dir 是新视图相对旧视图的方向：next 从右边进来，prev 从左边进来。不支持或要求减少动态效果时直接切。
 */
export function slideView(dir: 'next' | 'prev', update: () => void) {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (!document.startViewTransition || reduce) {
    update()
    return
  }
  const root = document.documentElement
  root.dataset.viewSlide = dir
  const t = document.startViewTransition(() => flushSync(update))
  void t.finished.finally(() => {
    if (root.dataset.viewSlide === dir) delete root.dataset.viewSlide
  })
}
