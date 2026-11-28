import { useEffect, useRef } from 'react'

/** 异步面板的轻量反馈；加载完成后由真实面板接管焦点和交互。 */
export function LoadingPanel({
  label,
  onClose,
  onRetry,
}: {
  label: string
  onClose?: () => void
  onRetry?: () => void
}) {
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!onClose) return
    const escape = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229
      )
        return
      // 前台还有对话框或菜单时，让它先处理自己的 Escape。
      if (
        document.querySelector(
          '[role="dialog"]:not([data-plein-exiting]), [role="alertdialog"], [role="menu"], [role="listbox"]',
        )
      )
        return
      const panels = document.querySelectorAll('[data-plein-pending-panel]')
      if (panels[panels.length - 1] !== root.current) return
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', escape, true)
    return () => window.removeEventListener('keydown', escape, true)
  }, [onClose])
  return (
    <div
      ref={root}
      data-plein-pending-panel=""
      className="pointer-events-none fixed inset-0 z-60 flex items-center justify-center p-4"
    >
      <div
        className={`w-full max-w-80 rounded-2xl border border-line bg-surface p-5 shadow-4 ${onClose ? 'pointer-events-auto' : ''}`}
      >
        <p
          role={onRetry ? 'alert' : 'status'}
          className={`flex items-center gap-2 text-sm ${onRetry ? 'text-danger' : 'text-ink-muted'}`}
        >
          {!onRetry && <span className="ui-spinner size-4" aria-hidden="true" />}
          {label}
        </p>
        {!onRetry && (
          <div aria-hidden="true" className="mt-4 flex flex-col gap-2">
            <div className="h-3 w-2/3 rounded bg-surface-2" />
            <div className="h-3 rounded bg-surface-2" />
            <div className="h-3 w-5/6 rounded bg-surface-2" />
          </div>
        )}
        {onClose && (
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className="ui-btn ui-btn-quiet ui-btn-sm" onClick={onClose}>
              {onRetry ? '关闭' : '取消'}
            </button>
            {onRetry && (
              <button type="button" className="ui-btn ui-btn-secondary ui-btn-sm" onClick={onRetry}>
                重试
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
