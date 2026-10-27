import { useEffect, useRef, useState } from 'react'
import {
  isEquirectangular,
  PANORAMA_MAX_BYTES,
  PANORAMA_MAX_PIXELS,
  panoramaSceneRevision,
  panoramaSize,
  projectPanorama,
  sceneViewProblem,
  type PanoramaPose,
} from '@plein/nodes'
import type { LibraryItem } from '@plein/protocol'
import { api, ApiError, assetUrls } from '../../api/client'
import { Modal, ModalHeader } from '../../ui/Modal'
import { Select } from '../../ui/Select'
import { useSession } from '../../stores/session'
import { useCanvas } from '../../stores/canvas'
import { PoseControl } from './PoseControl'

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value))
const yawOf = (value: number) => ((((value + 180) % 360) + 360) % 360) - 180

export default function PanoramaDialog({
  item,
  sourceAssetId,
  readOnly,
  isCurrent,
  onSaved,
  onClose,
}: {
  item: LibraryItem
  sourceAssetId: string
  readOnly: boolean
  isCurrent(): boolean
  onSaved(item: LibraryItem): void
  onClose(): void
}) {
  const principal = useSession((state) => state.info?.principal)
  const engine = useCanvas((state) => state.engine)
  const actor = useRef(principal?.id)
  const writable =
    !readOnly &&
    !!principal &&
    principal.id === actor.current &&
    principal.role !== 'viewer' &&
    !engine?.doc.readOnly
  const current = useRef(isCurrent)
  current.current = isCurrent
  const [pose, setPose] = useState<PanoramaPose>({ yaw: 0, pitch: 0, fov: 55, format: 'landscape' })
  const [name, setName] = useState(() => {
    let n = 1,
      value = '全景视角'
    while (sceneViewProblem(item.sceneViews ?? [], value)) value = `全景视角${++n}`
    return value
  })
  const [description, setDescription] = useState('')
  const [source, setSource] = useState<ImageData | null>(null)
  const [loading, setLoading] = useState(true)
  const [retry, setRetry] = useState(0)
  const [busy, setBusy] = useState(false)
  const busyNow = useRef(busy)
  busyNow.current = busy
  const [conflicted, setConflicted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const mounted = useRef(true)
  const saving = useRef<AbortController | null>(null)
  const drag = useRef<{ id: number; x: number; y: number; yaw: number; pitch: number } | null>(null)
  const expected = panoramaSceneRevision(item)
  const size = panoramaSize(pose.format)
  const full = (item.sceneViews ?? []).length >= 24
  const nameProblem = sceneViewProblem(item.sceneViews ?? [], name)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      saving.current?.abort()
    }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    let active = true
    setLoading(true)
    setError(null)
    setSource(null)
    void (async () => {
      const meta = await api.assetMeta(sourceAssetId)
      if (
        meta.size > PANORAMA_MAX_BYTES ||
        (meta.width ?? 0) * (meta.height ?? 0) > PANORAMA_MAX_PIXELS
      )
        throw new Error('全景原图不能超过 3200 万像素或 64 MiB')
      const response = await fetch(assetUrls.variant(sourceAssetId, 'thumb-1024'), {
        signal: controller.signal,
      })
      if (!response.ok) throw new Error('全景图片读取失败')
      const bitmap = await createImageBitmap(await response.blob())
      try {
        if (!active) return
        if (!current.current()) throw new Error('场景或原图已变化，请关闭后重新打开全景')
        if (!isEquirectangular(bitmap.width, bitmap.height))
          throw new Error('请选择 2:1 等距柱状全景图片')
        const image = document.createElement('canvas')
        image.width = bitmap.width
        image.height = bitmap.height
        const ctx = image.getContext('2d')
        if (!ctx) throw new Error('当前浏览器不能读取全景像素')
        ctx.drawImage(bitmap, 0, 0)
        setSource(ctx.getImageData(0, 0, bitmap.width, bitmap.height))
      } finally {
        bitmap.close()
      }
    })()
      .catch((cause) => {
        if (active && !controller.signal.aborted) setError((cause as Error).message)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [sourceAssetId, retry])
  useEffect(() => {
    if (!source || !canvas.current) return
    const width = size.width / 2,
      height = size.height / 2
    const ctx = canvas.current.getContext('2d')
    if (!ctx) return
    canvas.current.width = width
    canvas.current.height = height
    ctx.putImageData(
      new ImageData(
        projectPanorama(source.data, source.width, source.height, pose, width, height),
        width,
        height,
      ),
      0,
      0,
    )
  }, [source, pose, size.width, size.height])
  useEffect(() => {
    if (!writable) saving.current?.abort()
  }, [writable])
  useEffect(() => {
    const element = canvas.current
    if (!element || !source) return
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      if (!busyNow.current)
        setPose((p) => ({ ...p, fov: clamp(p.fov + Math.sign(event.deltaY) * 3, 25, 100) }))
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  }, [source, loading])
  const close = () => {
    saving.current?.abort()
    onClose()
  }
  const capture = async () => {
    const now = useSession.getState().info?.principal
    if (
      !now ||
      now.id !== actor.current ||
      now.role === 'viewer' ||
      useCanvas.getState().engine?.doc.readOnly
    )
      return
    if (saving.current || busy || !writable || !source || nameProblem || conflicted || full) return
    if (!isCurrent()) {
      setConflicted(true)
      setError('场景或原图已变化，请关闭后重新打开全景')
      return
    }
    const controller = new AbortController()
    saving.current = controller
    setBusy(true)
    setError(null)
    try {
      const saved = await api.capturePanoramaView(
        item.id,
        {
          sourceAssetId,
          expected,
          name: name.trim(),
          description,
          pose,
        },
        controller.signal,
      )
      if (mounted.current && !controller.signal.aborted && isCurrent()) onSaved(saved)
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted) {
        setConflicted(
          cause instanceof ApiError &&
            (cause.status === 409 || cause.status === 403 || cause.status === 404),
        )
        setError((cause as Error).message)
      }
    } finally {
      if (saving.current === controller) saving.current = null
      if (mounted.current) setBusy(false)
    }
  }
  const control = (key: 'yaw' | 'pitch' | 'fov', label: string, min: number, max: number) => (
    <PoseControl
      label={label}
      value={pose[key]}
      min={min}
      max={max}
      disabled={busy}
      onChange={(value) => setPose((p) => ({ ...p, [key]: value }))}
    />
  )
  return (
    <Modal label="全景浏览与视角截图" onClose={close} top isolateKeys className="max-w-4xl">
      <ModalHeader title={`${item.name} · 全景`} onClose={close} />
      <div className="ui-scrollbar flex min-h-0 flex-col gap-4 overflow-y-auto p-5">
        <p className="ui-help">拖动查看朝向，滚轮调整垂直视角。方向键微调，+ / − 调整视角。</p>
        <div className="flex min-h-48 justify-center rounded-xl border border-line bg-surface-2 p-2">
          {loading ? (
            <p role="status" className="self-center text-sm">
              正在读取全景…
            </p>
          ) : (
            source && (
              <canvas
                ref={canvas}
                aria-label="全景透视预览"
                role="img"
                tabIndex={0}
                className="block max-h-96 max-w-full touch-none rounded-lg"
                onPointerDown={(e) => {
                  if (busy) return
                  e.currentTarget.focus()
                  e.currentTarget.setPointerCapture(e.pointerId)
                  drag.current = {
                    id: e.pointerId,
                    x: e.clientX,
                    y: e.clientY,
                    yaw: pose.yaw,
                    pitch: pose.pitch,
                  }
                }}
                onPointerMove={(e) => {
                  const start = drag.current
                  if (!start || start.id !== e.pointerId || busy) return
                  setPose((p) => ({
                    ...p,
                    yaw: yawOf(start.yaw - (e.clientX - start.x) * 0.3),
                    pitch: clamp(start.pitch + (e.clientY - start.y) * 0.3, -80, 80),
                  }))
                }}
                onPointerUp={() => {
                  drag.current = null
                }}
                onPointerCancel={() => {
                  drag.current = null
                }}
                onLostPointerCapture={() => {
                  drag.current = null
                }}
                onKeyDown={(e) => {
                  if (busy) return
                  const changes: Partial<PanoramaPose> =
                    e.key === 'ArrowLeft'
                      ? { yaw: yawOf(pose.yaw - 5) }
                      : e.key === 'ArrowRight'
                        ? { yaw: yawOf(pose.yaw + 5) }
                        : e.key === 'ArrowUp'
                          ? { pitch: clamp(pose.pitch + 5, -80, 80) }
                          : e.key === 'ArrowDown'
                            ? { pitch: clamp(pose.pitch - 5, -80, 80) }
                            : ['+', '='].includes(e.key)
                              ? { fov: clamp(pose.fov - 5, 25, 100) }
                              : e.key === '-'
                                ? { fov: clamp(pose.fov + 5, 25, 100) }
                                : {}
                  if (Object.keys(changes).length) {
                    e.preventDefault()
                    setPose((p) => ({ ...p, ...changes }))
                  }
                }}
              />
            )
          )}
        </div>
        {!source && !loading && (
          <button
            type="button"
            className="ui-btn ui-btn-secondary self-start"
            onClick={() => setRetry((value) => value + 1)}
          >
            重新读取全景
          </button>
        )}
        <div className="grid gap-4 sm:grid-cols-3">
          {control('yaw', '朝向（度）', -180, 180)}
          {control('pitch', '俯仰（度）', -80, 80)}
          {control('fov', '垂直视角（度）', 25, 100)}
        </div>
        <Select
          aria-label="截图画幅"
          value={pose.format}
          disabled={busy}
          options={[
            { value: 'landscape', label: '横屏 16:9' },
            { value: 'portrait', label: '竖屏 9:16' },
            { value: 'square', label: '方形 1:1' },
          ]}
          onChange={(value) => setPose((p) => ({ ...p, format: value as PanoramaPose['format'] }))}
        />
        <label className="ui-field">
          <span className="ui-label">视角名称</span>
          <input
            aria-label="视角名称"
            className="ui-input"
            value={name}
            maxLength={20}
            disabled={busy || !writable}
            aria-invalid={!!nameProblem}
            onChange={(e) => setName(e.target.value)}
          />
          {nameProblem && (
            <span role="alert" className="text-xs text-danger">
              {nameProblem}
            </span>
          )}
        </label>
        <label className="ui-field">
          <span className="ui-label">视角描述</span>
          <textarea
            aria-label="视角描述"
            className="ui-input"
            value={description}
            maxLength={800}
            disabled={busy || !writable}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <p className="ui-help">
          截图为 {size.width}×{size.height}{' '}
          PNG，保存到此场景的命名视角；生成时只使用该视角的截图。原全景保留为截取来源。
        </p>
        {full && (
          <p role="status" className="ui-help">
            已达到 24 个视角上限，请先移除不需要的视角。
          </p>
        )}
        {!writable && (
          <p role="status" className="ui-help">
            当前仅可浏览，不能保存视角。
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
      </div>
      <footer className="flex justify-end gap-2 border-t border-line px-5 py-3">
        <button type="button" className="ui-btn ui-btn-secondary" onClick={close}>
          {busy ? '取消截图' : '关闭'}
        </button>
        <button
          type="button"
          className="ui-btn ui-btn-primary"
          disabled={busy || !writable || loading || !source || !!nameProblem || conflicted || full}
          aria-busy={busy}
          onClick={() => void capture()}
        >
          {busy ? '正在保存视角…' : conflicted ? '请重新核对场景' : '保存为命名视角'}
        </button>
      </footer>
    </Modal>
  )
}
