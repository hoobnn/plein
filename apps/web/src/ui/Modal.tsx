import { Dialog } from '@base-ui/react/dialog'
import { type ReactNode, useEffect, useRef } from 'react'
import { Icon } from './icons'
import { useClosing, useExit } from './Presence'

/**
 * 盖住整个窗口的面板（设置、生成历史、分镜表、序列、快捷键），基于 Base UI Dialog：
 * 遮罩淡入、面板弹出，点遮罩关闭；打开时焦点移进面板并圈在里面，关闭后还给原来的元素，背后页面不滚动。
 * Esc 关闭最上面的一层（面板里的下拉、弹层先关）；要先关面板里其他子层的面板，在捕获阶段自己拦下 Esc。
 * 打开处包一层 `<Presence>`，关闭时遮罩淡出、面板收起。
 */
export function Modal({
  label,
  onClose,
  align = 'center',
  top = false,
  isolateKeys = false,
  initialFocus,
  className = '',
  children,
}: {
  label: string
  onClose(): void
  /** bottom：贴着底部工具条弹出（快捷键面板） */
  align?: 'center' | 'bottom'
  /** 盖在其他面板之上（设置可以从任何页面打开） */
  top?: boolean
  /** 焦点在面板里时，画布不响应键盘（删除、方向键等） */
  isolateKeys?: boolean
  /** 编辑类面板可直接聚焦正文，省去再次点击 */
  initialFocus?: React.RefObject<HTMLElement | null>
  /** 面板的尺寸和布局 */
  className?: string
  children: ReactNode
}) {
  const exit = useExit()
  const closing = useClosing()
  const menuEscapes = useRef(new WeakSet<Event>())
  useEffect(() => {
    // 在 Base UI 的 document 监听之前记录归属；回调时菜单可能已经收起。
    const capture = (event: KeyboardEvent) => {
      if (
        event.key === 'Escape' &&
        !event.isComposing &&
        document.querySelector('.ui-menu:not([data-closed]):not([data-closing])')
      )
        menuEscapes.current.add(event)
    }
    window.addEventListener('keydown', capture, true)
    return () => window.removeEventListener('keydown', capture, true)
  }, [])
  return (
    <Dialog.Root
      open={!closing}
      onOpenChange={(open, details) => {
        // 同一个 Esc 只关闭按键开始时最上层的菜单，不影响之后退出父面板。
        if (!open && details.reason === 'escape-key' && menuEscapes.current.has(details.event)) {
          details.cancel()
          return
        }
        if (!open) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop
          {...exit}
          className={`ui-dialog-scrim pointer-events-auto fixed inset-0 bg-scrim ${top ? 'z-50' : 'z-40'}`}
        />
        <Dialog.Viewport
          className={`pointer-events-auto fixed inset-0 flex justify-center p-4 sm:p-6 ${
            top ? 'z-50' : 'z-40'
          } ${align === 'bottom' ? 'items-end pb-16 sm:pb-16' : 'items-center'}`}
        >
          <Dialog.Popup
            aria-label={label}
            onKeyDown={(e) => {
              // 按钮上的原生撤销可能重新激活并修改背景中最后编辑过的文本框。
              const target = e.target
              if (
                !e.nativeEvent.isComposing &&
                (e.metaKey || e.ctrlKey) &&
                ['z', 'y'].includes(e.key.toLowerCase()) &&
                target instanceof HTMLElement &&
                !target.isContentEditable &&
                !(target instanceof HTMLInputElement) &&
                !(target instanceof HTMLTextAreaElement)
              )
                e.preventDefault()
            }}
            initialFocus={initialFocus}
            data-plein-active={isolateKeys ? '' : undefined}
            {...exit}
            className={`ui-dialog relative flex max-h-full w-full flex-col overflow-hidden rounded-2xl bg-surface shadow-4 outline-none ${className}`}
          >
            {children}
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/** 面板标题行：标题、紧跟标题的说明，右侧操作和关闭按钮 */
export function ModalHeader({
  title,
  meta,
  onClose,
  closeDisabled = false,
  divider = true,
  children,
}: {
  title: ReactNode
  meta?: ReactNode
  onClose(): void
  closeDisabled?: boolean
  /** 下面是滚动内容时加分隔线 */
  divider?: boolean
  children?: ReactNode
}) {
  return (
    <header
      className={`flex min-h-14 flex-none flex-wrap items-center gap-x-3 gap-y-2 py-2.5 pr-3 pl-5 ${
        divider ? 'border-b border-line' : ''
      }`}
    >
      <h2 className="truncate text-lg font-semibold">{title}</h2>
      {meta}
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {children}
        <button
          type="button"
          aria-label="关闭"
          title="关闭（Esc）"
          disabled={closeDisabled}
          onClick={onClose}
          className="ui-btn ui-btn-quiet ui-icon-btn"
        >
          <Icon name="x" />
        </button>
      </div>
    </header>
  )
}
