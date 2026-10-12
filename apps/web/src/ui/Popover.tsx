import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/** 当前打开的弹层，后开的在后面 */
const stack: Array<React.RefObject<HTMLDivElement | null>> = []

/**
 * 锚定在某个按钮上的弹层：渲染到 body（不被面板的滚动裁掉），打开期间跟着锚点移动，
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
    const el = ref.current
    if (!anchor || !el) return
    // 上下方向只在打开时定一次，之后跟着锚点平移，不会拖着拖着翻到另一边
    let side: 'above' | 'below' | null = null
    let last = ''
    const place = () => {
      const a = anchor.getBoundingClientRect()
      const h = el.offsetHeight
      if (!side) {
        const fitsAbove = a.top - 8 - h >= 8
        const fitsBelow = a.bottom + 8 + h <= window.innerHeight - 8
        side = (placement === 'above' ? fitsAbove : !fitsBelow && fitsAbove) ? 'above' : 'below'
      }
      const left = Math.max(8, Math.min(a.left, window.innerWidth - width - 8))
      const top =
        side === 'above' ? a.top - 8 - h : Math.min(a.bottom + 8, window.innerHeight - h - 8)
      const key = `${left},${top}`
      if (key === last) return
      last = key
      setPos({ left, top })
    }
    place()
    // 锚点会随画布平移缩放、面板滚动一起动：打开期间逐帧跟随，位置没变就不更新
    let raf = requestAnimationFrame(function loop() {
      place()
      raf = requestAnimationFrame(loop)
    })
    return () => cancelAnimationFrame(raf)
  }, [anchor, width, placement])

  // 回调和锚点放进 ref：监听只在挂载时注册一次，在弹层栈里的位置不会因重渲染而变
  const latest = useRef({ anchor, onClose })
  latest.current = { anchor, onClose }
  useEffect(() => {
    const self = ref
    stack.push(self)
    const above = () => stack.slice(stack.indexOf(self) + 1)
    const down = (e: PointerEvent) => {
      const t = e.target as Node
      // 弹层里再开的弹层（如参数面板里的下拉框）渲染在 body 上，点它不算点外面
      if (above().some((r) => r.current?.contains(t))) return
      if (!self.current?.contains(t) && !latest.current.anchor?.contains(t))
        latest.current.onClose()
    }
    const key = (e: KeyboardEvent) => {
      // Esc 只关最上面那层
      if (e.key === 'Escape' && above().length === 0) {
        e.stopPropagation()
        latest.current.onClose()
      }
    }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key, true)
    return () => {
      stack.splice(stack.indexOf(self), 1)
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('keydown', key, true)
    }
  }, [])

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
