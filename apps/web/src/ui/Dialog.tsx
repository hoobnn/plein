import { Dialog } from '@base-ui/react/dialog'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Presence, useClosing, useExit } from './Presence'

/**
 * 应用内的确认框 / 输入框，替代浏览器原生的 confirm() / prompt()。
 * 用法：`if (!(await confirmDialog({...}))) return`、`const name = await promptDialog({...})`。
 * 由 <DialogHost /> 渲染，同一时间只显示一个。基于 Base UI Dialog：焦点圈在对话框里，关闭后还给原来的元素。
 */

interface ConfirmOptions {
  title: string
  message?: string
  confirmLabel?: string
  cancelLabel?: string
  /** 删除等不可撤销的操作：确认按钮用危险色 */
  danger?: boolean
}

interface PromptOptions {
  title: string
  message?: string
  defaultValue?: string
  placeholder?: string
  confirmLabel?: string
  cancelLabel?: string
  maxLength?: number
  /** 异步确认成功后关闭；失败保留输入。关闭等待窗口不取消已发出的请求。 */
  onConfirm?(value: string): Promise<void>
}

type Request = { id: number } & (
  | { kind: 'confirm'; options: ConfirmOptions; resolve(v: boolean): void }
  | { kind: 'prompt'; options: PromptOptions; resolve(v: string | null): void }
)

let current: Request | null = null
let nextId = 0
const listeners = new Set<() => void>()
const emit = () => {
  for (const l of listeners) l()
}

type Pending = Request extends infer R ? (R extends Request ? Omit<R, 'id'> : never) : never

function open(pending: Pending) {
  const req = { ...pending, id: ++nextId } as Request
  // 已有对话框时，先按取消关掉旧的
  if (current) settle(null)
  current = req
  emit()
}

function settle(value: boolean | string | null) {
  const req = current
  if (!req) return
  current = null
  emit()
  if (req.kind === 'confirm') req.resolve(value === true)
  else req.resolve(typeof value === 'string' ? value : null)
}

/** 当前有没有对话框开着：外层面板的 Esc 处理要让给对话框 */
export const dialogOpen = () => current !== null

export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => open({ kind: 'confirm', options, resolve }))
}

/** 取消或留空时返回 null，否则返回去掉首尾空白的文本 */
export function promptDialog(options: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => open({ kind: 'prompt', options, resolve }))
}

export function DialogHost() {
  const req = useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => current,
  )
  return <Presence>{req && <DialogView key={req.id} req={req} />}</Presence>
}

function DialogView({ req }: { req: Request }) {
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
      if (current?.id === req.id) settle(value)
    },
    [req.id],
  )

  // Esc 自己处理并停止传播，不交给 Base UI：外层面板的 Esc 处理用 dialogOpen() 让位
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (current?.id !== req.id) return
      if (e.key === 'Escape' && !e.isComposing) {
        e.stopPropagation()
        finish(null)
      }
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [finish, req.id])

  const value = text.trim()
  const canConfirm = req.kind === 'confirm' || value !== ''
  const confirm = async () => {
    if (!canConfirm || busyRef.current || current?.id !== req.id) return
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
      if (current?.id === req.id) {
        setError(err instanceof Error ? err.message : String(err))
        requestAnimationFrame(() => {
          if (current?.id === req.id) inputRef.current?.focus()
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
        <Dialog.Viewport className="fixed inset-0 z-60 flex items-center justify-center p-6">
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
            className="ui-dialog relative flex w-full max-w-100 flex-col gap-5 rounded-2xl bg-surface p-6 shadow-4 outline-none"
          >
            <div className="flex flex-col gap-1.5">
              <h2 className="text-lg font-semibold">{options.title}</h2>
              {options.message && (
                <p className="text-sm leading-5 text-ink-muted">{options.message}</p>
              )}
            </div>
            {req.kind === 'prompt' && (
              <input
                ref={inputRef}
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
            <div className="flex justify-end gap-2">
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
