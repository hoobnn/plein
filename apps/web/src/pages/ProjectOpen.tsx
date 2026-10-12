import { useEffect, useState } from 'react'
import { api } from '../api/client'
import { navigate } from '../router'

/** 打开项目：进入最近修改的画布；项目里一张画布都没有时先建一张 */
export function ProjectOpen({ id }: { id: string }) {
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    ;(async () => {
      const p = await api.project(id)
      const canvasId = p.lastCanvasId ?? (await api.createCanvas(p.id, '画布 1')).id
      if (alive) navigate({ name: 'canvas', id: canvasId }, { replace: true })
    })().catch((err: Error) => alive && setError(err.message))
    return () => {
      alive = false
    }
  }, [id])
  if (!error) return null
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center text-sm text-ink-muted">
      <p>打不开这个项目：{error}</p>
      <a href="#/" className="ui-btn ui-btn-secondary">
        回到项目列表
      </a>
    </div>
  )
}
