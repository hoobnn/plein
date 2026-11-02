import { Popover as Base } from '@base-ui/react/popover'
import { m, type HTMLMotionProps } from 'motion/react'
import { type ReactNode, useEffect, useLayoutEffect, useRef } from 'react'
import { LazyMotion } from './LazyMotion'
import { popVariants, useOverlayClosing, useOverlayMotion } from './motion'

/**
 * 锚定在某个按钮上的弹层（Base UI Popover）：渲染到 body（不被面板的滚动裁掉），打开期间跟着锚点移动，
 * 默认优先放在锚点上方，放不下时翻到下方（placement="below" 反过来）；点外面或按 Esc 关闭，
 * 弹层里再开的弹层（如参数面板里的下拉框）算在里面，Esc 只关最上面那层。
 * 从锚点那一侧长出；包在 `<AnimatePresence>` 里时关闭也有收起动画。
 */
export function Popover({
  anchor,
  onClose,
  width = 320,
  label,
  placement = 'above',
  scrollKey,
  container,
  initialFocus,
  children,
}: {
  anchor: HTMLElement | null
  onClose(): void
  width?: number
  label: string
  placement?: 'above' | 'below'
  /** 内容步骤切换时回到顶部，输入字段变化不影响用户滚动。 */
  scrollKey?: string
  container?: HTMLElement | null
  initialFocus?: boolean
  children: ReactNode
}) {
  const closing = useOverlayClosing()
  const popup = useRef<HTMLDivElement>(null)
  const motion = useOverlayMotion(popVariants)
  useLayoutEffect(() => {
    if (scrollKey !== undefined) popup.current?.scrollTo({ top: 0 })
  }, [scrollKey])
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    if (!anchor || closing) return
    // 内容保持挂载时，祖先收起仍会让锚点失去布局；Portal 中的浮层应随之关闭。
    const check = () => {
      if (!anchor.isConnected || anchor.getClientRects().length === 0) close.current()
    }
    const observer = new ResizeObserver(check)
    observer.observe(anchor)
    check()
    return () => observer.disconnect()
  }, [anchor, closing])
  return (
    <LazyMotion>
      <Base.Root
        open
        onOpenChange={(open, details) => {
          if (open) return
          // AnimatePresence 保留内容期间，Base UI 不再消费第二次关闭请求。
          if (closing) {
            details.cancel()
            return
          }
          // 锚点不是 Base UI 的 Trigger：点锚点交给锚点自己的 onClick 去切换，否则会先关再被重新打开
          const target = details.event?.target
          if (
            details.reason === 'outside-press' &&
            target instanceof Node &&
            anchor?.contains(target)
          )
            return
          onClose()
        }}
      >
        <Base.Portal container={container ?? undefined}>
          <Base.Positioner
            anchor={anchor}
            side={placement === 'above' ? 'top' : 'bottom'}
            align="start"
            sideOffset={4}
            collisionPadding={8}
            className="z-70"
          >
            <Base.Popup
              ref={popup}
              data-slot="popover-content"
              initialFocus={initialFocus}
              aria-label={label}
              render={(props, state) => {
                // Base UI 的 DOM animationstart 与 Motion 回调同名；这里未使用 DOM 监听器。
                const { onAnimationStart: _onAnimationStart, ...domProps } = props
                return (
                  <m.div
                    {...(domProps as HTMLMotionProps<'div'>)}
                    {...motion}
                    // 等 Base UI 确定碰撞后的 side 再开始进场，首帧不会沿请求方向。
                    initial={false}
                    animate={state.transitionStatus === 'starting' ? 'visible' : 'initial'}
                    custom={state.side === 'top' ? 'above' : 'below'}
                  />
                )
              }}
              style={{
                width,
                maxWidth: 'var(--available-width, calc(100vw - 16px))',
                // 放不下时保留最低高度，让定位器翻到另一侧，而不是压成一条；矮窗口里随视口收小
                // 最低高度不能高过窗口的三成：两侧都放不下时，弹层要留在窗口里，不能溢出屏幕
                maxHeight: 'min(480px, 70vh, max(var(--available-height, 70vh), min(200px, 30vh)))',
              }}
              className="ui-menu ui-motion ui-scrollbar pointer-events-auto flex origin-(--transform-origin) flex-col gap-2.5 overflow-y-auto rounded-lg bg-menu p-2.5 text-sm text-ink shadow-3 ring-1 ring-line outline-none"
            >
              {children}
            </Base.Popup>
          </Base.Positioner>
        </Base.Portal>
      </Base.Root>
    </LazyMotion>
  )
}
