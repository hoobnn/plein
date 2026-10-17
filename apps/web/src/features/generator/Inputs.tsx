import type { Engine } from '@plein/canvas-core'
import {
  type CanvasElement,
  connect,
  elementPorts,
  inputEdges,
  removeEdges,
  reorderInputs,
  replaceInput,
  type ResultValue,
} from '@plein/doc'
import { useRef, useState } from 'react'
import { assetUrls } from '../../api/client'
import { importFiles } from '../../canvas/import'
import { beginImport } from '../../canvas/importProgress'
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
  const [target, setTarget] = useState<{ port: InputPort; edgeId?: string } | null>(null)
  const [replacing, setReplacing] = useState<{ port: InputPort; edgeId: string } | null>(null)
  const [dragged, setDragged] = useState<string | null>(null)
  const media = node.inputs.filter((p) => p.type !== 'text')
  const texts = node.inputs.filter((p) => p.type === 'text').flatMap((p) => ups.get(p.id) ?? [])
  const locate = (u: Upstream) => {
    engine.selection.set([u.source.id])
    engine.zoomToFit([u.source.id])
  }
  const disconnect = (u: Upstream) => removeEdges(engine.doc, [u.edgeId])

  /** 上传文件到节点左侧，连到指定输入端口，然后选回节点 */
  const upload = async (files: File[]) => {
    const port = target?.port
    const rect = engine.scene.rect(el.id)
    if (!port || !rect || !files.length) return
    const expected = target?.edgeId ? engine.doc.getEdge(target.edgeId) : undefined
    const selectedFiles = port.multiple && !target?.edgeId ? files : files.slice(0, 1)
    const batch = beginImport(engine, selectedFiles.length)
    const notes: string[] = []
    try {
      const res = await importFiles(
        engine,
        selectedFiles,
        { x: rect.x - UPLOAD_OFFSET, y: rect.y + rect.h / 2 },
        batch.progress,
        { signal: batch.signal, select: false },
      )
      if (useCanvas.getState().engine !== engine || !engine.doc.has(el.id)) return
      if (!port.multiple && !target?.edgeId && inputEdges(engine.doc, el.id, port.id).length) {
        notes.push('这个输入已接入其他参考，上传的素材保留在画布上，没有覆盖新参考')
        return
      }
      if (target?.edgeId) {
        const current = engine.doc.getEdge(target.edgeId)
        if (
          !expected ||
          !current ||
          current.from[0] !== expected.from[0] ||
          current.from[1] !== expected.from[1]
        ) {
          notes.push('参考槽位已变化，上传的素材保留在画布上，没有覆盖新参考')
          return
        }
      }
      for (const id of res.created) {
        const src = engine.doc.get(id)
        const out = src && (src.kind === 'image' || src.kind === 'video' || src.kind === 'audio')
        if (out) {
          engine.doc.undo.stopCapturing()
          if (target?.edgeId) replaceInput(engine.doc, target.edgeId, [id, src.kind])
          else connect(engine.doc, [id, src.kind], [el.id, port.id])
          engine.doc.undo.stopCapturing()
        }
      }
      if (res.skipped.length) notes.push(`${res.skipped.map((s) => s.name).join('，')} 未导入`)
    } catch (error) {
      if (!batch.signal.aborted) notes.push(error instanceof Error ? error.message : '素材导入失败')
    } finally {
      batch.finish(notes)
    }
  }
  const pick = (port: InputPort, edgeId?: string) => {
    setTarget({ port, edgeId })
    requestAnimationFrame(() => fileRef.current?.click())
  }
  const move = (port: InputPort, id: string, before: string) => {
    const ids = inputEdges(engine.doc, el.id, port.id).map((e) => e.id)
    if (!ids.includes(id) || !ids.includes(before) || id === before) return
    ids.splice(ids.indexOf(id), 1)
    ids.splice(ids.indexOf(before), 0, id)
    engine.doc.undo.stopCapturing()
    reorderInputs(engine.doc, [el.id, port.id], ids)
    engine.doc.undo.stopCapturing()
  }
  const previewUpstream = (up: Upstream) => {
    const v = up.value
    if (v && (v.type === 'image' || v.type === 'video' || v.type === 'audio'))
      useCanvas
        .getState()
        .view({ assetId: v.assetId, kind: v.type, name: up.source.name ?? '参考素材' })
    else locate(up)
  }

  // 生成视频的图片按模式标注用途：图生视频第 1 张是首帧，首尾帧第 1、2 张分别是首帧、尾帧
  const mode = node.capability === 'video.generate' ? el.params?.mode : undefined
  const roleOf = (port: InputPort, i: number) => {
    if (port.id === 'videos' || port.id === 'audios')
      return mode === 'reference' ? port.label : '当前模式不使用'
    if (port.id !== 'images') return undefined
    if (mode === 'image') return i === 0 ? '首帧' : '未使用'
    if (mode === 'frames') return ['首帧', '尾帧'][i] ?? '未使用'
    if (mode === 'text') return '未使用'
    return undefined
  }

  let n = 0
  const tiles: React.ReactNode[] = []
  const adds: React.ReactNode[] = []
  for (const port of media) {
    const list = ups.get(port.id) ?? []
    // 多连的“参考图”不逐个标端口名；首帧、尾帧这种单连输入在缩略图下标出
    const caption = port.multiple ? undefined : port.label
    for (const [i, u] of list.entries()) {
      n++
      tiles.push(
        <RefTile
          key={u.edgeId}
          index={n}
          up={u}
          caption={roleOf(port, i) ?? caption}
          onLocate={() => locate(u)}
          onPreview={() => previewUpstream(u)}
          onRemove={() => disconnect(u)}
          onReplace={() => setReplacing({ port, edgeId: u.edgeId })}
          onUpload={() => pick(port, u.edgeId)}
          draggable={!!port.multiple}
          onDragStart={() => setDragged(u.edgeId)}
          onDragEnd={() => setDragged(null)}
          onDrop={() => {
            if (dragged) move(port, dragged, u.edgeId)
            setDragged(null)
          }}
          onMove={(delta) => {
            const ids = list.map((item) => item.edgeId)
            const j = i + delta
            if (j < 0 || j >= ids.length) return
            const ordered = [...ids]
            ;[ordered[i], ordered[j]] = [ordered[j]!, ordered[i]!]
            engine.doc.undo.stopCapturing()
            reorderInputs(engine.doc, [el.id, port.id], ordered)
            engine.doc.undo.stopCapturing()
          }}
          canPrevious={i > 0}
          canNext={i < list.length - 1}
        />,
      )
    }
    if (port.multiple || list.length === 0)
      adds.push(
        <button
          key={`add-${port.id}`}
          type="button"
          onClick={() => pick(port)}
          title={`上传${port.label}，也可以从画布上的对应素材拖线连入`}
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
      {replacing && (
        <div className="flex items-center gap-2 rounded-lg bg-surface-2 p-2">
          <select
            aria-label="替换参考素材"
            className="ui-input min-w-0 flex-1"
            value=""
            onChange={(e) => {
              const [id, portId] = JSON.parse(e.target.value) as [string, string]
              engine.doc.undo.stopCapturing()
              const ok = replaceInput(engine.doc, replacing.edgeId, [id, portId])
              engine.doc.undo.stopCapturing()
              if (!ok) useCanvas.getState().notify('无法替换：素材重复或类型不匹配')
              setReplacing(null)
            }}
          >
            <option value="" disabled>
              从当前画布选择素材…
            </option>
            {[...engine.doc.elements()].flatMap((source) =>
              source.id === el.id
                ? []
                : (elementPorts(source)?.outputs ?? [])
                    .filter((p) => p.type === replacing.port.type || p.type === 'any')
                    .map((p) => (
                      <option
                        key={`${source.id}/${p.id}`}
                        value={JSON.stringify([source.id, p.id])}
                      >
                        {source.name ?? source.id} · {p.label}
                      </option>
                    )),
            )}
          </select>
          <button type="button" className="ui-btn ui-btn-quiet" onClick={() => setReplacing(null)}>
            取消
          </button>
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
        multiple={target?.port.multiple && !target.edgeId}
        accept={target ? `${target.port.type}/*` : undefined}
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
  onPreview,
  onReplace,
  onUpload,
  draggable,
  onDragStart,
  onDragEnd,
  onDrop,
  onMove,
  canPrevious,
  canNext,
}: {
  index: number
  up: Upstream
  caption?: string
  onLocate(): void
  onRemove(): void
  onPreview(): void
  onReplace(): void
  onUpload(): void
  draggable: boolean
  onDragStart(): void
  onDragEnd(): void
  onDrop(): void
  onMove(delta: number): void
  canPrevious: boolean
  canNext: boolean
}) {
  const v = up.value
  const img = preview(v)
  const name = up.source.name ?? '上游'
  return (
    <div
      role="group"
      aria-label={`参考 ${index}：${name}`}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        onDrop()
      }}
      className="group relative flex flex-none flex-col items-center gap-1 text-2xs text-ink-subtle"
    >
      <button
        type="button"
        onClick={onPreview}
        title={v ? `预览「${name}」` : `「${name}」还没有结果`}
        draggable={draggable}
        onDragStart={(e) => {
          e.dataTransfer.setData('application/x-plein-input', up.edgeId)
          onDragStart()
        }}
        onDragEnd={onDragEnd}
        onKeyDown={(e) => {
          if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
            e.preventDefault()
            onMove(e.key === 'ArrowLeft' ? -1 : 1)
          }
        }}
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
      <div className="flex gap-0.5">
        {draggable && (
          <>
            <button
              type="button"
              className="ui-btn ui-btn-quiet p-0.5"
              disabled={!canPrevious}
              aria-label={`向前移动参考 ${index}`}
              onClick={() => onMove(-1)}
            >
              ←
            </button>
            <button
              type="button"
              className="ui-btn ui-btn-quiet p-0.5"
              disabled={!canNext}
              aria-label={`向后移动参考 ${index}`}
              onClick={() => onMove(1)}
            >
              →
            </button>
          </>
        )}
        <button
          type="button"
          className="ui-btn ui-btn-quiet p-0.5"
          aria-label={`替换参考 ${index}`}
          title="从画布替换"
          onClick={onReplace}
        >
          <Icon name="retry" size={12} />
        </button>
        <button
          type="button"
          className="ui-btn ui-btn-quiet p-0.5"
          aria-label={`上传替换参考 ${index}`}
          title="上传替换"
          onClick={onUpload}
        >
          <Icon name="upload" size={12} />
        </button>
        <button
          type="button"
          className="ui-btn ui-btn-quiet p-0.5"
          aria-label={`定位参考 ${index}`}
          title="定位上游"
          onClick={onLocate}
        >
          <Icon name="locate" size={12} />
        </button>
      </div>
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
        className="ui-chip-remove"
      >
        <Icon name="x" size={12} />
      </button>
    </span>
  )
}
