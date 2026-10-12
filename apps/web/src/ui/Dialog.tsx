import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'

/**
 * 应用内的确认框 / 输入框，替代浏览器原生的 confirm() / prompt()。
 * 用法：`if (!(await confirmDialog({...}))) return`、`const name = await promptDialog({...})`。
 * 由 <DialogHost /> 渲染，同一时间只显示一个。
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
  if (!req) return null
  return createPortal(<DialogView key={req.id} req={req} />, document.body)
}

function DialogView({ req }: { req: Request }) {
  const { options } = req
  const [text, setText] = useState(req.kind === 'prompt' ? (req.options.defaultValue ?? '') : '')
  const inputRef = useRef<HTMLInputElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (req.kind === 'prompt') inputRef.current?.select()
    else confirmRef.current?.focus()
  }, [req.kind])

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        settle(null)
      }
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [])

  const value = text.trim()
  const canConfirm = req.kind === 'confirm' || value !== ''
  const confirm = () => {
    if (!canConfirm) return
    settle(req.kind === 'confirm' ? true : value)
  }
  const danger = req.kind === 'confirm' && req.options.danger

  return (
    <div
      className="ui-dialog-scrim fixed inset-0 z-[60] flex items-center justify-center bg-scrim p-6"
      onPointerDown={() => settle(null)}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-label={options.title}
        className="ui-dialog flex w-full max-w-[400px] flex-col gap-5 rounded-2xl bg-surface p-6 shadow-[var(--shadow-4)]"
        onPointerDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          confirm()
        }}
      >
        <div className="flex flex-col gap-1.5">
          <h2 className="text-lg font-semibold">{options.title}</h2>
          {options.message && <p className="text-sm leading-5 text-ink-muted">{options.message}</p>}
        </div>
        {req.kind === 'prompt' && (
          <input
            ref={inputRef}
            className="ui-input ui-input-lg w-full"
            value={text}
            placeholder={req.options.placeholder}
            onChange={(e) => setText(e.target.value)}
          />
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="ui-btn ui-btn-secondary ui-btn-lg"
            onClick={() => settle(null)}
          >
            {options.cancelLabel ?? '取消'}
          </button>
          <button
            ref={confirmRef}
            type="submit"
            disabled={!canConfirm}
            className={`ui-btn ui-btn-lg ${danger ? 'ui-btn-danger-solid' : 'ui-btn-primary'}`}
          >
            {options.confirmLabel ?? '确定'}
          </button>
        </div>
      </form>
    </div>
  )
}
