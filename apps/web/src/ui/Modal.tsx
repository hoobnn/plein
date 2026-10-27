import { Dialog } from '@base-ui/react/dialog'
import { type ReactNode, useEffect, useRef } from 'react'
import { Icon } from './icons'
import { useClosing, useExit } from './Presence'
import { claimMenuEscape, hasMenuEscapeLayer, isMenuEscape } from './menuEscape'

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
  const popup = useRef<HTMLDivElement>(null)
  const escapeOwners = useRef(new WeakMap<Event, HTMLElement>())
  useEffect(() => {
    // 在 Base UI 的 document 监听之前记录归属；退场动画中的菜单仍拥有本次 Esc。
    const capture = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // 同级 React 根中的弹窗并不构成 Base UI 的嵌套树，按实际显示层级确定归属。
        // 在按键开始时固定，避免顶层收起后同一次按键又关闭下一层。
        const layers = [...document.querySelectorAll<HTMLElement>('[data-plein-modal-layer]')]
        const owner = layers.reduce<HTMLElement | undefined>(
          (top, el) =>
            !top || Number(el.dataset.pleinModalLayer) >= Number(top.dataset.pleinModalLayer)
              ? el
              : top,
          undefined,
        )
        if (owner) escapeOwners.current.set(event, owner)
      }
      if (event.key === 'Escape' && !event.isComposing && hasMenuEscapeLayer())
        claimMenuEscape(event)
    }
    window.addEventListener('keydown', capture, true)
    return () => window.removeEventListener('keydown', capture, true)
  }, [])
  return (
    <Dialog.Root
      open={!closing}
      onOpenChange={(open, details) => {
        const event = details.event
        // 内层若在 Base UI 请求关闭前 preventDefault，约定为已处理本次 Esc，父弹窗保留。
        // 内层自己关闭时应直接调用 onClose；只需阻止浏览器默认行为的处理器不能借此请求父层关闭。
        // Base UI 自己的 preventDefault 在 onOpenChange 之后，不会拦住普通 Esc。
        if (
          !open &&
          details.reason === 'escape-key' &&
          (event.defaultPrevented ||
            (event instanceof KeyboardEvent && (event.isComposing || event.keyCode === 229)))
        ) {
          details.cancel()
          return
        }
        const owner = escapeOwners.current.get(event)
        if (!open && details.reason === 'escape-key' && owner && owner !== popup.current) {
          details.cancel()
          details.allowPropagation()
          return
        }
        // 同一个 Esc 只关闭按键开始时最上层的菜单，不影响之后退出父面板。
        if (!open && details.reason === 'escape-key' && isMenuEscape(details.event)) {
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
            ref={popup}
            data-plein-modal-layer={closing ? undefined : top ? 50 : 40}
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
      className={`relative flex min-h-14 flex-none flex-wrap items-center gap-x-3 gap-y-2 py-2.5 pr-14 pl-5 ${
        divider ? 'border-b border-line' : ''
      }`}
    >
      <h2 className="min-w-0 flex-1 basis-full text-lg font-semibold break-words sm:basis-auto">
        {title}
      </h2>
      {meta}
      {children && (
        <div className="ml-auto flex max-w-full shrink-0 flex-wrap items-center gap-2">
          {children}
        </div>
      )}
      <button
        type="button"
        aria-label="关闭"
        title="关闭（Esc）"
        disabled={closeDisabled}
        onClick={onClose}
        className="ui-btn ui-btn-quiet ui-icon-btn absolute top-2.5 right-3"
      >
        <Icon name="x" />
      </button>
    </header>
  )
}
