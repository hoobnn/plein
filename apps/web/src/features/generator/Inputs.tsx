import type { Engine } from '@plein/canvas-core'
import {
  type CanvasElement,
  connect,
  elementPorts,
  inputEdges,
  removeEdges,
  reorderInputs,
  setParam,
  replaceInput,
  type ResultValue,
} from '@plein/doc'
import type { PreparedInput } from '@plein/protocol'
import { filterReferenceCandidates, referenceCandidates } from './referenceCandidates'
import { submittedMedia, type SubmittedMedia } from './submittedMedia'
import { RoleReferencePicker } from './RoleReferencePicker'
import { useRef, useState } from 'react'
import { assetUrls } from '../../api/client'
import { importFiles } from '../../canvas/import'
import { beginImport } from '../../canvas/importProgress'
import type { NodeInfo, Upstream } from '../../canvas/nodes'
import { useCanvas } from '../../stores/canvas'
import { Icon } from '../../ui/icons'
import { Popover } from '../../ui/Popover'
import { Presence } from '../../ui/Presence'

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
  prepared,
  preparing,
  toolbar,
}: {
  engine: Engine
  el: CanvasElement
  node: NodeInfo
  ups: Map<string, Upstream[]>
  /** 第一行右侧的操作（对结果的操作） */
  trailing?: React.ReactNode
  prepared?: PreparedInput | null
  preparing?: boolean
  toolbar?: React.ReactNode
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [target, setTarget] = useState<{ port: InputPort; edgeId?: string } | null>(null)
  const [replacing, setReplacing] = useState<{ port: InputPort; edgeId: string } | null>(null)
  const [addAnchor, setAddAnchor] = useState<HTMLButtonElement | null>(null)
  const [canvasAnchor, setCanvasAnchor] = useState<HTMLButtonElement | null>(null)
  const [canvasQuery, setCanvasQuery] = useState('')
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

  const submitted = prepared ? submittedMedia(prepared) : null
  const sentTiles = new Map<string, React.ReactNode>()
  const unusedTiles: React.ReactNode[] = []
  const insertToken = (token: string) => {
    const current = engine.doc.get(el.id)
    if (!current) return
    const prompt = String(current.params?.prompt ?? '')
    engine.doc.undo.stopCapturing()
    setParam(
      engine.doc,
      el.id,
      'prompt',
      `${prompt}${prompt && !/\s$/.test(prompt) ? ' ' : ''}@${token} `,
    )
    engine.doc.undo.stopCapturing()
  }
  const mediaKey = (v: SubmittedMedia) => `${v.port}:${v.token}`
  // 生成视频的图片按模式标注用途：图生视频第 1 张是首帧，首尾帧第 1、2 张分别是首帧、尾帧
  const mode = node.capability === 'video.generate' ? el.params?.mode : undefined
  const tokenOf = (port: InputPort, i: number) => {
    const value = ups.get(port.id)?.[i]?.value
    const sent = submitted?.find(
      (v) =>
        value &&
        v.type === value.type &&
        v.port === port.id &&
        (!v.source || v.source === ups.get(port.id)?.[i]?.source.id) &&
        'assetId' in value &&
        v.assetId === value.assetId,
    )
    return mode === 'reference' && sent && !preparing ? `@${sent.token}` : undefined
  }
  const roleOf = (port: InputPort, i: number) => {
    const token = tokenOf(port, i)
    if (token) return token
    if (port.id === 'videos' || port.id === 'audios')
      return mode === 'reference' ? port.label : '当前模式不使用'
    if (port.id !== 'images') return undefined
    if (mode === 'image') return i === 0 ? '首帧' : '未使用'
    if (mode === 'lastFrame') return i === 0 ? '尾帧' : '未使用'
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
      const value = u.value
      const sent = submitted?.find(
        (v) =>
          value &&
          v.type === value.type &&
          v.port === port.id &&
          (!v.source || v.source === ups.get(port.id)?.[i]?.source.id) &&
          'assetId' in value &&
          v.assetId === value.assetId,
      )
      const unused = !!prepared && !sent
      const tile = (
        <RefTile
          key={u.edgeId}
          index={sent?.index ?? n}
          unused={unused}
          up={u}
          caption={unused ? '未送入' : (roleOf(port, i) ?? caption)}
          onReference={
            tokenOf(port, i) && u.value
              ? () => {
                  const current = engine.doc.get(el.id)
                  if (!current) return
                  const prompt = String(current.params?.prompt ?? '')
                  engine.doc.undo.stopCapturing()
                  setParam(
                    engine.doc,
                    el.id,
                    'prompt',
                    `${prompt}${prompt && !/\s$/.test(prompt) ? ' ' : ''}${tokenOf(port, i)} `,
                  )
                  engine.doc.undo.stopCapturing()
                }
              : undefined
          }
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
        />
      )
      tiles.push(tile)
      if (sent) sentTiles.set(mediaKey(sent), tile)
      else if (prepared) unusedTiles.push(tile)
    }
    if (port.multiple || list.length === 0)
      adds.push(
        <button
          key={`add-${port.id}`}
          type="button"
          onClick={() => {
            setAddAnchor(null)
            pick(port)
          }}
          title={`上传${port.label}，也可以从画布上的对应素材拖线连入`}
          className={`ui-btn ui-btn-sm ui-btn-secondary ${port.required && list.length === 0 ? 'text-danger' : ''}`}
        >
          <Icon name="plus" size={14} />
          {port.label}
        </button>,
      )
  }

  const candidates = filterReferenceCandidates(referenceCandidates(engine, el, media), canvasQuery)

  if (!tiles.length && !adds.length && !texts.length && !trailing && !toolbar) return null
  return (
    <div className="plein-generator-inputs flex flex-col gap-1 px-4 pt-2">
      <div className="plein-generator-input-tools flex flex-wrap items-center gap-2 pr-9">
        {adds.length > 0 && (
          <>
            <button
              type="button"
              className="ui-btn ui-btn-sm ui-btn-secondary"
              aria-label="上传参考"
              aria-expanded={!!addAnchor}
              onClick={(e) => {
                setCanvasAnchor(null)
                setAddAnchor(addAnchor ? null : e.currentTarget)
              }}
            >
              <Icon name="plus" size={14} />
              上传
            </button>
            <Presence>
              {addAnchor && (
                <Popover
                  anchor={addAnchor}
                  onClose={() => setAddAnchor(null)}
                  label="上传参考"
                  width={220}
                >
                  <div className="flex flex-col items-stretch gap-1">{adds}</div>
                </Popover>
              )}
            </Presence>
            <button
              type="button"
              className="ui-btn ui-btn-sm ui-btn-secondary"
              aria-label="画布参考"
              aria-expanded={!!canvasAnchor}
              onClick={(e) => {
                setAddAnchor(null)
                setCanvasQuery('')
                setCanvasAnchor(canvasAnchor ? null : e.currentTarget)
              }}
            >
              <Icon name="board" size={14} />
              画布参考
            </button>
            <Presence>
              {canvasAnchor && (
                <Popover
                  anchor={canvasAnchor}
                  onClose={() => setCanvasAnchor(null)}
                  label="画布参考"
                  width={340}
                >
                  <input
                    className="ui-input mb-2 w-full"
                    aria-label="搜索画布参考"
                    placeholder="搜索画布素材"
                    value={canvasQuery}
                    onChange={(e) => setCanvasQuery(e.target.value)}
                  />
                  <div
                    role="listbox"
                    aria-label="可用画布素材"
                    className="ui-scrollbar max-h-64 overflow-y-auto"
                  >
                    {candidates.map((c) => (
                      <button
                        key={`${c.sourceId}/${c.outputId}/${c.portId}`}
                        type="button"
                        role="option"
                        aria-selected={false}
                        className="ui-menu-item w-full"
                        onClick={() => {
                          if (
                            !media.find((p) => p.id === c.portId)?.multiple &&
                            inputEdges(engine.doc, el.id, c.portId).length
                          ) {
                            useCanvas.getState().notify('该输入已接入参考，请重新选择')
                            return
                          }
                          engine.doc.undo.stopCapturing()
                          const edge = connect(
                            engine.doc,
                            [c.sourceId, c.outputId],
                            [el.id, c.portId],
                          )
                          engine.doc.undo.stopCapturing()
                          if (edge) setCanvasAnchor(null)
                          else useCanvas.getState().notify('无法添加该参考，请重新选择')
                        }}
                      >
                        <Icon
                          name={
                            c.outputType === 'video'
                              ? 'video'
                              : c.outputType === 'audio'
                                ? 'audio'
                                : 'image'
                          }
                          size={16}
                        />
                        <span className="min-w-0 flex-1 text-left">
                          <span className="block truncate">{c.sourceName}</span>
                          <span className="ui-menu-desc">{c.portLabel}</span>
                        </span>
                      </button>
                    ))}
                    {!candidates.length && (
                      <p className="px-2 py-3 text-xs text-ink-subtle">没有匹配的可用素材</p>
                    )}
                  </div>
                </Popover>
              )}
            </Presence>
          </>
        )}
        <RoleReferencePicker engine={engine} nodeId={el.id} data={prepared} />
        {toolbar}
        {trailing && (
          // 结果操作可能排到面板外：让它能换行，别把最后一个按钮裁掉
          <div
            role="toolbar"
            aria-label="结果操作"
            className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-0.5"
          >
            {trailing}
          </div>
        )}
      </div>
      {preparing && (
        <p role="status" className="text-2xs text-ink-subtle">
          正在确认实际输入与编号…
        </p>
      )}
      {submitted?.length || (!prepared && tiles.length) ? (
        <div
          data-testid="submitted-references"
          aria-label="实际送入的参考素材"
          aria-busy={preparing}
          className="ui-scrollbar flex items-start gap-2 overflow-x-auto pt-1.5 pb-0.5"
        >
          {submitted
            ? submitted.map(
                (item) =>
                  sentTiles.get(mediaKey(item)) ?? (
                    <SubmittedTile
                      key={`${item.port}:${item.token}`}
                      engine={engine}
                      el={el}
                      item={item}
                      data={prepared!}
                      onReference={
                        mode === 'reference' && !preparing
                          ? () => insertToken(item.token)
                          : undefined
                      }
                    />
                  ),
              )
            : tiles}
        </div>
      ) : null}
      {unusedTiles.length > 0 && (
        <details className="text-2xs text-ink-subtle" open={submitted?.length === 0}>
          <summary className="cursor-pointer py-1">未送入的连线素材 · {unusedTiles.length}</summary>
          <div className="ui-scrollbar flex gap-2 overflow-x-auto py-1">{unusedTiles}</div>
        </details>
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

/** 参考素材保持紧凑；点击预览，低频管理操作放入独立菜单，拖动与键盘排序仍可直接使用。 */
function RefTile({
  index,
  unused = false,
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
  onReference,
}: {
  index: number
  unused?: boolean
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
  onReference?(): void
}) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const act = (action: () => void) => {
    setAnchor(null)
    action()
  }
  const v = up.value
  const img = preview(v)
  const name = up.source.name ?? '上游'
  const previewLabel = v
    ? `预览「${name}」`
    : up.source.adopted === null && up.source.results?.length
      ? `「${name}」有候选待采用，点击定位来源`
      : up.source.results?.length && up.outputLabel
        ? `「${name}」当前候选缺少可确认的「${up.outputLabel}」输出，点击定位来源`
        : `「${name}」还没有结果，点击定位来源`
  return (
    <div
      role="group"
      aria-label={unused ? `未送入：${name}` : `参考 ${index}：${name}`}
      data-asset-id={v && 'assetId' in v ? v.assetId : undefined}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        onDrop()
      }}
      className="relative flex flex-none items-center gap-1 text-2xs text-ink-subtle"
    >
      <button
        type="button"
        onClick={onPreview}
        aria-label={previewLabel}
        title={previewLabel}
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
        className="relative size-12 shrink-0 overflow-hidden rounded-md bg-surface-2 shadow-1"
      >
        {img ? (
          <img src={img} alt="" className="size-full object-cover" />
        ) : (
          <span className="flex size-full items-center justify-center text-ink-subtle">
            <Icon name={v?.type === 'video' ? 'video' : v?.type === 'audio' ? 'audio' : 'image'} />
          </span>
        )}
        <span className="absolute top-1 left-1 flex size-4 items-center justify-center rounded-full bg-black/60 text-2xs font-medium text-white tabular-nums">
          {unused ? '—' : index}
        </span>
        {!v && <span className="absolute inset-0 bg-canvas/50" />}
      </button>
      <button
        type="button"
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
        aria-label={`管理参考 ${index}`}
        aria-expanded={!!anchor}
        title={`管理参考 ${index}：${name}`}
        className="absolute top-1 left-6 flex size-5 items-center justify-center rounded-md bg-surface/95 text-sm text-ink shadow-1"
      >
        ⋯
      </button>
      {caption &&
        (onReference ? (
          <button
            type="button"
            onClick={onReference}
            className="ui-btn ui-btn-xs ui-btn-quiet"
            title={`在提示词末尾插入 ${caption}；编号按当前同类素材顺序`}
          >
            {caption}
          </button>
        ) : (
          <span>{caption}</span>
        ))}
      <Presence>
        {anchor && (
          <Popover
            anchor={anchor}
            onClose={() => setAnchor(null)}
            label={`管理参考 ${index}`}
            width={220}
          >
            <p className="truncate px-2 py-1 text-xs text-ink-subtle" title={name}>
              {name}
            </p>
            {draggable && (
              <>
                <button
                  type="button"
                  className="ui-menu-item"
                  disabled={!canPrevious}
                  aria-label={`向前移动参考 ${index}`}
                  onClick={() => act(() => onMove(-1))}
                >
                  <span aria-hidden="true">←</span>向前移动
                </button>
                <button
                  type="button"
                  className="ui-menu-item"
                  disabled={!canNext}
                  aria-label={`向后移动参考 ${index}`}
                  onClick={() => act(() => onMove(1))}
                >
                  <span aria-hidden="true">→</span>向后移动
                </button>
              </>
            )}
            <button
              type="button"
              className="ui-menu-item"
              aria-label={`替换参考 ${index}`}
              onClick={() => act(onReplace)}
            >
              <Icon name="retry" size={14} />
              从画布替换
            </button>
            <button
              type="button"
              className="ui-menu-item"
              aria-label={`上传替换参考 ${index}`}
              onClick={() => act(onUpload)}
            >
              <Icon name="upload" size={14} />
              上传替换
            </button>
            <button
              type="button"
              className="ui-menu-item"
              aria-label={`定位参考 ${index}`}
              onClick={() => act(onLocate)}
            >
              <Icon name="locate" size={14} />
              定位来源
            </button>
            <button
              type="button"
              className="ui-menu-item text-danger"
              aria-label={`断开「${name}」`}
              onClick={() => act(onRemove)}
            >
              <Icon name="x" size={14} />
              断开参考
            </button>
          </Popover>
        )}
      </Presence>
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

function SubmittedTile({
  engine,
  el,
  item,
  data,
  onReference,
}: {
  engine: Engine
  el: CanvasElement
  item: SubmittedMedia
  data: PreparedInput
  onReference?: () => void
}) {
  const refs = data.refs.filter((r) => item.assetId && r.sent.includes(item.assetId))
  const source = item.source ? engine.doc.get(item.source) : undefined
  const from = el.params?.continuesFrom as
    | { frameAssetId?: string; last?: boolean }
    | null
    | undefined
  const continuation = !!from && item.type === 'image' && item.index === 1
  const name = continuation
    ? from?.last
      ? '前镜尾帧'
      : '接续帧'
    : refs.map((r) => r.name).join('、') || source?.name || '参考素材'
  const origin = continuation ? '续镜接入' : refs.length ? '@ 引用' : '连线'
  const label =
    data.params.mode === 'reference'
      ? `@${item.token}`
      : `${item.type === 'image' ? '图片' : item.type === 'video' ? '视频' : '音频'}${item.index}`
  return (
    <div
      role="group"
      aria-label={`参考 ${item.index}：${name}`}
      data-asset-id={item.assetId}
      title={`${name} · ${origin}`}
      className="relative flex flex-none items-center gap-1 text-2xs text-ink-subtle"
    >
      <button
        type="button"
        aria-label={`预览「${name}」`}
        className="relative size-12 shrink-0 overflow-hidden rounded-md bg-surface-2"
        onClick={() => {
          if (item.assetId)
            useCanvas.getState().view({ assetId: item.assetId, kind: item.type, name })
        }}
      >
        {item.type === 'audio' ? (
          <Icon name="sound" />
        ) : (
          <img
            src={assetUrls.variant(item.assetId!, item.type === 'video' ? 'poster' : 'thumb-256')}
            alt=""
            className="size-full object-cover"
          />
        )}
        <span className="absolute top-1 left-1 flex size-4 items-center justify-center rounded-full bg-black/60 text-2xs text-white">
          {item.index}
        </span>
        <span className="absolute right-0 bottom-0 left-0 bg-black/60 py-0.5 text-2xs text-white">
          {origin}
        </span>
      </button>
      {onReference ? (
        <button type="button" className="ui-btn ui-btn-xs ui-btn-quiet" onClick={onReference}>
          {label}
        </button>
      ) : (
        <span>{label}</span>
      )}
    </div>
  )
}
