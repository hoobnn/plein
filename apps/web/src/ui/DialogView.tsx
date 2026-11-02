import { Dialog } from '@base-ui/react/dialog'
import { m } from 'motion/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { DialogRequest } from './Dialog'
import {
  AnimatePresence,
  dialogVariants,
  fadeVariants,
  useOverlayClosing,
  useOverlayModal,
  useOverlayMotion,
} from './motion'

export function DialogPresence({
  req,
  isCurrent,
  onFinish,
}: {
  req: DialogRequest | null
  isCurrent(id: number): boolean
  onFinish(id: number, value: boolean | string | null): void
}) {
  return (
    <AnimatePresence>
      {req && <DialogView key={req.id} req={req} isCurrent={isCurrent} onFinish={onFinish} />}
    </AnimatePresence>
  )
}

export function DialogView({
  req,
  isCurrent,
  onFinish,
}: {
  req: DialogRequest
  isCurrent(id: number): boolean
  onFinish(id: number, value: boolean | string | null): void
}) {
  const { options } = req
  const [text, setText] = useState(req.kind === 'prompt' ? (req.options.defaultValue ?? '') : '')
  const inputRef = useRef<HTMLInputElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const alternateRef = useRef<HTMLButtonElement>(null)
  const popupRef = useRef<HTMLElement | null>(null)
  const closing = useOverlayClosing()
  const modal = useOverlayModal()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)
  const finish = useCallback(
    (value: boolean | string | null) => {
      onFinish(req.id, value)
    },
    [req.id, onFinish],
  )

  // Esc 自己处理并停止传播，不交给 Base UI：外层面板的 Esc 处理用 dialogOpen() 让位
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!isCurrent(req.id)) return
      if (e.key === 'Escape') {
        e.stopPropagation()
        if (e.isComposing || e.keyCode === 229) return
        finish(null)
      }
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [finish, req.id, isCurrent])

  // 退场动画保留 DOM，但焦点不能留在已关闭的对话框里：画布快捷键会把浮层内的按键让给浮层，
  // 紧接着按下的撤销会没有响应。关闭后焦点由 Base UI 还给原来的元素。
  useEffect(() => {
    if (!closing) return
    const active = document.activeElement
    if (active instanceof HTMLElement && popupRef.current?.contains(active)) active.blur()
  }, [closing])

  const value = text.trim()
  const canConfirm = req.kind === 'confirm' || value !== ''
  const confirm = async () => {
    if (!canConfirm || busyRef.current || !isCurrent(req.id)) return
    if (req.kind === 'confirm' || !req.options.onConfirm) {
      finish(req.kind === 'confirm' ? true : value)
      return
    }
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      await req.options.onConfirm(value)
      finish(value)
    } catch (err) {
      if (isCurrent(req.id)) {
        setError(err instanceof Error ? err.message : String(err))
        requestAnimationFrame(() => {
          if (isCurrent(req.id)) inputRef.current?.focus()
        })
      }
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }
  const danger = req.kind === 'confirm' && req.options.danger
  const popupMotion = useOverlayMotion(dialogVariants)
  const backdropMotion = useOverlayMotion(fadeVariants)

  return (
    <Dialog.Root
      open
      modal={modal}
      onOpenChange={(open, details) => {
        if (closing) {
          details.cancel()
          return
        }
        if (!open && details.reason !== 'escape-key') finish(null)
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop
          render={<m.div {...backdropMotion} />}
          className="ui-dialog-scrim ui-motion fixed inset-0 z-60 bg-scrim supports-backdrop-filter:backdrop-blur-xs"
        />
        <Dialog.Viewport className="app-dialog-viewport fixed inset-0 z-60 flex items-center justify-center p-4 sm:p-6">
          <Dialog.Popup
            ref={(node: HTMLElement | null) => {
              popupRef.current = node
            }}
            aria-label={options.title}
            initialFocus={
              req.kind === 'prompt'
                ? () => {
                    inputRef.current?.select()
                    return inputRef.current
                  }
                : () =>
                    (req.options.initialFocus === 'alternate' ? alternateRef.current : undefined) ??
                    confirmRef.current
            }
            render={
              <m.form
                {...popupMotion}
                onSubmit={(e) => {
                  e.preventDefault()
                  void confirm()
                }}
              />
            }
            className="ui-dialog ui-motion ui-scrollbar relative flex max-h-full w-full max-w-sm flex-col gap-4 overflow-y-auto rounded-xl bg-menu p-4 text-sm text-ink ring-1 ring-line outline-none [&>*]:shrink-0"
          >
            <div className="flex flex-col gap-2">
              <h2 className="text-base leading-none font-medium break-words">{options.title}</h2>
              {options.message && (
                <p className="ui-note break-words whitespace-pre-line text-ink-muted">
                  {options.message}
                </p>
              )}
            </div>
            {req.kind === 'prompt' && (
              <input
                ref={inputRef}
                aria-label={req.options.placeholder ?? options.title}
                className="ui-input w-full"
                value={text}
                placeholder={req.options.placeholder}
                maxLength={req.options.maxLength}
                disabled={busy}
                onChange={(e) => setText(e.target.value)}
              />
            )}
            {error && (
              <p role="alert" className="break-words text-sm text-danger">
                {error}
              </p>
            )}
            {busy && (
              <p role="status" className="text-xs text-ink-muted">
                正在{options.confirmLabel ?? '提交'}，关闭窗口后仍会继续执行。
              </p>
            )}
            <div className="flex shrink-0 flex-wrap justify-end gap-2">
              <button
                type="button"
                className="ui-btn ui-btn-secondary"
                onClick={() => finish(null)}
              >
                {busy ? '关闭' : (options.cancelLabel ?? '取消')}
              </button>
              {req.kind === 'confirm' && req.options.alternateLabel && (
                <button
                  ref={alternateRef}
                  type="button"
                  disabled={busy}
                  className="ui-btn ui-btn-secondary"
                  onClick={() => finish('alternate')}
                >
                  {req.options.alternateLabel}
                </button>
              )}
              <button
                ref={confirmRef}
                type="submit"
                disabled={!canConfirm || busy}
                className={`ui-btn ${danger ? 'ui-btn-danger-solid' : 'ui-btn-primary'}`}
              >
                {busy ? `${options.confirmLabel ?? '提交'}中…` : (options.confirmLabel ?? '确定')}
              </button>
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
