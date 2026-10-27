import { type ComponentProps, useEffect, useState } from 'react'

type EditorModule = Pick<typeof import('./Editor'), 'Editor'>
type EditorComponent = EditorModule['Editor']

/** 路由加载走普通状态更新，避免 Suspense retry 对首个画布施加额外等待。 */
export function createEditorLoader(load: () => Promise<EditorModule>) {
  let ready: EditorComponent | null = null
  let pending: Promise<EditorComponent> | null = null
  const open = () => {
    pending ??= load().then(
      (module) => {
        ready = module.Editor
        return ready
      },
      (error: unknown) => {
        pending = null
        throw error
      },
    )
    return pending
  }

  return function EditorLoader(props: ComponentProps<EditorComponent>) {
    const [Editor, setEditor] = useState(() => ready)
    const [error, setError] = useState<Error | null>(null)
    const [attempt, setAttempt] = useState(0)
    useEffect(() => {
      if (Editor) return
      let live = true
      open().then(
        (component) => {
          if (live) setEditor(() => component)
        },
        (error: unknown) => {
          if (live) setError(error instanceof Error ? error : new Error(String(error)))
        },
      )
      return () => {
        live = false
      }
    }, [Editor, attempt])

    if (Editor) return <Editor {...props} />
    if (error)
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center text-sm text-ink-muted">
          <p role="alert">工作区加载失败：{error.message}</p>
          <button
            type="button"
            className="ui-btn ui-btn-secondary"
            onClick={() => {
              setError(null)
              setAttempt((value) => value + 1)
            }}
          >
            重新打开
          </button>
        </div>
      )
    return (
      <div role="status" className="p-6 text-sm text-ink-muted">
        正在打开工作区…
      </div>
    )
  }
}

export const EditorLoader = createEditorLoader(() => import('./Editor'))
