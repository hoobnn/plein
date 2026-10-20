import type { EditMask } from '@plein/nodes'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api, assetUrls } from '../../api/client'
import { drawMask, exportMask, type MaskOp, type MaskTool, normRect } from '../../canvas/mask'
import { loadAssetMeta } from '../../stores/assetMeta'
import { useCanvas } from '../../stores/canvas'
import { Icon } from '../../ui/icons'
import { Modal, ModalHeader } from '../../ui/Modal'
import { Segmented } from '../../ui/Segmented'
import { useClosing } from '../../ui/Presence'

const TOOLS = [
  { value: 'rect', label: '框选', icon: 'rectSelect' },
  { value: 'brush', label: '画笔', icon: 'brush' },
  { value: 'erase', label: '橡皮', icon: 'eraser' },
] as const

/** 画布像素边距：图片在舞台里留白 */
const PAD = 24

function loadImage(src: string, signal: AbortSignal) {
  return new Promise<HTMLImageElement>((done, fail) => {
    const img = new Image()
    const cleanup = () => {
      img.onload = null
      img.onerror = null
      signal.removeEventListener('abort', abort)
    }
    const abort = () => {
      cleanup()
      img.removeAttribute('src')
      fail(new DOMException('读取已取消', 'AbortError'))
    }
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      cleanup()
      done(img)
    }
    img.onerror = () => {
      cleanup()
      fail(new Error('已有重绘区域加载失败，请重新加载后继续'))
    }
    if (signal.aborted) return abort()
    signal.addEventListener('abort', abort, { once: true })
    img.src = src
  })
}

/**
 * 画重绘区域：在原图上框选或涂抹，白色高亮的地方交给模型重画。
 * 蒙版按原图像素记录、按原图尺寸导出，存成 PNG 资产；关掉不保存时什么都不变。
 */
export function MaskEditor({
  assetId,
  name,
  initial,
  onClose,
  onSave,
}: {
  assetId: string
  name: string
  /** 已有的蒙版：在它基础上改 */
  initial?: EditMask | null
  onClose(): void
  onSave(mask: EditMask): void
}) {
  const notify = useCanvas((s) => s.notify)
  const closing = useClosing()
  const alive = useRef(false)
  const saveRequest = useRef<AbortController | null>(null)
  const cancelSave = () => saveRequest.current?.abort()
  const close = () => {
    cancelSave()
    cancelDrag()
    onClose()
  }
  useLayoutEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      saveRequest.current?.abort()
    }
  }, [])
  useLayoutEffect(() => {
    if (closing) saveRequest.current?.abort()
    return () => {
      saveRequest.current?.abort()
    }
  }, [closing, assetId])
  const [stage, setStage] = useState<HTMLDivElement | null>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })
  const [tool, setTool] = useState<MaskTool>('brush')
  const [brush, setBrush] = useState(48)
  const [history, setHistory] = useState<{ steps: MaskOp[][]; index: number }>({
    steps: [[]],
    index: 0,
  })
  const ops = history.steps[history.index]!
  const edit = useCallback(
    (update: (ops: MaskOp[]) => MaskOp[]) => {
      setHistory((current) => ({
        steps: [
          ...current.steps.slice(0, current.index + 1),
          update(current.steps[current.index]!),
        ],
        index: current.index + 1,
      }))
    },
    [setHistory],
  )
  const [draft, setDraft] = useState<MaskOp | null>(null)
  const [saving, setSaving] = useState(false)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [prepared, setPrepared] = useState(false)
  const [sourceReady, setSourceReady] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const ready = prepared && sourceReady && !loadError
  const frozen = saving || !ready || closing
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null)
  const drag = useRef<{
    start: [number, number]
    pointerId: number
    target: Element
  } | null>(null)
  const cancelDrag = useCallback(() => {
    const active = drag.current
    drag.current = null
    setDraft(null)
    setCursor(null)
    if (active?.target.hasPointerCapture(active.pointerId))
      active.target.releasePointerCapture(active.pointerId)
  }, [setDraft, setCursor])
  useEffect(() => {
    window.addEventListener('blur', cancelDrag)
    return () => {
      window.removeEventListener('blur', cancelDrag)
      cancelDrag()
    }
  }, [cancelDrag, assetId])
  useLayoutEffect(() => {
    if (closing) cancelDrag()
  }, [closing, cancelDrag])

  // 原图和已有区域都加载成功后才开放绘制，避免在破图上提交区域。
  useEffect(() => {
    if (closing) return
    let active = true
    const request = new AbortController()
    cancelDrag()
    setSize(null)
    setPrepared(false)
    setSourceReady(false)
    setLoadError(null)
    setHistory({ steps: [[]], index: 0 })
    void (async () => {
      const meta = await loadAssetMeta(assetId).catch((error: unknown) => {
        throw new Error(
          `原图信息读取失败：${error instanceof Error ? error.message : '请稍后重试'}`,
        )
      })
      if (!active) return
      if (!meta.width || !meta.height) throw new Error('原图信息读取失败：缺少有效图片尺寸')
      setSize({ width: meta.width, height: meta.height })
      const base =
        initial && initial.width === meta.width && initial.height === meta.height
          ? await loadImage(assetUrls.original(initial.assetId), request.signal)
          : null
      if (!active) return
      if (base) setHistory({ steps: [[], [{ type: 'image', image: base }]], index: 1 })
      setPrepared(true)
    })().catch((error: unknown) => {
      if (active) setLoadError(error instanceof Error ? error.message : '重绘素材加载失败')
    })
    return () => {
      active = false
      request.abort()
    }
  }, [assetId, initial, loadAttempt, closing, cancelDrag])

  // 舞台大小变了，图片按比例缩进去（弹层挂载晚于本组件，用回调 ref 拿节点）
  useLayoutEffect(() => {
    const el = stage
    if (!el) return
    const ro = new ResizeObserver(([e]) => {
      const r = e!.contentRect
      setBox({ w: r.width, h: r.height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [stage])
  const scale = size
    ? // 小图也放大到铺满舞台，涂抹起来不用对着几个像素
      Math.min((box.w - PAD * 2) / size.width, (box.h - PAD * 2) / size.height)
    : 0
  const view = size && scale > 0 ? { w: size.width * scale, h: size.height * scale } : null

  const viewW = view?.w
  const viewH = view?.h
  // 叠加层：每次操作变化时整体回放
  useEffect(() => {
    const canvas = overlayRef.current
    if (!canvas || !viewW || !viewH) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(viewW * dpr)
    canvas.height = Math.round(viewH * dpr)
    const color = getComputedStyle(canvas).getPropertyValue('--accent').trim() || '#4d8dff'
    drawMask(canvas.getContext('2d')!, draft ? [...ops, draft] : ops, {
      scale: scale * dpr,
      mode: 'overlay',
      color,
    })
  }, [ops, draft, viewW, viewH, scale, ready])

  const toImage = (e: React.PointerEvent): [number, number] => {
    const r = overlayRef.current!.getBoundingClientRect()
    return [(e.clientX - r.left) / scale, (e.clientY - r.top) / scale]
  }
  const down = (e: React.PointerEvent) => {
    if (!ready || !size || e.button !== 0 || drag.current || saveRequest.current || closing) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const p = toImage(e)
    drag.current = { start: p, pointerId: e.pointerId, target: e.currentTarget }
    setDraft(
      tool === 'rect'
        ? { type: 'rect', ...normRect(p, p, size) }
        : { type: tool, size: brush / scale, points: [p] },
    )
  }
  const move = (e: React.PointerEvent) => {
    if (
      !ready ||
      saveRequest.current ||
      closing ||
      (drag.current && drag.current.pointerId !== e.pointerId)
    )
      return
    const r = overlayRef.current?.getBoundingClientRect()
    if (r) setCursor({ x: e.clientX - r.left, y: e.clientY - r.top })
    if (!drag.current || !draft || !size) return
    const p = toImage(e)
    if (draft.type === 'rect') setDraft({ type: 'rect', ...normRect(drag.current.start, p, size) })
    else if (draft.type !== 'image') setDraft({ ...draft, points: [...draft.points, p] })
  }
  const up = (e: React.PointerEvent) => {
    const active = drag.current
    if (!ready || !active || active.pointerId !== e.pointerId || saveRequest.current || closing)
      return
    drag.current = null
    if (active.target.hasPointerCapture(active.pointerId))
      active.target.releasePointerCapture(active.pointerId)
    if (draft && !(draft.type === 'rect' && (draft.w < 2 || draft.h < 2)))
      edit((list) => [...list, draft])
    setDraft(null)
  }

  const save = async () => {
    if (!ready || !size || closing || !alive.current || saveRequest.current) return
    const request = new AbortController()
    saveRequest.current = request
    cancelDrag()
    setSaving(true)
    try {
      const blob = await exportMask(ops, size)
      if (request.signal.aborted || !alive.current) return
      if (!blob) {
        notify('还没圈出要重画的区域')
        return
      }
      const asset = await api.upload(
        new File([blob], `${name}-蒙版.png`, { type: 'image/png' }),
        request.signal,
      )
      if (request.signal.aborted || !alive.current) return
      onSave({
        assetId: asset.id,
        width: size.width,
        height: size.height,
        sourceAssetId: assetId,
      })
    } catch (err) {
      if (!request.signal.aborted && alive.current) notify((err as Error).message)
    } finally {
      if (saveRequest.current === request) {
        saveRequest.current = null
        if (alive.current) setSaving(false)
      }
    }
  }

  const travel = useCallback(
    (direction: -1 | 1) => {
      if (!ready || saveRequest.current || closing) return
      // 未完成的笔画先取消，不消耗已完成区域的历史。
      if (drag.current) {
        cancelDrag()
        return
      }
      setHistory((current) => ({
        ...current,
        index: Math.max(0, Math.min(current.steps.length - 1, current.index + direction)),
      }))
    },
    [cancelDrag, closing, setHistory, ready],
  )
  // 保存时冻结历史，但仍阻止快捷键穿透到画布。
  useEffect(() => {
    if (closing) return
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229 || e.altKey || !(e.metaKey || e.ctrlKey)) return
      const key = e.key.toLowerCase()
      if (key !== 'z' && key !== 'y') return
      e.preventDefault()
      e.stopPropagation()
      travel(key === 'y' || e.shiftKey ? 1 : -1)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [closing, travel])

  return (
    <Modal label="画重绘区域" onClose={close} isolateKeys top className="h-full max-w-6xl">
      <ModalHeader
        title="画重绘区域"
        meta={<span className="text-sm text-ink-subtle">高亮的地方按提示词重画，其余保持原图</span>}
        onClose={close}
      >
        <Segmented label="工具" options={TOOLS} value={tool} onChange={setTool} disabled={frozen} />
        {tool !== 'rect' && (
          <label className="flex items-center gap-2 text-xs text-ink-subtle">
            笔刷
            <input
              type="range"
              aria-label="笔刷大小"
              disabled={frozen}
              min={8}
              max={160}
              value={brush}
              onChange={(e) => setBrush(Number(e.target.value))}
              className="w-24"
            />
          </label>
        )}
        <button
          type="button"
          className="ui-btn ui-btn-quiet ui-icon-btn"
          aria-label="撤销"
          title="撤销（⌘Z）"
          disabled={(!history.index && !draft) || frozen}
          onClick={() => travel(-1)}
        >
          <Icon name="undo" />
        </button>
        <button
          type="button"
          className="ui-btn ui-btn-quiet ui-icon-btn"
          aria-label="重做"
          title="重做（⇧⌘Z / Ctrl+Y）"
          disabled={history.index === history.steps.length - 1 || !!draft || frozen}
          onClick={() => travel(1)}
        >
          <Icon name="redo" />
        </button>
        <button
          type="button"
          className="ui-btn ui-btn-quiet"
          disabled={!ops.length || frozen}
          onClick={() => {
            cancelDrag()
            edit(() => [])
          }}
        >
          清空
        </button>
        <button
          type="button"
          className="ui-btn ui-btn-primary"
          disabled={!ops.length || frozen}
          onClick={() => void save()}
        >
          {saving ? '保存中…' : '完成'}
        </button>
      </ModalHeader>
      <div
        ref={setStage}
        aria-busy={!ready && !loadError}
        className="relative flex min-h-0 flex-1 items-center justify-center bg-surface-2"
      >
        {view && !loadError && (
          <div
            className="relative overflow-hidden rounded-md shadow-2"
            style={{ width: view.w, height: view.h }}
          >
            <img
              src={assetUrls.original(assetId)}
              alt={name}
              draggable={false}
              className={`pointer-events-none absolute inset-0 size-full select-none ${ready ? '' : 'invisible'}`}
              onLoad={() => {
                if (!closing) setSourceReady(true)
              }}
              onError={() => {
                if (!closing) setLoadError('原图加载失败，请重新加载后再绘制')
              }}
            />
            {ready && (
              <canvas
                ref={overlayRef}
                data-testid="mask-canvas"
                aria-label="重绘区域"
                className="absolute inset-0 size-full touch-none opacity-55"
                style={{ cursor: tool === 'rect' ? 'crosshair' : 'none' }}
                onPointerDown={down}
                onPointerMove={move}
                onPointerUp={up}
                onPointerCancel={(e) => {
                  if (drag.current?.pointerId === e.pointerId) cancelDrag()
                }}
                onLostPointerCapture={(e) => {
                  if (drag.current?.pointerId === e.pointerId) cancelDrag()
                }}
                onPointerLeave={() => setCursor(null)}
              />
            )}
            {ready && tool !== 'rect' && cursor && (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute rounded-full border border-white shadow-[0_0_0_1px_rgba(0,0,0,0.5)]"
                style={{
                  width: brush,
                  height: brush,
                  left: cursor.x - brush / 2,
                  top: cursor.y - brush / 2,
                }}
              />
            )}
          </div>
        )}
        {loadError ? (
          <div
            role="alert"
            className="mx-6 max-w-md rounded-xl border border-line bg-surface p-6 text-center"
          >
            <h3 className="font-semibold">重绘素材加载失败</h3>
            <p className="mt-2 text-sm text-ink-muted">{loadError}</p>
            <button
              type="button"
              className="ui-btn ui-btn-secondary mt-4"
              disabled={closing}
              onClick={() => setLoadAttempt((attempt) => attempt + 1)}
            >
              重新加载
            </button>
          </div>
        ) : !ready ? (
          <div role="status" className="absolute text-sm text-ink-muted">
            正在加载重绘素材…
          </div>
        ) : null}
        {ready && !ops.length && view && (
          <div className="ui-float pointer-events-none absolute bottom-5 rounded-lg px-3 py-2 text-sm text-ink-muted">
            {tool === 'rect' ? '拖一个框圈出要改的区域' : '在要改的地方涂抹'}
          </div>
        )}
      </div>
    </Modal>
  )
}
