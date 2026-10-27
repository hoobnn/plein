import { Dialog } from '@base-ui/react/dialog'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { DialogRequest } from './Dialog'
import { useClosing, useExit } from './Presence'

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
  const closing = useClosing()
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
  const exit = useExit()

  return (
    <Dialog.Root
      open={!closing}
      onOpenChange={(open, details) => {
        if (!open && details.reason !== 'escape-key') finish(null)
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop {...exit} className="ui-dialog-scrim fixed inset-0 z-60 bg-scrim" />
        <Dialog.Viewport className="fixed inset-0 z-60 flex items-center justify-center p-4 sm:p-6">
          <Dialog.Popup
            {...exit}
            aria-label={options.title}
            initialFocus={
              req.kind === 'prompt'
                ? () => {
                    inputRef.current?.select()
                    return inputRef.current
                  }
                : confirmRef
            }
            render={
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  void confirm()
                }}
              />
            }
            className="ui-dialog ui-scrollbar relative flex max-h-full w-full max-w-100 flex-col gap-5 overflow-y-auto rounded-2xl bg-surface p-5 shadow-4 outline-none sm:p-6 [&>*]:shrink-0"
          >
            <div className="flex flex-col gap-1.5">
              <h2 className="text-lg font-semibold break-words">{options.title}</h2>
              {options.message && (
                <p className="text-sm leading-5 break-words text-ink-muted">{options.message}</p>
              )}
            </div>
            {req.kind === 'prompt' && (
              <input
                ref={inputRef}
                aria-label={req.options.placeholder ?? options.title}
                className="ui-input ui-input-lg w-full"
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
                className="ui-btn ui-btn-secondary ui-btn-lg"
                onClick={() => finish(null)}
              >
                {busy ? '关闭' : (options.cancelLabel ?? '取消')}
              </button>
              <button
                ref={confirmRef}
                type="submit"
                disabled={!canConfirm || busy}
                className={`ui-btn ui-btn-lg ${danger ? 'ui-btn-danger-solid' : 'ui-btn-primary'}`}
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
