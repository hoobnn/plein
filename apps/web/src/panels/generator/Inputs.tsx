import type { Engine } from '@plein/canvas-core'
import { type CanvasElement, connect, removeEdges, type ResultValue } from '@plein/doc'
import { useRef, useState } from 'react'
import { assetUrls } from '../../api/client'
import { importFiles } from '../../canvas/import'
import type { NodeInfo, Upstream } from '../../canvas/nodes'
import { useCanvas } from '../../stores/canvas'
import { Icon } from '../../ui/icons'

type InputPort = NodeInfo['inputs'][number]

/** 上传的素材放在节点左侧多远（世界坐标） */
const UPLOAD_OFFSET = 420

/**
 * 连入的素材（生成器顶部那一排）：参考图 / 首尾帧是带编号的缩略图，
 * 还能再连的输入给一个「+ 参考图」按钮，点一下直接上传并连上；上游文本是一行小标签。
 */
export function Inputs({
  engine,
  el,
  node,
  ups,
  trailing,
}: {
  engine: Engine
  el: CanvasElement
  node: NodeInfo
  ups: Map<string, Upstream[]>
  /** 第一行右侧的操作（对结果的操作） */
  trailing?: React.ReactNode
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [target, setTarget] = useState<InputPort | null>(null)
  const media = node.inputs.filter((p) => p.type !== 'text')
  const texts = node.inputs.filter((p) => p.type === 'text').flatMap((p) => ups.get(p.id) ?? [])
  const locate = (u: Upstream) => {
    engine.selection.set([u.source.id])
    engine.zoomToFit([u.source.id])
  }
  const disconnect = (u: Upstream) => removeEdges(engine.doc, [u.edgeId])

  /** 上传文件到节点左侧，连到指定输入端口，然后选回节点 */
  const upload = async (files: File[]) => {
    const port = target
    const rect = engine.scene.rect(el.id)
    if (!port || !rect || !files.length) return
    const { setImporting, notify } = useCanvas.getState()
    setImporting({ done: 0, total: files.length })
    try {
      const res = await importFiles(
        engine,
        port.multiple ? files : files.slice(0, 1),
        { x: rect.x - UPLOAD_OFFSET, y: rect.y + rect.h / 2 },
        (done, total) => setImporting({ done, total }),
      )
      for (const id of res.created) {
        const src = engine.doc.get(id)
        const out = src && (src.kind === 'image' || src.kind === 'video' || src.kind === 'audio')
        if (out) connect(engine.doc, [id, src.kind], [el.id, port.id])
      }
      if (res.skipped.length) notify(`${res.skipped.map((s) => s.name).join('，')} 未导入`)
    } finally {
      setImporting(null)
      engine.selection.set([el.id])
    }
  }
  const pick = (port: InputPort) => {
    setTarget(port)
    requestAnimationFrame(() => fileRef.current?.click())
  }

  let n = 0
  const tiles: React.ReactNode[] = []
  const adds: React.ReactNode[] = []
  for (const port of media) {
    const list = ups.get(port.id) ?? []
    // 多连的“参考图”不逐个标端口名；首帧、尾帧这种单连输入在缩略图下标出
    const caption = port.multiple ? undefined : port.label
    for (const u of list) {
      n++
      tiles.push(
        <RefTile
          key={u.edgeId}
          index={n}
          up={u}
          caption={caption}
          onLocate={() => locate(u)}
          onRemove={() => disconnect(u)}
        />,
      )
    }
    if (port.multiple || list.length === 0)
      adds.push(
        <button
          key={`add-${port.id}`}
          type="button"
          onClick={() => pick(port)}
          title={`上传${port.label}，也可以从画布上的图片拖线连入`}
          className={`ui-btn ui-btn-sm ui-btn-secondary ${port.required && list.length === 0 ? 'text-danger' : ''}`}
        >
          <Icon name="plus" size={14} />
          {port.label}
        </button>,
      )
  }

  if (!tiles.length && !adds.length && !texts.length && !trailing) return null
  return (
    <div className="flex flex-col gap-3 px-4 pt-4">
      {(adds.length > 0 || trailing) && (
        <div className="flex flex-wrap items-center gap-2">
          {adds}
          {trailing && (
            <div role="toolbar" aria-label="结果操作" className="ml-auto flex items-center gap-0.5">
              {trailing}
            </div>
          )}
        </div>
      )}
      {tiles.length > 0 && (
        <div className="ui-scrollbar flex items-start gap-2 overflow-x-auto pt-1.5 pb-0.5">
          {tiles}
        </div>
      )}
      {texts.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-ink-subtle">
          上游文本
          {texts.map((u) => (
            <TextChip
              key={u.edgeId}
              up={u}
              onLocate={() => locate(u)}
              onRemove={() => disconnect(u)}
            />
          ))}
        </div>
      )}
      <input
        ref={fileRef}
        type="file"
        hidden
        multiple={target?.multiple}
        accept={target ? `${target.type}/*` : undefined}
        onChange={(e) => {
          const files = [...(e.target.files ?? [])]
          e.target.value = ''
          void upload(files)
        }}
      />
    </div>
  )
}

function preview(v: ResultValue | undefined) {
  if (!v) return null
  if (v.type === 'image') return assetUrls.variant(v.assetId, 'thumb-256')
  if (v.type === 'video') return assetUrls.variant(v.assetId, 'poster')
  return null
}

/** 一张连入的素材：编号角标，悬停出现断开按钮，点击定位到上游 */
function RefTile({
  index,
  up,
  caption,
  onLocate,
  onRemove,
}: {
  index: number
  up: Upstream
  caption?: string
  onLocate(): void
  onRemove(): void
}) {
  const v = up.value
  const img = preview(v)
  const name = up.source.name ?? '上游'
  return (
    <div className="group relative flex flex-none flex-col items-center gap-1 text-2xs text-ink-subtle">
      <button
        type="button"
        onClick={onLocate}
        title={v ? `定位到「${name}」` : `「${name}」还没有结果`}
        className="relative size-12 overflow-hidden rounded-md bg-surface-2 shadow-1"
      >
        {img ? (
          <img src={img} alt="" className="size-full object-cover" />
        ) : (
          <span className="flex size-full items-center justify-center text-ink-subtle">
            <Icon name={v?.type === 'video' ? 'video' : 'image'} />
          </span>
        )}
        <span className="absolute top-1 left-1 flex size-4 items-center justify-center rounded-full bg-black/60 text-2xs font-medium text-white tabular-nums">
          {index}
        </span>
        {!v && <span className="absolute inset-0 bg-canvas/50" />}
      </button>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`断开「${name}」`}
        title="断开"
        className="absolute -top-1.5 -right-1.5 hidden size-5 items-center justify-center rounded-full bg-surface-3 text-ink shadow-2 group-hover:flex"
      >
        <Icon name="x" size={12} />
      </button>
      {caption && <span>{caption}</span>}
    </div>
  )
}

/** 一段上游文本：前 20 个字，点击定位，右侧断开 */
function TextChip({
  up,
  onLocate,
  onRemove,
}: {
  up: Upstream
  onLocate(): void
  onRemove(): void
}) {
  const v = up.value
  const name = up.source.name ?? '上游'
  const text = v?.type === 'text' ? v.text.trim().slice(0, 20) || '（空）' : `${name}（未生成）`
  return (
    <span className="ui-chip group max-w-56 pr-0.5">
      <button
        type="button"
        onClick={onLocate}
        title={`定位到「${name}」`}
        className={`truncate text-left ${v ? 'text-ink' : 'text-ink-subtle'}`}
      >
        {text}
      </button>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`断开「${name}」`}
        title="断开"
        className="flex size-5 flex-none items-center justify-center rounded-xs text-ink-subtle transition-colors hover:bg-active hover:text-ink"
      >
        <Icon name="x" size={12} />
      </button>
    </span>
  )
}
