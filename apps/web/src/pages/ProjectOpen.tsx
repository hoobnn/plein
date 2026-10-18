import { useEffect, useState } from 'react'
import { api, ApiError } from '../api/client'
import { navigate } from '../router'

// 离开再返回时，复用已发出的创建请求，避免空项目出现多张首画布。
const creating = new Map<string, ReturnType<typeof api.createCanvas>>()
function firstCanvas(projectId: string) {
  let pending = creating.get(projectId)
  if (!pending) {
    pending = api.createCanvas(projectId, '画布 1').finally(() => creating.delete(projectId))
    creating.set(projectId, pending)
  }
  return pending
}

/** 打开项目：进入最近修改的画布；项目里一张画布都没有时先建一张 */
export function ProjectOpen({ id }: { id: string }) {
  const [error, setError] = useState<{ message: string; retryable: boolean } | null>(null)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let alive = true
    setError(null)
    ;(async () => {
      const p = await api.project(id)
      if (!alive) return
      const canvasId = p.lastCanvasId ?? (await firstCanvas(p.id)).id
      if (alive) navigate({ name: 'canvas', id: canvasId }, { replace: true })
    })().catch(
      (err: Error) =>
        alive &&
        setError({
          message: err.message,
          retryable:
            !(err instanceof ApiError) ||
            err.status >= 500 ||
            err.status === 408 ||
            err.status === 429,
        }),
    )
    return () => {
      alive = false
    }
  }, [id, revision])
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center text-sm text-ink-muted">
      {error ? (
        <>
          <p role="alert">打不开这个项目：{error.message}</p>
          {error.retryable && (
            <button
              type="button"
              className="ui-btn ui-btn-primary"
              onClick={() => {
                setError(null)
                setRevision((value) => value + 1)
              }}
            >
              重新打开
            </button>
          )}
        </>
      ) : (
        <p role="status" className="flex items-center gap-2">
          <span className="ui-spinner size-4" />
          正在打开项目…
        </p>
      )}
      <a href="#/" className="ui-btn ui-btn-secondary">
        回到项目列表
      </a>
    </div>
  )
}
