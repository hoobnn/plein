import { useEffect, useState, useSyncExternalStore } from 'react'
import { Presence } from './Presence'
import { LoadingPanel } from './LoadingPanel'

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
  /** 第三个选项的文案（如「改为添加新组」）；要区分它和取消时用 choiceDialog */
  alternateLabel?: string
  /** 三选一时的初始焦点：默认落在确认按钮，推荐另一个做法时给 'alternate' */
  initialFocus?: 'confirm' | 'alternate'
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
  | { kind: 'confirm'; options: ConfirmOptions; resolve(v: boolean | 'alternate'): void }
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
  if (req.kind === 'confirm') req.resolve(value === true || value === 'alternate' ? value : false)
  else req.resolve(typeof value === 'string' ? value : null)
}

/** 当前有没有对话框开着：外层面板的 Esc 处理要让给对话框 */
export const dialogOpen = () => current !== null

export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) =>
    open({ kind: 'confirm', options, resolve: (v) => resolve(v === 'alternate' ? false : v) }),
  )
}

/** 三选一确认：确认返回 true，第三个选项返回 'alternate'，取消或 Esc 返回 false；可用 initialFocus 把初始焦点交给推荐项 */
export function choiceDialog(
  options: ConfirmOptions & { alternateLabel: string },
): Promise<boolean | 'alternate'> {
  return new Promise((resolve) =>
    open({ kind: 'confirm', options, resolve: (v) => resolve(v === 'alternate' ? v : !!v) }),
  )
}

/** 取消或留空时返回 null，否则返回去掉首尾空白的文本 */
export function promptDialog(options: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => open({ kind: 'prompt', options, resolve }))
}

/** 加载失败取消当前操作；下一次请求重新加载，不缓存失败的 Promise。 */
export function createDialogHost(
  load: () => Promise<Pick<typeof import('./DialogView'), 'DialogView'>>,
) {
  type View = (typeof import('./DialogView'))['DialogView']
  let ready: View | null = null
  let pending: Promise<View> | null = null
  const openView = () => {
    pending ??= load().then(
      (module) => (ready = module.DialogView),
      (error: unknown) => {
        pending = null
        throw error
      },
    )
    return pending
  }
  return function DialogHost({ active = true }: { active?: boolean } = {}) {
    const [DialogView, setView] = useState(() => ready)
    const [error, setError] = useState<Error | null>(null)
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
    useEffect(() => () => settle(null), [])
    useEffect(() => {
      if (!active || !req) return
      setError(null)
      if (DialogView) return
      let live = true
      openView().then(
        (view) => {
          if (live) setView(() => view)
        },
        (error: unknown) => {
          if (live) setError(error instanceof Error ? error : new Error(String(error)))
          finish(req.id, null)
        },
      )
      return () => {
        live = false
      }
    }, [active, req, DialogView])
    if (!active) return null
    return (
      <>
        {error && (
          <div className="fixed right-4 bottom-4 z-60 max-w-sm rounded-xl bg-surface p-4 text-sm shadow-4 ring-1 ring-line">
            <p role="alert">对话框加载失败：{error.message}。操作已取消，请重试操作或刷新页面。</p>
            <button
              type="button"
              className="ui-btn ui-btn-secondary mt-3"
              onClick={() => setError(null)}
            >
              关闭提示
            </button>
          </div>
        )}
        {req && !DialogView && <LoadingPanel label="正在打开对话框…" />}
        <Presence>
          {req && DialogView && (
            <DialogView key={req.id} req={req} isCurrent={isCurrent} onFinish={finish} />
          )}
        </Presence>
      </>
    )
  }
}

export const DialogHost = createDialogHost(() => import('./DialogView'))

function isCurrent(id: number) {
  return current?.id === id
}

function finish(id: number, value: boolean | string | null) {
  if (isCurrent(id)) settle(value)
}
