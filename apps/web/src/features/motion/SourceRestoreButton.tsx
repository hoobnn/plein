import type { Engine } from '@plein/canvas-core'
import type { CanvasElement } from '@plein/doc'
import { CompositionSourceRef } from '@plein/plugin-sdk'
import { useEffect, useRef, useState } from 'react'
import { useCanvas } from '../../stores/canvas'
import { Icon } from '../../ui/icons'

/** 普通视频的源工程入口；渲染/SDK与恢复文档逻辑仅点击时加载。 */
export function SourceRestoreButton({
  engine,
  element,
  className,
}: {
  engine: Engine
  element: CanvasElement
  className: string
}) {
  const canvasId = useCanvas((state) => state.canvasId)
  const [busy, setBusy] = useState(false)
  const pending = useRef<AbortController | null>(null)
  const raw = element.kind === 'video' ? element.params?.compositionSource : undefined
  const source = CompositionSourceRef.safeParse(raw)
  const identity = JSON.stringify(raw)
  const target = engine.doc.elementMaps.get(element.id)
  useEffect(() => {
    setBusy(false)
    return () => {
      pending.current?.abort()
      pending.current = null
    }
  }, [engine, element.id, element.assetId, identity, target])
  const resume = async () => {
    if (busy || pending.current || !source.success || !canvasId || engine.doc.readOnly) return
    const request = new AbortController()
    pending.current = request
    setBusy(true)
    try {
      const { resumeMotionSource } = await import('./source')
      await resumeMotionSource(engine, element.id, canvasId, request.signal, {
        target,
        assetId: element.assetId!,
        source: source.data,
      })
    } catch (error) {
      if (
        !request.signal.aborted &&
        useCanvas.getState().engine === engine &&
        useCanvas.getState().canvasId === canvasId
      )
        useCanvas.getState().notify(`无法从源版本继续编辑：${(error as Error).message}`)
    } finally {
      if (pending.current === request) pending.current = null
      if (!request.signal.aborted) setBusy(false)
    }
  }
  if (raw === undefined) return null
  return (
    <button
      type="button"
      className={className}
      aria-label="从源版本继续编辑"
      disabled={busy || engine.doc.readOnly || !canvasId || !source.success}
      aria-busy={busy || undefined}
      title={
        !source.success
          ? '源工程身份不合法'
          : engine.doc.readOnly
            ? '当前画布为只读，不能恢复源工程'
            : '保留这份视频，新建对应源版本的动态合成和原素材'
      }
      onClick={() => void resume()}
    >
      <Icon name="pencil" size={14} />
      {busy ? '正在读取源版本…' : '从源版本继续编辑'}
    </button>
  )
}
