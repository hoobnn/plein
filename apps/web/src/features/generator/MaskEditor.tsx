import type { EditMask } from '@plein/nodes'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
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

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((done, fail) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => done(img)
    img.onerror = () => fail(new Error('图片读不出来'))
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
  const [ops, setOps] = useState<MaskOp[]>([])
  const [draft, setDraft] = useState<MaskOp | null>(null)
  const [saving, setSaving] = useState(false)
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null)
  const drag = useRef<{ start: [number, number] } | null>(null)

  // 原图尺寸以资产信息为准（不是屏幕上显示的大小），蒙版要和它逐像素对齐
  useEffect(() => {
    let alive = true
    loadAssetMeta(assetId)
      .then(async (meta) => {
        if (!meta.width || !meta.height) throw new Error('读不到图片尺寸')
        const base =
          initial && initial.width === meta.width && initial.height === meta.height
            ? await loadImage(assetUrls.original(initial.assetId))
            : null
        if (!alive) return
        setSize({ width: meta.width, height: meta.height })
        if (base) setOps([{ type: 'image', image: base }])
      })
      .catch((err: Error) => alive && notify(err.message))
    return () => {
      alive = false
    }
  }, [assetId, initial, notify])

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
  }, [ops, draft, viewW, viewH, scale])

  const toImage = (e: React.PointerEvent): [number, number] => {
    const r = overlayRef.current!.getBoundingClientRect()
    return [(e.clientX - r.left) / scale, (e.clientY - r.top) / scale]
  }
  const down = (e: React.PointerEvent) => {
    if (!size || e.button !== 0 || saveRequest.current || closing) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const p = toImage(e)
    drag.current = { start: p }
    setDraft(
      tool === 'rect'
        ? { type: 'rect', ...normRect(p, p, size) }
        : { type: tool, size: brush / scale, points: [p] },
    )
  }
  const move = (e: React.PointerEvent) => {
    if (saveRequest.current || closing) return
    const r = overlayRef.current?.getBoundingClientRect()
    if (r) setCursor({ x: e.clientX - r.left, y: e.clientY - r.top })
    if (!drag.current || !draft || !size) return
    const p = toImage(e)
    if (draft.type === 'rect') setDraft({ type: 'rect', ...normRect(drag.current.start, p, size) })
    else if (draft.type !== 'image') setDraft({ ...draft, points: [...draft.points, p] })
  }
  const up = () => {
    if (!drag.current || saveRequest.current || closing) return
    drag.current = null
    if (draft && !(draft.type === 'rect' && (draft.w < 2 || draft.h < 2)))
      setOps((list) => [...list, draft])
    setDraft(null)
  }

  const save = async () => {
    if (!size || closing || !alive.current || saveRequest.current) return
    const request = new AbortController()
    saveRequest.current = request
    drag.current = null
    setDraft(null)
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

  // ⌘Z 撤销最后一笔；保存时冻结区域，但仍阻止按键穿透到画布。
  useEffect(() => {
    if (closing) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        e.stopPropagation()
        if (!saveRequest.current) setOps((list) => list.slice(0, -1))
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [closing])

  return (
    <Modal label="画重绘区域" onClose={close} isolateKeys top className="h-full max-w-6xl">
      <ModalHeader
        title="画重绘区域"
        meta={<span className="text-sm text-ink-subtle">高亮的地方按提示词重画，其余保持原图</span>}
        onClose={close}
      >
        <Segmented label="工具" options={TOOLS} value={tool} onChange={setTool} disabled={saving} />
        {tool !== 'rect' && (
          <label className="flex items-center gap-2 text-xs text-ink-subtle">
            笔刷
            <input
              type="range"
              aria-label="笔刷大小"
              disabled={saving}
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
          disabled={!ops.length || saving}
          onClick={() => setOps((list) => list.slice(0, -1))}
        >
          <Icon name="undo" />
        </button>
        <button
          type="button"
          className="ui-btn ui-btn-quiet"
          disabled={!ops.length || saving}
          onClick={() => setOps([])}
        >
          清空
        </button>
        <button
          type="button"
          className="ui-btn ui-btn-primary"
          disabled={!ops.length || saving}
          onClick={() => void save()}
        >
          {saving ? '保存中…' : '完成'}
        </button>
      </ModalHeader>
      <div
        ref={setStage}
        className="relative flex min-h-0 flex-1 items-center justify-center bg-surface-2"
      >
        {view && (
          <div
            className="relative overflow-hidden rounded-md shadow-2"
            style={{ width: view.w, height: view.h }}
          >
            <img
              src={assetUrls.original(assetId)}
              alt={name}
              draggable={false}
              className="pointer-events-none absolute inset-0 size-full select-none"
            />
            <canvas
              ref={overlayRef}
              data-testid="mask-canvas"
              aria-label="重绘区域"
              className="absolute inset-0 size-full touch-none opacity-55"
              style={{ cursor: tool === 'rect' ? 'crosshair' : 'none' }}
              onPointerDown={down}
              onPointerMove={move}
              onPointerUp={up}
              onPointerCancel={up}
              onPointerLeave={() => setCursor(null)}
            />
            {tool !== 'rect' && cursor && (
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
        {!ops.length && view && (
          <div className="ui-float pointer-events-none absolute bottom-5 rounded-lg px-3 py-2 text-sm text-ink-muted">
            {tool === 'rect' ? '拖一个框圈出要改的区域' : '在要改的地方涂抹'}
          </div>
        )}
      </div>
    </Modal>
  )
}
