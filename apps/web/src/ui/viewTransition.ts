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

/**
 * 首页 ↔ 画布：被点的项目卡片封面放大成画布（enter），回首页时画布缩回那张卡片（leave）。
 * Logo 和右侧操作区在两页里同名，跟着滑到新位置；其余内容淡入淡出。
 * from：旧页里要变成画布的元素；to：update 之后在新页里找要缩回的元素（不在视口里就只淡出）。
 * shape：from 和画布比例差得远（快速开始那种扁按钮）时传 'rect'，只借它的位置，不拉伸它的画面。
 */
export function zoomView(
  dir: 'enter' | 'leave',
  update: () => void,
  opts: { from?: Element | null; to?: () => Element | null; shape?: 'rect' } = {},
) {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (!document.startViewTransition || reduce) {
    update()
    return
  }
  const root = document.documentElement
  root.dataset.viewZoom = dir
  if (opts.shape) root.dataset.viewZoomShape = opts.shape
  const from = opts.from instanceof HTMLElement ? opts.from : null
  from?.style.setProperty('view-transition-name', 'app-stage')
  const t = document.startViewTransition(() => {
    flushSync(update)
    from?.style.removeProperty('view-transition-name')
    const to = opts.to?.()
    if (to instanceof HTMLElement && inViewport(to)) {
      to.style.setProperty('view-transition-name', 'app-stage')
      void t.finished.finally(() => to.style.removeProperty('view-transition-name'))
    }
  })
  void t.finished.finally(() => {
    if (root.dataset.viewZoom === dir) delete root.dataset.viewZoom
    delete root.dataset.viewZoomShape
  })
}

function inViewport(el: Element) {
  const r = el.getBoundingClientRect()
  return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth
}
