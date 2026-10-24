import { type ReactNode, useLayoutEffect, useRef, useState } from 'react'

/**
 * 同级切换的滑动动画：
 * - SlidePill：放进一组按钮的容器里，选中底色从上一项滑到当前项（宽度不等、横排竖排都行）；
 * - SlideSwap：切换出来的内容按切换方向滑入。
 * 两者都尊重「减少动态效果」（见 controls.css 的 .ui-slide-*）。
 */

/** 组里的选中项：分段、工具条用 aria-pressed，页签用 aria-selected，导航用 aria-current */
const ACTIVE =
  ':scope > [aria-pressed="true"], :scope > [aria-selected="true"], :scope > [aria-current]:not([aria-current="false"])'

/**
 * 选中底色滑块。容器加 `ui-slide`（相对定位、隔离层叠），选中项自己的底色由 CSS 清掉，交给滑块画。
 * variant 决定滑块的样子，跟原来选中项的底色一致。
 */
export function SlidePill({
  variant = 'bar',
}: {
  variant?: 'bar' | 'seg' | 'tab' | 'accent' | 'menu'
}) {
  const ref = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const pill = ref.current
    const group = pill?.parentElement
    if (!pill || !group) return
    let ready = false
    let frame = 0
    const place = () => {
      const active = group.querySelector<HTMLElement>(ACTIVE)
      if (!active) {
        pill.dataset.hidden = ''
        return
      }
      delete pill.dataset.hidden
      pill.style.width = `${active.offsetWidth}px`
      pill.style.height = `${active.offsetHeight}px`
      pill.style.transform = `translate(${active.offsetLeft}px, ${active.offsetTop}px)`
      // 第一次直接就位，之后才有过渡，免得一打开就从左上角滑过来
      if (!ready) {
        ready = true
        frame = requestAnimationFrame(() => {
          pill.dataset.ready = ''
        })
      }
    }
    place()
    const mo = new MutationObserver(place)
    mo.observe(group, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['aria-pressed', 'aria-selected', 'aria-current', 'class'],
    })
    const ro = new ResizeObserver(() => {
      place()
      // 窗口/内容重排必须立即对齐，不能让旧尺寸的滑块在新布局外继续滑动。
      // 选中项变化仍走 MutationObserver，保留原本的连续位移。
      for (const animation of pill.getAnimations()) {
        if (animation instanceof CSSTransition) animation.finish()
      }
    })
    ro.observe(group)
    for (const el of group.children) {
      if (el !== pill) ro.observe(el)
    }
    return () => {
      mo.disconnect()
      ro.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [])
  return <span ref={ref} aria-hidden="true" className={`ui-slide-pill ui-slide-pill-${variant}`} />
}

/**
 * 内容切换：index 变大时新内容从右（或下）滑入，变小时从左（或上）滑入。
 * 默认用 key 换掉内容；preserveState 保留子树并重新播放切换动画。
 */
export function SlideSwap({
  index,
  axis = 'x',
  className = '',
  preserveState = false,
  children,
}: {
  index: number
  axis?: 'x' | 'y'
  className?: string
  preserveState?: boolean
  children: ReactNode
}) {
  const [state, setState] = useState({ index, dir: 0 })
  const root = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!preserveState) return
    for (const animation of root.current?.getAnimations() ?? []) {
      animation.cancel()
      animation.play()
    }
  }, [index, preserveState])
  if (state.index !== index) setState({ index, dir: index > state.index ? 1 : -1 })
  const from = state.dir === 0 ? '' : state.dir > 0 ? 'next' : 'prev'
  return (
    <div
      ref={root}
      key={preserveState ? 'persistent' : index}
      data-slide-from={from || undefined}
      data-slide-axis={axis}
      className={`ui-slide-swap ${className}`}
    >
      {children}
    </div>
  )
}
