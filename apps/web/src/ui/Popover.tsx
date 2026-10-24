import { Popover as Base } from '@base-ui/react/popover'
import { type ReactNode, useEffect, useLayoutEffect, useRef } from 'react'
import { useClosing, useExit } from './Presence'

/**
 * 锚定在某个按钮上的弹层（Base UI Popover）：渲染到 body（不被面板的滚动裁掉），打开期间跟着锚点移动，
 * 默认优先放在锚点上方，放不下时翻到下方（placement="below" 反过来）；点外面或按 Esc 关闭，
 * 弹层里再开的弹层（如参数面板里的下拉框）算在里面，Esc 只关最上面那层。
 * 从锚点那一侧长出；包在 `<Presence>` 里时关闭也有收起动画。
 */
export function Popover({
  anchor,
  onClose,
  width = 320,
  label,
  placement = 'above',
  scrollKey,
  children,
}: {
  anchor: HTMLElement | null
  onClose(): void
  width?: number
  label: string
  placement?: 'above' | 'below'
  /** 内容步骤切换时回到顶部，输入字段变化不影响用户滚动。 */
  scrollKey?: string
  children: ReactNode
}) {
  const exit = useExit()
  const closing = useClosing()
  const popup = useRef<HTMLDivElement>(null)
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
    <Base.Root
      open={!closing}
      onOpenChange={(open, details) => {
        if (open) return
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
      <Base.Portal>
        <Base.Positioner
          anchor={anchor}
          side={placement === 'above' ? 'top' : 'bottom'}
          align="start"
          sideOffset={8}
          collisionPadding={8}
          className="z-70"
        >
          <Base.Popup
            ref={popup}
            aria-label={label}
            {...exit}
            style={{
              width,
              maxWidth: 'var(--available-width, calc(100vw - 16px))',
              // 放不下时保留最低高度，让定位器翻到另一侧，而不是压成一条；矮窗口里随视口收小
              maxHeight: 'min(480px, 70vh, max(var(--available-height, 70vh), min(200px, 40vh)))',
            }}
            className="ui-menu ui-scrollbar pointer-events-auto overflow-y-auto outline-none"
          >
            {children}
          </Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  )
}
