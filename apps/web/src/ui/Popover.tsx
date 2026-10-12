import { Popover as Base } from '@base-ui/react/popover'
import type { ReactNode } from 'react'
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
  children,
}: {
  anchor: HTMLElement | null
  onClose(): void
  width?: number
  label: string
  placement?: 'above' | 'below'
  children: ReactNode
}) {
  const exit = useExit()
  const closing = useClosing()
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
            aria-label={label}
            {...exit}
            style={{ width }}
            className="ui-menu ui-scrollbar pointer-events-auto max-h-[min(480px,70vh)] overflow-y-auto outline-none"
          >
            {children}
          </Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  )
}
