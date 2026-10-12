import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * 锚定在某个按钮上的弹层：渲染到 body（不被面板的滚动裁掉），
 * 默认优先放在锚点上方，放不下时放下方（placement="below" 反过来）；点外面或按 Esc 关闭。
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
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<React.CSSProperties>({ visibility: 'hidden' })

  useLayoutEffect(() => {
    if (!anchor || !ref.current) return
    const a = anchor.getBoundingClientRect()
    const h = ref.current.offsetHeight
    const left = Math.max(8, Math.min(a.left, window.innerWidth - width - 8))
    const fitsAbove = a.top - 8 - h >= 8
    const fitsBelow = a.bottom + 8 + h <= window.innerHeight - 8
    const above = placement === 'above' ? fitsAbove : !fitsBelow && fitsAbove
    setPos(
      above
        ? { left, top: a.top - 8 - h }
        : { left, top: Math.min(a.bottom + 8, window.innerHeight - h - 8) },
    )
  }, [anchor, width, placement])

  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Node
      if (!ref.current?.contains(t) && !anchor?.contains(t)) onClose()
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('keydown', key, true)
    }
  }, [anchor, onClose])

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      style={{ ...pos, width }}
      className="ui-menu ui-scrollbar pointer-events-auto fixed z-[70] max-h-[min(480px,70vh)] overflow-y-auto"
    >
      {children}
    </div>,
    document.body,
  )
}
