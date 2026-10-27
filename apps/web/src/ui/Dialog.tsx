import { lazy, Suspense, useEffect, useSyncExternalStore } from 'react'
import { Presence } from './Presence'

const DialogView = lazy(() => import('./DialogView').then((m) => ({ default: m.DialogView })))

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

export type DialogRequest = { id: number } & (
  | { kind: 'confirm'; options: ConfirmOptions; resolve(v: boolean): void }
  | { kind: 'prompt'; options: PromptOptions; resolve(v: string | null): void }
)

let current: DialogRequest | null = null
let nextId = 0
const listeners = new Set<() => void>()
const emit = () => {
  for (const l of listeners) l()
}

type Pending = DialogRequest extends infer R
  ? R extends DialogRequest
    ? Omit<R, 'id'>
    : never
  : never

function open(pending: Pending) {
  const req = { ...pending, id: ++nextId } as DialogRequest
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

export function DialogHost({ active = true }: { active?: boolean } = {}) {
  const req = useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => current,
  )
  useEffect(() => {
    if (!active && req) settle(null)
  }, [active, req])
  if (!active) return null
  return (
    <Suspense fallback={null}>
      <Presence>
        {req && <DialogView key={req.id} req={req} isCurrent={isCurrent} onFinish={finish} />}
      </Presence>
    </Suspense>
  )
}

function isCurrent(id: number) {
  return current?.id === id
}

function finish(id: number, value: boolean | string | null) {
  if (isCurrent(id)) settle(value)
}
