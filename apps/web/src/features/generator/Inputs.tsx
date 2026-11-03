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
import type {
  InputReferenceOrigin,
  InputSentReference,
  InputUnsentReference,
  PreparedInput,
} from '@plein/protocol'
import { DndContext, type DragEndEvent, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import { SortableContext, horizontalListSortingStrategy, useSortable } from '@dnd-kit/sortable'
import {
  parseModelRef,
  referenceLabelStyle,
  referenceMediaLabel,
  type ReferenceIdentity,
} from '@plein/plugin-sdk'
import { filterReferenceCandidates, referenceCandidates } from './referenceCandidates'
import { referenceMedia, submittedMedia } from './submittedMedia'
import { bindReferenceName, referenceName, replaceReferenceName } from './referenceNames'
import { RoleReferencePicker } from './RoleReferencePicker'
import { useRef, useState } from 'react'
import { assetUrls } from '../../api/client'
import { importFiles } from '../../canvas/import'
import { beginImport } from '../../canvas/importProgress'
import { selectedModel } from '../../canvas/modelParams'
import { fieldsOf, upstreams, type NodeInfo, type Upstream } from '../../canvas/nodes'
import { useCanvas } from '../../stores/canvas'
import { useCatalog } from '../../stores/catalog'
import { Icon } from '../../ui/icons'
import { Popover } from '../../ui/Popover'
import { AnimatePresence } from '../../ui/motion'
import { Select } from '../../ui/Select'

type InputPort = NodeInfo['inputs'][number]

/** 上传的素材放在节点左侧多远（世界坐标） */
const UPLOAD_OFFSET = 420

/** 来源角标：一张图可能同时来自连线、@ 引用、角色选择与续镜。 */
const ORIGIN_LABEL: Record<InputReferenceOrigin, string> = {
  edge: '连线',
  mention: '@',
  role: '角色',
  continuation: '续镜',
  binding: '绑定',
}

/** 视频非参考模式下图片的用途；这时提示词里没有平台编号。 */
const FRAME_ROLE_LABEL: Record<NonNullable<InputSentReference['role']>, string> = {
  firstFrame: '首帧',
  lastFrame: '尾帧',
}

const MEDIA_KIND_LABELS = { image: '图片', video: '视频', audio: '音频' } as const

/** 顶部列表按媒体类型分别计数，和各类上限各自对比。 */
function countByKind(items: InputSentReference[]) {
  const counts = { image: 0, video: 0, audio: 0 }
  for (const item of items) counts[item.kind ?? 'image']++
  return counts
}

/**
 * 图片 / 视频 / 音频在最终提示词里的编号写法：图片节点写「图1」，
 * MiniMax 写「图片1」「视频1」，方舟系写「@image1」「@video1」。
 */
function mediaToken(
  node: NodeInfo,
  params: Record<string, unknown> | undefined,
  type: 'image' | 'video' | 'audio',
  index: number,
) {
  return referenceMediaLabel(
    referenceLabelStyle(node.capability, parseModelRef(String(params?.model ?? ''))?.provider),
    type,
    index,
  )
}

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
  preparationError,
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
  preparationError?: boolean
  toolbar?: React.ReactNode
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  // 拖拽换序：拖动过程中不写文档，只在放下时调用一次 move（单个撤销分组）；Esc 取消由 DndContext 处理。
  // 预览按钮本身就是拖把手（与旧的原生 draggable 一致），distance 门槛保证点击预览不受影响；
  // 拖拽/取消后同一次按压的落点点击由库抑制（激活期间在 document 捕获阶段拦截 click，结束 50ms 后移除）。
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))
  const [target, setTarget] = useState<{ port: InputPort; edgeId?: string } | null>(null)
  const [replacing, setReplacing] = useState<{ port: InputPort; edgeId: string } | null>(null)
  const [addAnchor, setAddAnchor] = useState<HTMLButtonElement | null>(null)
  const [canvasAnchor, setCanvasAnchor] = useState<HTMLButtonElement | null>(null)
  const [canvasQuery, setCanvasQuery] = useState('')
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
          if (target?.edgeId) {
            if (replaceInput(engine.doc, target.edgeId, [id, src.kind]) && expected && src.assetId)
              replaceReferenceName(engine.doc, el.id, expected.from[0], {
                type: src.kind as 'image' | 'video' | 'audio',
                source: id,
                assetId: src.assetId,
              })
          } else connect(engine.doc, [id, src.kind], [el.id, port.id])
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
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return
    const activeId = String(active.id)
    // 只在 active 所在端口内换序；跨端口的落下由 move 里的校验拦下
    const port = media.find((p) => (ups.get(p.id) ?? []).some((u) => u.edgeId === activeId))
    if (port) move(port, activeId, String(over.id))
  }
  const previewUpstream = (up: Upstream) => {
    const v = up.value
    if (v && (v.type === 'image' || v.type === 'video' || v.type === 'audio'))
      useCanvas
        .getState()
        .view({ assetId: v.assetId, kind: v.type, name: up.source.name ?? '参考素材' })
    else locate(up)
  }
  const previewAsset = (
    assetId: string,
    name: string,
    kind: 'image' | 'video' | 'audio' = 'image',
  ) => useCanvas.getState().view({ assetId, kind, name })
  const locateElement = (id: string) => {
    if (!engine.doc.has(id)) return
    engine.selection.set([id])
    engine.zoomToFit([id])
  }

  const submitted = prepared && !preparing ? referenceMedia(prepared, el.params, ups) : null
  /** 把这条参考插进提示词末尾，并建立名称绑定，正文里就能 @ 它。 */
  const insertReference = (identity: ReferenceIdentity) => {
    const current = engine.doc.get(el.id)
    if (!current) return
    const name = referenceName(engine.doc, identity)
    const prompt = String(current.params?.prompt ?? '')
    engine.doc.undo.stopCapturing()
    bindReferenceName(engine.doc, el.id, identity)
    setParam(
      engine.doc,
      el.id,
      'prompt',
      `${prompt}${prompt && !/\s$/.test(prompt) ? ' ' : ''}@${name} `,
    )
    engine.doc.undo.stopCapturing()
  }
  // 生成视频的图片按模式标注用途：图生视频第 1 张是首帧，首尾帧第 1、2 张分别是首帧、尾帧
  const mode = node.capability === 'video.generate' ? el.params?.mode : undefined
  /** 非参考模式的视频里，图片按位置表示首帧 / 尾帧；这些位置没有平台编号。 */
  const frameRole = (position: number): InputSentReference['role'] => {
    if (!mode) return undefined
    if (mode === 'image') return position === 1 ? 'firstFrame' : undefined
    if (mode === 'lastFrame') return position === 1 ? 'lastFrame' : undefined
    if (mode === 'frames')
      return position === 1 ? 'firstFrame' : position === 2 ? 'lastFrame' : undefined
    return undefined
  }
  // ── 顶部参考素材：只认服务端给的送入清单，编号与最终提示词一致 ──
  const upsList = media.flatMap((port) => (ups.get(port.id) ?? []).map((u) => ({ port, u })))
  /** 找到送入这张图的那条连线；只有连线来的素材才能排序、替换、移除。 */
  const findUpstream = (item: InputSentReference) => {
    for (const { port, u } of upsList) {
      const v = u.value
      if (!v || !('assetId' in v) || v.assetId !== item.assetId) continue
      if (item.elementId && u.source.id !== item.elementId) continue
      return { port, u }
    }
    return undefined
  }
  /** 未送入的项也要能管理：按来源元素找到仍然存在的连线。 */
  const findUnsentUpstream = (item: InputUnsentReference) => {
    if (item.elementId) {
      const exact = upsList.find(({ u }) => u.source.id === item.elementId)
      if (exact) return exact
    }
    if (!item.assetId) return undefined
    return upsList.find(
      ({ u }) => u.value && 'assetId' in u.value && u.value.assetId === item.assetId,
    )
  }
  const moveUpstream = (port: InputPort, edgeId: string, delta: number) => {
    const ids = (ups.get(port.id) ?? []).map((up) => up.edgeId)
    const i = ids.indexOf(edgeId)
    const j = i + delta
    if (i < 0 || j < 0 || j >= ids.length) return
    const ordered = [...ids]
    ;[ordered[i], ordered[j]] = [ordered[j]!, ordered[i]!]
    engine.doc.undo.stopCapturing()
    reorderInputs(engine.doc, [el.id, port.id], ordered)
    engine.doc.undo.stopCapturing()
  }
  /** 服务端还没给清单时（例如旧记录），退回按连线顺序显示。 */
  const fallbackSent = (): InputSentReference[] => {
    let imageCount = 0
    return upsList.flatMap(({ port, u }, index) => {
      const v = u.value
      if (!v || !('assetId' in v)) return []
      const position = v.type === 'image' ? ++imageCount : undefined
      const sent = submitted?.find(
        (item) =>
          item.port === port.id &&
          item.type === v.type &&
          item.assetId === v.assetId &&
          (!item.source || item.source === u.source.id),
      )
      const number = sent?.index ?? position ?? index + 1
      // 首尾帧模式下按图片位置标用途；服务端给了 sent 时按它给出的顺序。
      const role = position ? frameRole(sent?.index ?? position) : undefined
      return [
        {
          index: number,
          token: mediaToken(node, el.params, v.type, number),
          ...(role ? { role } : {}),
          assetId: v.assetId,
          kind: v.type,
          elementId: u.source.id,
          name: u.source.name ?? '参考素材',
          origins: ['edge' as const],
        },
      ]
    })
  }
  /**
   * 服务端 sent 只包含图片。参考视频 / 音频同样必须出现在唯一的顶部列表里，
   * 按媒体类型各自编号（与最终提示词一致），并从实际输入补进来。
   */
  const extraMedia = (images: InputSentReference[]): InputSentReference[] => {
    if (!prepared) return []
    let offset = images.length
    return submittedMedia(prepared).flatMap((item) => {
      if (item.type === 'image' || !item.assetId) return []
      const found = upsList.find(
        ({ u }) =>
          u.value &&
          'assetId' in u.value &&
          u.value.assetId === item.assetId &&
          u.value.type === item.type,
      )
      const mentioned = (prepared.refs ?? []).filter(
        (ref) => ref.media === item.type && ref.sent.includes(item.assetId!),
      )
      const origins = new Set<InputReferenceOrigin>()
      if (found) origins.add('edge')
      if (mentioned.length) origins.add('mention')
      if (mentioned.some((ref) => ref.kind === 'character')) origins.add('role')
      // 旧执行记录没有 refs 时保留原来的连线来源展示。
      if (!origins.size) origins.add('edge')
      const elementId = found?.u.source.id ?? mentioned[0]?.elementId ?? item.source
      const name =
        found?.u.source.name ??
        mentioned[0]?.name ??
        (item.source && engine.doc.get(item.source)?.name) ??
        '参考素材'
      offset++
      return [
        {
          index: offset,
          token: mediaToken(node, el.params, item.type, item.index),
          assetId: item.assetId,
          kind: item.type,
          ...(elementId ? { elementId } : {}),
          name,
          origins: [...origins],
        },
      ]
    })
  }
  // 必需参考是引用的一项设置，跟着参考素材走：送入的在素材上改，没送入的在「未送入」里改。
  const canRequire = !!node.paramsSchema && fieldsOf(node).some(([key]) => key === 'requiredRefs')
  const requiredRefs = Array.isArray(el.params?.requiredRefs)
    ? (el.params.requiredRefs as string[]).filter((id) => engine.doc.has(id))
    : []
  const toggleRequired = (id: string) =>
    setParam(
      engine.doc,
      el.id,
      'requiredRefs',
      requiredRefs.includes(id) ? requiredRefs.filter((x) => x !== id) : [...requiredRefs, id],
    )
  const authoritative = Array.isArray(prepared?.sent)
  const sentItems = authoritative
    ? [...prepared!.sent!, ...extraMedia(prepared!.sent!)]
    : fallbackSent()
  const unsentItems: InputUnsentReference[] = prepared?.unsent ?? []
  const limit = prepared?.referenceLimit
  // 图片 / 视频 / 音频分开计数，各自对比模型上限；没声明上限的类型只写数量
  const counts = countByKind(sentItems)
  const catalog = useCatalog((s) => s.catalog)
  // 没有参数表的节点选不了模型，也就没有上限可对照
  const modelLimits = node.paramsSchema
    ? selectedModel(catalog, node, el.params)?.info.limits
    : undefined
  const kindLimits = {
    image: limit ?? modelLimits?.references?.max,
    video: modelLimits?.referenceMedia?.video,
    audio: modelLimits?.referenceMedia?.audio,
  }
  const countsText = (['image', 'video', 'audio'] as const)
    .filter((kind) => counts[kind] > 0 || kindLimits[kind] !== undefined)
    .map((kind) =>
      kindLimits[kind] === undefined
        ? `${MEDIA_KIND_LABELS[kind]} ${counts[kind]}`
        : `${MEDIA_KIND_LABELS[kind]} ${counts[kind]}/${kindLimits[kind]}`,
    )
    .join(' · ')

  const tiles: React.ReactNode[] = []
  const sortableIds: string[] = []
  for (const item of sentItems) {
    const found = item.origins.includes('edge') ? findUpstream(item) : undefined
    const port = found?.port
    const up = found?.u
    if (up && port) sortableIds.push(up.edgeId)
    tiles.push(
      <ReferenceTile
        key={`${item.assetId}:${item.index}`}
        item={item}
        up={up}
        index={item.index}
        draggable={!!port?.multiple}
        onLocate={
          up ? () => locate(up) : item.elementId ? () => locateElement(item.elementId!) : undefined
        }
        onPreview={() =>
          up ? previewUpstream(up) : previewAsset(item.assetId, item.name, item.kind)
        }
        onRemove={up ? () => disconnect(up) : undefined}
        onReplace={up && port ? () => setReplacing({ port, edgeId: up.edgeId }) : undefined}
        onUpload={up && port ? () => pick(port, up.edgeId) : undefined}
        onMove={
          up && port
            ? (delta) => {
                const ids = (ups.get(port.id) ?? []).map((item) => item.edgeId)
                const i = ids.indexOf(up.edgeId)
                const j = i + delta
                if (i < 0 || j < 0 || j >= ids.length) return
                const ordered = [...ids]
                ;[ordered[i], ordered[j]] = [ordered[j]!, ordered[i]!]
                engine.doc.undo.stopCapturing()
                reorderInputs(engine.doc, [el.id, port.id], ordered)
                engine.doc.undo.stopCapturing()
              }
            : undefined
        }
        canRequire={canRequire && !!item.elementId}
        required={!!item.elementId && requiredRefs.includes(item.elementId)}
        onToggleRequired={
          canRequire && item.elementId ? () => toggleRequired(item.elementId!) : undefined
        }
        canPrevious={!!up && !!port && (ups.get(port.id) ?? [])[0]?.edgeId !== up.edgeId}
        canNext={!!up && !!port && (ups.get(port.id) ?? []).at(-1)?.edgeId !== up.edgeId}
        onReference={
          up && identityOf(up) && mode === 'reference' && !preparing
            ? () => insertReference(identityOf(up)!)
            : undefined
        }
      />,
    )
  }

  const candidates = filterReferenceCandidates(referenceCandidates(engine, el, media), canvasQuery)
  const hasTiles = tiles.length > 0
  const hasAdds = media.some((port) => port.multiple || !(ups.get(port.id) ?? []).length)
  // 没有媒体端口 / 连线的节点也要显示服务端报告的未送入项（例如 @ 的参考图不被支持）。
  if (!hasTiles && !hasAdds && !texts.length && !unsentItems.length && !trailing && !toolbar)
    return null
  return (
    // 拖拽换序的上下文：主行与未送入折叠区共用，放下才写文档，Esc 取消不写
    <DndContext sensors={sensors} onDragEnd={onDragEnd}>
      <div className="plein-generator-inputs flex flex-col gap-1 px-4 pt-2">
        <div className="plein-generator-input-tools flex flex-wrap items-center gap-2 pr-9">
          {hasAdds && (
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
              <AnimatePresence>
                {addAnchor && (
                  <Popover
                    anchor={addAnchor}
                    onClose={() => setAddAnchor(null)}
                    label="上传参考"
                    width={220}
                  >
                    <div className="flex flex-col items-stretch gap-1">
                      {media.map((port) => (
                        <button
                          key={`add-${port.id}`}
                          type="button"
                          onClick={() => {
                            setAddAnchor(null)
                            pick(port)
                          }}
                          title={`上传${port.label}，也可以从画布上的对应素材拖线连入`}
                          className={`ui-btn ui-btn-sm ui-btn-secondary ${port.required && !(ups.get(port.id) ?? []).length ? 'text-danger' : ''}`}
                        >
                          <Icon name="plus" size={14} />
                          {port.label}
                        </button>
                      ))}
                    </div>
                  </Popover>
                )}
              </AnimatePresence>
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
              <AnimatePresence>
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
              </AnimatePresence>
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
            {preparationError ? '输入确认失败，请在实际输入处重试' : '正在确认参考素材…'}
          </p>
        )}
        <section
          className="plein-generator-references flex min-w-0 flex-col gap-1"
          aria-label="参考素材"
        >
          <div className="flex items-baseline gap-2 px-0.5 text-2xs text-ink-subtle">
            <span className="font-medium text-ink-muted">参考素材</span>
            <span>
              送入 {sentItems.length} 项{countsText ? `（${countsText}）` : ''}
            </span>
          </div>
          {/* 主行可排序的 edgeId：按送入顺序排列 */}
          <SortableContext items={sortableIds} strategy={horizontalListSortingStrategy}>
            <div
              data-testid="submitted-references"
              aria-label="实际送入的参考素材"
              aria-busy={preparing}
              className="ui-scrollbar flex items-start gap-2 overflow-x-auto pt-1 pb-0.5"
            >
              {tiles}
              {!tiles.length && (
                <p className="py-2 text-2xs text-ink-subtle">还没有送入模型的参考素材</p>
              )}
            </div>
          </SortableContext>
        </section>
        {unsentItems.length > 0 && (
          <details className="plein-generator-unsent text-2xs text-ink-subtle">
            <summary className="cursor-pointer py-1">未送入 · {unsentItems.length}</summary>
            <ul className="flex flex-col gap-1 pb-1">
              {unsentItems.map((item) => {
                const found = findUnsentUpstream(item)
                const up = found?.u
                const port = found?.port
                const order = port ? (ups.get(port.id) ?? []).map((x) => x.edgeId) : []
                const at = up ? order.indexOf(up.edgeId) : -1
                return (
                  <li
                    key={`${item.reason}:${item.elementId ?? ''}:${item.assetId ?? ''}:${item.name}`}
                  >
                    <span className="text-ink-muted">{item.name}</span>
                    <span className="mx-1">·</span>
                    <span>{item.message}</span>
                    {item.elementId && engine.doc.has(item.elementId) && (
                      <button
                        type="button"
                        className="ui-btn ui-btn-xs ui-btn-quiet ml-1"
                        onClick={() => locateElement(item.elementId!)}
                      >
                        定位到画布
                      </button>
                    )}
                    {/* 连线来源的未送入项保留原有管理入口：预览、替换、排序、断开。 */}
                    {up && port && (
                      <>
                        <button
                          type="button"
                          className="ui-btn ui-btn-xs ui-btn-quiet ml-1"
                          aria-label={`预览未送入参考「${item.name}」`}
                          title={`预览「${item.name}」`}
                          onClick={() => previewUpstream(up)}
                        >
                          <Icon name="image" size={12} />
                          预览
                        </button>
                        <button
                          type="button"
                          className="ui-btn ui-btn-xs ui-btn-quiet ml-1"
                          aria-label={`替换未送入参考「${item.name}」`}
                          title="从画布替换这条连线"
                          onClick={() => setReplacing({ port, edgeId: up.edgeId })}
                        >
                          <Icon name="retry" size={12} />
                          替换
                        </button>
                        <button
                          type="button"
                          className="ui-btn ui-btn-xs ui-btn-quiet ml-1"
                          aria-label={`上传替换未送入参考「${item.name}」`}
                          title="上传新素材替换这条连线"
                          onClick={() => pick(port, up.edgeId)}
                        >
                          <Icon name="upload" size={12} />
                          上传替换
                        </button>
                        {port.multiple && order.length > 1 && (
                          <>
                            <button
                              type="button"
                              className="ui-btn ui-btn-xs ui-btn-quiet"
                              aria-label={`向前移动未送入参考「${item.name}」`}
                              disabled={at <= 0}
                              onClick={() => moveUpstream(port, up.edgeId, -1)}
                            >
                              ↑
                            </button>
                            <button
                              type="button"
                              className="ui-btn ui-btn-xs ui-btn-quiet"
                              aria-label={`向后移动未送入参考「${item.name}」`}
                              disabled={at < 0 || at >= order.length - 1}
                              onClick={() => moveUpstream(port, up.edgeId, 1)}
                            >
                              ↓
                            </button>
                          </>
                        )}
                        <button
                          type="button"
                          className="ui-btn ui-btn-xs ui-btn-quiet ml-1 text-danger"
                          aria-label={`断开未送入参考「${item.name}」`}
                          onClick={() => disconnect(up)}
                        >
                          <Icon name="x" size={12} />
                          断开
                        </button>
                      </>
                    )}
                    {canRequire && item.elementId && (
                      <button
                        type="button"
                        className="ui-btn ui-btn-xs ui-btn-quiet ml-1"
                        aria-pressed={requiredRefs.includes(item.elementId)}
                        title={
                          requiredRefs.includes(item.elementId)
                            ? '必需参考：缺图或放不下时不提交。点击改为可选'
                            : '设为必需参考：优先送入，缺图或放不下时不提交'
                        }
                        onClick={() => toggleRequired(item.elementId!)}
                      >
                        <Icon name="star" size={12} />
                        {requiredRefs.includes(item.elementId) ? '必需' : '可选'}
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
          </details>
        )}
        {replacing && (
          <div className="flex items-center gap-2 rounded-lg bg-surface-2 p-2">
            <Select
              aria-label="替换参考素材"
              className="ui-input min-w-0 flex-1"
              value=""
              options={[
                { value: '', label: '从当前画布选择素材…', disabled: true },
                ...[...engine.doc.elements()].flatMap((source) =>
                  source.id === el.id
                    ? []
                    : (elementPorts(source)?.outputs ?? [])
                        .filter((p) => p.type === replacing.port.type || p.type === 'any')
                        .map((p) => ({
                          value: JSON.stringify([source.id, p.id]),
                          label: `${source.name ?? source.id} · ${p.label}`,
                        })),
                ),
              ]}
              onChange={(selected) => {
                const [id, portId] = JSON.parse(selected) as [string, string]
                const previous = engine.doc.getEdge(replacing.edgeId)
                engine.doc.undo.stopCapturing()
                const ok = replaceInput(engine.doc, replacing.edgeId, [id, portId])
                const value = upstreams(engine, el.id, null)
                  .get(replacing.port.id)
                  ?.find((up) => up.edgeId === replacing.edgeId)?.value
                if (
                  ok &&
                  previous &&
                  value &&
                  (value.type === 'image' || value.type === 'video' || value.type === 'audio')
                )
                  replaceReferenceName(engine.doc, el.id, previous.from[0], {
                    type: value.type,
                    source: id,
                    assetId: value.assetId,
                  })
                engine.doc.undo.stopCapturing()
                if (!ok) useCanvas.getState().notify('无法替换：素材重复或类型不匹配')
                setReplacing(null)
              }}
            />
            <button
              type="button"
              className="ui-btn ui-btn-quiet"
              onClick={() => setReplacing(null)}
            >
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
    </DndContext>
  )
}

/** 上游素材的身份，用于在提示词末尾插入 @ 名称。 */
function identityOf(up: Upstream): ReferenceIdentity | undefined {
  const value = up.value
  if (!value || value.type === 'text' || value.type === 'json') return undefined
  return { type: value.type, assetId: value.assetId, source: up.source.id }
}

function preview(v: ResultValue | undefined) {
  if (!v) return null
  if (v.type === 'image') return assetUrls.variant(v.assetId, 'thumb-256')
  if (v.type === 'video') return assetUrls.variant(v.assetId, 'poster')
  return null
}

/**
 * 一张送入模型的参考素材：编号徽标与最终提示词一致，
 * 名称和来源（连线 / @ / 角色 / 续镜）都写在图下面。
 */
function ReferenceTile({
  item,
  up,
  index,
  draggable,
  onLocate,
  onRemove,
  onPreview,
  onReplace,
  onUpload,
  onMove,
  canPrevious,
  canNext,
  canRequire,
  required,
  onToggleRequired,
  onReference,
}: {
  item: InputSentReference
  /** 连线来的素材才有；只靠 @ 送入的没有连线，只能显示与定位 */
  up?: Upstream
  index: number
  draggable: boolean
  onLocate?(): void
  onRemove?(): void
  onPreview(): void
  onReplace?(): void
  onUpload?(): void
  onMove?(delta: number): void
  canPrevious: boolean
  canNext: boolean
  canRequire: boolean
  required: boolean
  onToggleRequired?(): void
  onReference?(): void
}) {
  // 不透传 attributes：键盘排序走 Alt+方向键与管理菜单，不走 dnd-kit 的 Enter/Space（避免劫持预览）
  const { listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({
      id: up?.edgeId ?? `sent:${item.assetId}`,
      disabled: !draggable || !up,
    })
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const act = (action: () => void) => {
    setAnchor(null)
    action()
  }
  const v = up?.value
  const kind =
    v?.type === 'image' || v?.type === 'video' || v?.type === 'audio'
      ? v.type
      : (item.kind ?? 'image')
  const img = up
    ? preview(v)
    : kind === 'video'
      ? assetUrls.variant(item.assetId, 'poster')
      : kind === 'audio'
        ? null
        : assetUrls.variant(item.assetId, 'thumb-256')
  const name = item.name
  // 首尾帧按用途显示，不显示平台参考编号（这时提示词不编号）。
  const badge = item.role ? FRAME_ROLE_LABEL[item.role] : item.token
  const origin = item.origins.map((o) => ORIGIN_LABEL[o]).filter(Boolean)
  const previewLabel = up
    ? v
      ? `预览「${name}」`
      : up.source.adopted === null && up.source.results?.length
        ? `「${name}」有候选待采用，点击定位来源`
        : up.source.results?.length && up.outputLabel
          ? `「${name}」当前候选缺少可确认的「${up.outputLabel}」输出，点击定位来源`
          : `「${name}」还没有结果，点击定位来源`
    : `预览「${name}」`
  return (
    <div
      ref={setNodeRef}
      role="group"
      aria-label={`参考 ${index}：${name}`}
      data-asset-id={item.assetId}
      title={`${badge} · ${name}`}
      style={{
        transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
        transition,
        zIndex: isDragging ? 1 : undefined,
      }}
      className="relative flex w-[5.5rem] flex-none flex-col items-start gap-0.5 text-2xs text-ink-subtle"
    >
      <div className="relative w-full">
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...(draggable && up ? listeners : {})}
          onClick={onPreview}
          aria-label={previewLabel}
          title={previewLabel}
          onKeyDown={(e) => {
            if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
              e.preventDefault()
              onMove?.(e.key === 'ArrowLeft' ? -1 : 1)
            }
          }}
          className="relative block size-11 shrink-0 overflow-hidden rounded-md bg-surface-2 shadow-1"
        >
          {img ? (
            <img src={img} alt="" className="size-full object-cover" />
          ) : (
            <span className="flex size-full items-center justify-center text-ink-subtle">
              <Icon name={kind} />
            </span>
          )}
          {!v && up && <span className="absolute inset-0 bg-canvas/50" />}
        </button>
        <span
          data-token={item.token}
          data-role={item.role}
          className="pointer-events-none absolute top-0.5 left-0.5 z-10 rounded bg-black/65 px-1 py-px text-2xs font-medium whitespace-nowrap text-white tabular-nums"
        >
          {badge}
        </span>
        {(onRemove || onReplace || onLocate || (canRequire && onToggleRequired)) && (
          <button
            type="button"
            onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
            aria-label={`管理参考 ${index}`}
            aria-expanded={!!anchor}
            title={`管理参考 ${index}：${name}`}
            className="absolute top-0.5 right-0 flex size-5 items-center justify-center rounded-md bg-surface/95 text-sm text-ink shadow-1"
          >
            ⋯
          </button>
        )}
      </div>
      {onReference ? (
        <button
          type="button"
          onClick={onReference}
          aria-label={`@${name}`}
          title={`在提示词末尾插入 @${name}`}
          className="w-full truncate text-left hover:text-accent"
        >
          {name}
        </button>
      ) : (
        <span className="w-full truncate" title={name}>
          {name}
        </span>
      )}
      {origin.length > 0 && (
        <span className="flex w-full flex-wrap gap-1">
          {origin.map((label) => (
            <span key={label} className="rounded bg-surface-2 px-1 text-2xs text-ink-subtle">
              {label}
            </span>
          ))}
        </span>
      )}
      <AnimatePresence>
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
            {draggable && onMove && (
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
            {onReplace && (
              <button
                type="button"
                className="ui-menu-item"
                aria-label={`替换参考 ${index}`}
                onClick={() => act(onReplace)}
              >
                <Icon name="retry" size={14} />
                从画布替换
              </button>
            )}
            {onUpload && (
              <button
                type="button"
                className="ui-menu-item"
                aria-label={`上传替换参考 ${index}`}
                onClick={() => act(onUpload)}
              >
                <Icon name="upload" size={14} />
                上传替换
              </button>
            )}
            {onToggleRequired && (
              <button
                type="button"
                className="ui-menu-item"
                aria-label={required ? '取消必需参考' : '设为必需参考'}
                onClick={() => act(onToggleRequired)}
              >
                <Icon name="star" size={14} />
                {required ? '取消必需参考' : '设为必需参考'}
              </button>
            )}
            {onLocate && (
              <button
                type="button"
                className="ui-menu-item"
                aria-label={`定位参考 ${index}`}
                onClick={() => act(onLocate)}
              >
                <Icon name="locate" size={14} />
                定位来源
              </button>
            )}
            {onRemove && (
              <button
                type="button"
                className="ui-menu-item text-danger"
                aria-label={`断开「${name}」`}
                onClick={() => act(onRemove)}
              >
                <Icon name="x" size={14} />
                断开参考
              </button>
            )}
          </Popover>
        )}
      </AnimatePresence>
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
