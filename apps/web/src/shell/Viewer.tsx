import { adoptResult, creativeReviewTarget, currentResult, type NodeResult } from '@plein/doc'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { assetUrls } from '../api/client'
import { useCanvas } from '../stores/canvas'
import { Icon } from '../ui/icons'
import { Modal, ModalHeader } from '../ui/Modal'
import { useClosing } from '../ui/Presence'
import { CreativeReviewForm } from '../features/storyboard/CreativeReviewForm'
import { useStale } from '../features/runs/stale'

/** 审片状态只在浮层里；只有明确采用才写文档。 */
export function Viewer() {
  const viewer = useCanvas((s) => s.viewer)
  return viewer ? (
    <Review key={`${viewer.nodeId ?? ''}/${viewer.resultId ?? viewer.assetId}`} viewer={viewer} />
  ) : null
}

type View = NonNullable<ReturnType<typeof useCanvas.getState>['viewer']>

function Review({ viewer }: { viewer: View }) {
  const engine = useCanvas((s) => s.engine)
  const doc = engine?.doc
  useSyncExternalStore(
    (fn) => doc?.subscribe(fn) ?? (() => {}),
    () => doc?.get(viewer.nodeId ?? '') ?? null,
  )
  const element = doc?.get(viewer.nodeId ?? '')
  const stale = useStale((s) => s.nodes.has(viewer.nodeId ?? ''))
  const [port] = useState(() => element?.results?.find((r) => r.id === viewer.resultId)?.port)
  const candidates = element?.results?.filter((r) => r.port === port) ?? []
  const [selected, setSelected] = useState(viewer.resultId)
  const [compare, setCompare] = useState('')
  const [comparisonMissing, setComparisonMissing] = useState(false)
  const [comparison, setComparison] = useState<'side' | 'slider'>('side')
  const [split, setSplit] = useState(50)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const drag = useRef<{
    pointerId: number
    target: HTMLElement
    x: number
    y: number
    px: number
    py: number
  } | null>(null)
  const [dragging, setDragging] = useState(false)
  const stopDrag = useCallback(() => {
    const active = drag.current
    drag.current = null
    setDragging(false)
    if (active?.target.hasPointerCapture(active.pointerId))
      active.target.releasePointerCapture(active.pointerId)
  }, [])
  useEffect(() => {
    window.addEventListener('blur', stopDrag)
    return () => {
      window.removeEventListener('blur', stopDrag)
      stopDrag()
    }
  }, [stopDrag])
  const [imageLoads, setImageLoads] = useState<
    Record<string, { attempt: number; failed: boolean }>
  >({})
  const result = candidates.find((r) => r.id === selected)
  const value = result?.value
  const kind = value?.type ?? viewer.kind
  const assetId = value && 'assetId' in value ? value.assetId : viewer.assetId
  const other = candidates.find((r) => r.id === compare)
  const otherId = other?.value.type === 'image' ? other.value.assetId : undefined
  useEffect(() => stopDrag(), [selected, compare, comparison, assetId, kind, stopDrag])
  useEffect(() => {
    if (compare && !other) {
      setCompare('')
      setComparisonMissing(true)
    }
  }, [compare, other])
  const imageKey = `a:${assetId ?? ''}`
  const otherImageKey = `b:${otherId ?? ''}`
  const imageLabels = new Map<string, string>()
  if (assetId) imageLabels.set(imageKey, otherId ? '候选 A' : '图片')
  if (otherId) imageLabels.set(otherImageKey, '候选 B')
  const imageEvents = (id: string) => {
    const attempt = imageLoads[id]?.attempt ?? 0
    const status = (failed: boolean) =>
      setImageLoads((old) => {
        if ((old[id]?.attempt ?? 0) !== attempt || !!old[id]?.failed === failed) return old
        return { ...old, [id]: { attempt, failed } }
      })
    return { onError: () => status(true), onLoad: () => status(false) }
  }
  const adopted = element && result && currentResult(element, result.port)?.id === result.id
  const close = () => {
    stopDrag()
    useCanvas.getState().view(null)
  }
  const step = (delta: number) => {
    stopDrag()
    setComparisonMissing(false)
    const i = candidates.findIndex((r) => r.id === selected)
    const start = i >= 0 ? i : delta > 0 ? -1 : 0
    if (candidates.length)
      setSelected(candidates[(start + delta + candidates.length) % candidates.length]!.id)
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }
  const adopt = () => {
    if (!doc || !element || !result || doc.readOnly || adopted) return
    doc.undo.stopCapturing()
    adoptResult(doc, element.id, result.id)
    doc.undo.stopCapturing()
  }
  const label = (r: NodeResult) =>
    `候选 ${candidates.indexOf(r) + 1}${currentResult(element!, r.port)?.id === r.id ? ' · 已采用' : ''}`
  return (
    <Modal
      label={`查看「${viewer.name}」`}
      onClose={close}
      top
      isolateKeys
      className="h-[90vh] max-w-[96vw]"
    >
      <div
        role="group"
        aria-label="候选审片操作"
        tabIndex={-1}
        className="flex min-h-0 flex-1 flex-col"
        onPointerDown={(e) => {
          if (
            !(e.target as HTMLElement).closest(
              'button,a,[role=button],input,textarea,select,[contenteditable],video,audio',
            )
          )
            e.currentTarget.focus({ preventScroll: true })
        }}
        onKeyDown={(e) => {
          const target = e.target as HTMLElement
          if (
            target.closest('input,textarea,select,[contenteditable],video,audio,[data-review-node]')
          )
            return
          if (e.key === 'ArrowLeft') {
            e.preventDefault()
            e.stopPropagation()
            step(-1)
          }
          if (e.key === 'ArrowRight') {
            e.preventDefault()
            e.stopPropagation()
            step(1)
          }
          if (e.key === 'Enter') {
            if (target.closest('button,a,[role=button]')) return
            e.preventDefault()
            e.stopPropagation()
            adopt()
          }
        }}
      >
        <ModalHeader title={viewer.name} onClose={close}>
          {candidates.length > 0 && (
            <>
              <button
                type="button"
                aria-label="预览上一个候选"
                className="ui-btn ui-btn-secondary"
                onClick={() => step(-1)}
              >
                <Icon name="chevronLeft" />
              </button>
              <span className="text-xs text-ink-muted">
                {result ? label(result) : '候选已移除'} / {candidates.length}
              </span>
              <button
                type="button"
                aria-label="预览下一个候选"
                className="ui-btn ui-btn-secondary"
                onClick={() => step(1)}
              >
                <Icon name="chevronRight" />
              </button>
              <button
                type="button"
                disabled={!result || adopted || doc?.readOnly}
                className="ui-btn ui-btn-primary"
                onClick={adopt}
              >
                {adopted ? '已采用' : '采用此候选'}
              </button>
              <button
                type="button"
                className="ui-btn ui-btn-secondary"
                onClick={() => {
                  if (engine && element) {
                    engine.selection.set([element.id])
                    engine.zoomToFit([element.id])
                    close()
                  }
                }}
              >
                定位来源
              </button>
            </>
          )}
        </ModalHeader>
        {element && doc && result && value && 'assetId' in value && (
          <div className="max-h-56 shrink-0 overflow-auto border-b border-line px-4 py-2">
            {creativeReviewTarget(element)?.resultId === result.id ? (
              <CreativeReviewForm doc={doc} node={element} stale={stale} />
            ) : (
              <p className="text-xs text-ink-subtle">
                正在预览其他候选；采用此候选后可记录创作验收。
              </p>
            )}
          </div>
        )}
        {kind === 'image' && (
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2 text-xs">
            <button
              type="button"
              aria-label="缩小图片"
              className="ui-btn ui-btn-secondary"
              onClick={() => setZoom((z) => Math.max(0.25, z / 1.25))}
            >
              −
            </button>
            <button
              type="button"
              aria-label="重置图片视图"
              title="重置缩放和位置"
              className="ui-btn ui-btn-secondary"
              onClick={() => {
                stopDrag()
                setZoom(1)
                setPan({ x: 0, y: 0 })
              }}
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              type="button"
              aria-label="放大图片"
              className="ui-btn ui-btn-secondary"
              onClick={() => setZoom((z) => Math.min(8, z * 1.25))}
            >
              +
            </button>
            {candidates.some((r) => r.value.type === 'image' && r.id !== selected) && (
              <>
                <select
                  aria-label="对比候选"
                  className="ui-input"
                  value={compare}
                  onChange={(e) => {
                    setCompare(e.target.value)
                    setComparisonMissing(false)
                  }}
                >
                  <option value="">不对比</option>
                  {candidates
                    .filter((r) => r.value.type === 'image' && r.id !== selected)
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {label(r)}
                      </option>
                    ))}
                </select>
                {otherId && (
                  <select
                    aria-label="对比方式"
                    className="ui-input"
                    value={comparison}
                    onChange={(e) => setComparison(e.target.value as 'side' | 'slider')}
                  >
                    <option value="side">并排</option>
                    <option value="slider">滑杆</option>
                  </select>
                )}
              </>
            )}
            <span className="text-ink-subtle">滚轮缩放，拖动查看；左右键浏览，Enter 采用</span>
            {comparisonMissing && <span role="status">对比候选已移除，已退出对比。</span>}
          </div>
        )}
        <div
          className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black/90 p-4"
          onWheel={(e) => {
            if (kind === 'image')
              setZoom((z) => Math.min(8, Math.max(0.25, z * (e.deltaY < 0 ? 1.1 : 1 / 1.1))))
          }}
        >
          {kind === 'image' && assetId ? (
            <>
              <div
                className={`relative flex h-full w-full items-center justify-center ${otherId && comparison === 'side' ? 'gap-3' : ''}`}
                style={{
                  transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                  touchAction: 'none',
                  cursor: dragging ? 'grabbing' : 'grab',
                }}
                onPointerDown={(e) => {
                  if (e.button !== 0 || drag.current) return
                  e.preventDefault()
                  e.currentTarget.setPointerCapture(e.pointerId)
                  drag.current = {
                    pointerId: e.pointerId,
                    target: e.currentTarget,
                    x: e.clientX,
                    y: e.clientY,
                    px: pan.x,
                    py: pan.y,
                  }
                  setDragging(true)
                }}
                onPointerMove={(e) => {
                  const active = drag.current
                  if (active?.pointerId === e.pointerId)
                    setPan({
                      x: active.px + e.clientX - active.x,
                      y: active.py + e.clientY - active.y,
                    })
                }}
                onPointerUp={(e) => {
                  if (drag.current?.pointerId === e.pointerId) stopDrag()
                }}
                onPointerCancel={(e) => {
                  if (drag.current?.pointerId === e.pointerId) stopDrag()
                }}
                onLostPointerCapture={(e) => {
                  if (drag.current?.pointerId === e.pointerId) stopDrag()
                }}
              >
                <img
                  key={`${imageKey}:${imageLoads[imageKey]?.attempt ?? 0}`}
                  src={assetUrls.original(assetId)}
                  alt={otherId ? '候选 A' : viewer.name}
                  draggable={false}
                  {...imageEvents(imageKey)}
                  style={{ visibility: imageLoads[imageKey]?.failed ? 'hidden' : undefined }}
                  className={`max-h-full min-w-0 object-contain ${otherId && comparison === 'side' ? 'w-1/2' : 'max-w-full'}`}
                />
                {otherId && (
                  <img
                    key={`${otherImageKey}:${imageLoads[otherImageKey]?.attempt ?? 0}`}
                    src={assetUrls.original(otherId)}
                    alt="候选 B"
                    draggable={false}
                    {...imageEvents(otherImageKey)}
                    className={
                      comparison === 'side'
                        ? 'max-h-full w-1/2 min-w-0 object-contain'
                        : 'absolute inset-0 h-full w-full object-contain'
                    }
                    style={{
                      visibility: imageLoads[otherImageKey]?.failed ? 'hidden' : undefined,
                      clipPath:
                        comparison === 'slider' ? `inset(0 ${100 - split}% 0 0)` : undefined,
                    }}
                  />
                )}
              </div>
              <div className="absolute top-4 right-4 z-10 flex flex-col gap-2">
                {[...imageLabels].map(
                  ([id, label]) =>
                    imageLoads[id]?.failed && (
                      <div
                        key={id}
                        className="flex items-center gap-3 rounded-lg bg-float p-3 text-sm text-ink shadow-lg"
                      >
                        <p role="alert">{label}加载失败</p>
                        <button
                          type="button"
                          className="ui-btn ui-btn-secondary"
                          aria-label={`重新加载${label}`}
                          onClick={() =>
                            setImageLoads((old) => ({
                              ...old,
                              [id]: { attempt: (old[id]?.attempt ?? 0) + 1, failed: false },
                            }))
                          }
                        >
                          <Icon name="retry" />
                          重试
                        </button>
                      </div>
                    ),
                )}
              </div>
              {otherId && comparison === 'slider' && (
                <input
                  aria-label="图片对比滑杆"
                  type="range"
                  min="0"
                  max="100"
                  value={split}
                  onChange={(e) => setSplit(Number(e.target.value))}
                  className="absolute right-8 bottom-5 left-8"
                />
              )}
            </>
          ) : (kind === 'video' || kind === 'audio') && assetId ? (
            <ReviewMedia key={assetId} assetId={assetId} kind={kind} />
          ) : value ? (
            <pre className="ui-scrollbar max-h-full w-full overflow-auto whitespace-pre-wrap p-6 text-sm text-white">
              {value.type === 'text'
                ? value.text
                : value.type === 'json'
                  ? JSON.stringify(value.value, null, 2)
                  : '素材不可用'}
            </pre>
          ) : (
            <p className="text-white">候选已移除或素材不可用</p>
          )}
        </div>
      </div>
    </Modal>
  )
}

function ReviewMedia({ assetId, kind }: { assetId: string; kind: 'video' | 'audio' }) {
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const ref = useRef<HTMLMediaElement | null>(null)
  const current = useRef(attempt)
  current.current = attempt
  const closing = useClosing()
  useEffect(() => {
    const media = ref.current
    // StrictMode 会保留 DOM 并重放 effect，清理后需要恢复来源。
    if (closing) media?.pause()
    else if (media && !media.getAttribute('src')) media.src = assetUrls.original(assetId)
    return () => {
      media?.pause()
      media?.removeAttribute('src')
      media?.load()
    }
  }, [assetId, attempt, failed, closing])
  if (failed)
    return (
      <div className="flex flex-col items-center gap-3 text-white">
        <p role="alert">{kind === 'video' ? '视频加载失败' : '音频加载失败'}</p>
        <button
          type="button"
          className="ui-btn ui-btn-secondary"
          aria-label="重新加载媒体"
          onClick={() => {
            setAttempt((value) => value + 1)
            setFailed(false)
          }}
        >
          <Icon name="retry" />
          重新加载
        </button>
      </div>
    )
  const props = {
    ref: (media: HTMLMediaElement | null) => {
      ref.current = media
    },
    src: assetUrls.original(assetId),
    controls: true,
    autoPlay: !closing,
    className: 'max-h-full max-w-full',
    onError: () => {
      if (current.current === attempt) setFailed(true)
    },
  }
  // oxlint-disable jsx-a11y/media-has-caption -- 生成素材不一定带字幕轨
  return kind === 'video' ? (
    <video key={attempt} {...props} poster={assetUrls.variant(assetId, 'poster')} />
  ) : (
    <audio key={attempt} {...props} />
  )
  // oxlint-enable jsx-a11y/media-has-caption
}
