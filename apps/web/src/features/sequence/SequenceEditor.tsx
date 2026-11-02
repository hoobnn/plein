import type { Engine } from '@plein/canvas-core'
import {
  type CanvasElement,
  currentResult,
  inputEdges,
  setParam,
  setParams,
  editSequenceInstance,
  reorderSequenceInstances,
  sequenceInstancesOf,
} from '@plein/doc'
import {
  ANIMATIC_TYPE,
  animaticNode,
  arrangeAnimatic,
  type AnimaticShot,
  arrangeSequence,
  clipLines,
  createSubtitleTrack,
  duckEnvelope,
  type SequenceClip,
  sequenceNode,
  SequenceOverlay,
  sequenceOverlays,
  sequenceOverlayProblem,
  type SequenceParams,
  type SequenceSubtitleTrack,
  sequenceSpec,
  sequenceTimeline,
  sequenceRowKey,
  commitSubtitleTrackEdit,
  retainInstanceSubtitleTrack,
  subtitleExportProblem,
  subtitleInputKey,
} from '@plein/nodes'
import type { PortValue } from '@plein/plugin-sdk'
import type { RecoverJobOptions, SubtitleRecognitionInfo } from '@plein/protocol'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { ApiError, api } from '../../api/client'
import { AssetDownloadButton } from '../../shell/AssetDownloadButton'
import { useDocVersion, useEngineVersion } from '../../canvas/hooks'
import { desktop } from '../../desktop'
import { findNode, upstreams, validate } from '../../canvas/nodes'
import { cancelNode, runNode } from '../runs/run'
import { cancelRequestKey, useCancelRequests } from '../runs/cancelRequests'
import { loadAssetMeta, useAssetMetas } from '../../stores/assetMeta'
import { useCanvas } from '../../stores/canvas'
import { useSession } from '../../stores/session'
import { useCatalog } from '../../stores/catalog'
import { Icon } from '../../ui/icons'
import { Modal, ModalHeader } from '../../ui/Modal'
import { Segmented } from '../../ui/Segmented'
import { Select } from '../../ui/Select'
import { SequencePreview } from './SequencePreview'
import { Presence, useClosing } from '../../ui/Presence'
import { EmptyState } from '../../ui/EmptyState'
import { Playhead } from './playhead'
import { Timeline, type TrackItem, type TrimPatch } from './Timeline'
import { SubtitleEditor } from './SubtitleEditor'
import { refreshAnimatic, relatedSequences } from './animatic'
import { DeliveryReview, useDeliveryReviewSession } from './DeliveryReview'
import { MediaReloadContext } from './media'
import { overlayMediaProblem } from './overlayMedia'
import { OverlayEditor } from './OverlayEditor'
import type { OverlayGeometry } from './OverlayHandles'
import { sequenceParameterProblem } from './parameters'
import { sequenceInputValue, sequenceSourceIdentity } from './instanceModel'
import { SequenceRework } from './SequenceRework'
import { AddFixedInstance, SequenceInstanceTools } from './SequenceInstanceTools'
import { AnimaticSettings } from './AnimaticSettings'
import { ClipSettings } from './ClipSettings'
import { FilmSettings } from './FilmSettings'
import type { Row } from './types'

/** 从画布连线读出各端口的值，交给与服务端相同的 arrangeSequence 排序；没结果的上游先占位 */
function readSequence(engine: Engine, id: string, catalog = useCatalog.getState().catalog) {
  const el = engine.doc.get(id)
  if (el?.nodeType === ANIMATIC_TYPE) {
    const params = animaticNode.params.parse(el.params)
    const rows: Row[] = arrangeAnimatic(params).map((c) => ({
      ...c,
      el: c.clip.source ? engine.doc.get(c.clip.source) : undefined,
      pending: !c.clip.assetId,
    }))
    return {
      el,
      params,
      rows,
      dialogue: [],
      sfx: [],
      music: undefined as string | undefined,
      overlays: [] as PortValue[],
      overlaySources: [] as { value: string; label: string }[],
      animatic: params,
      inputProblem: null,
    }
  }
  const params = sequenceNode.params.parse(el?.params ?? {}) as SequenceParams
  const ups = upstreams(engine, id, catalog)
  const edges = new Map(inputEdges(engine.doc, id).map((edge) => [edge.id, edge]))
  const values = (port: string): PortValue[] =>
    (ups.get(port) ?? []).flatMap((u) => {
      const edge = edges.get(u.edgeId)
      return edge
        ? [sequenceInputValue(u.source, edge, u.value, useCanvas.getState().canvasId)]
        : []
    })
  const inputs = { clips: values('clips'), dialogue: values('dialogue'), sfx: values('sfx') }
  const named = new Map<string, CanvasElement>()
  for (const list of ups.values()) for (const u of list) named.set(u.source.id, u.source)
  const canvasId = useCanvas.getState().canvasId
  const rows: Row[] = arrangeSequence(params, inputs)
    // 来源被删掉的剪辑实例不再占一行：素材已经没有了，列出来也播不出来
    // （固定段自己带着文件，来源删了照样能播，界面上另有一句说明）
    .filter(
      (c) =>
        !c.source ||
        !!c.segment ||
        engine.doc.has(c.source) ||
        (c.clip.sourceCanvasId !== undefined && c.clip.sourceCanvasId !== canvasId),
    )
    .map((c) => ({
      ...c,
      el: c.source ? (engine.doc.get(c.source) ?? named.get(c.source)) : undefined,
      pending: !c.clip.assetId,
    }))
  const options = (port: 'dialogue' | 'sfx') =>
    (ups.get(port) ?? []).map((u, i) => ({
      value: u.source.id,
      label: u.source.name ?? `${port === 'dialogue' ? '对白' : '音效'} ${i + 1}`,
      caption: u.value && 'caption' in u.value ? u.value.caption : undefined,
    }))
  const music = values('music').find((v) => 'assetId' in v && v.assetId)
  const node = findNode(catalog, el?.nodeType)
  return {
    el,
    params,
    rows,
    dialogue: options('dialogue'),
    sfx: options('sfx'),
    overlays: values('overlays').filter((value) => 'assetId' in value && !!value.assetId),
    overlaySources: (ups.get('overlays') ?? []).map((upstream, index) => ({
      value: upstream.source.id,
      label: upstream.source.name ?? `叠加素材 ${index + 1}`,
    })),
    music: music && 'assetId' in music ? music.assetId : undefined,
    animatic: undefined,
    inputProblem: el && node ? validate(node, el, ups, catalog) : null,
  }
}

/** 工程内容身份不包含节点运行进度、画布位置等无关变化。 */
function projectSourceKey(read: ReturnType<typeof readSequence>) {
  return JSON.stringify({
    type: read.el?.nodeType,
    name: read.el?.name,
    params: read.params,
    rows: read.rows.map(({ el: _, ...row }) => row),
    music: read.music,
    overlays: read.overlays,
  })
}

/** 只比较已提交的镜头布局；本地修剪草稿、名称和混音等不使有效手势失效。 */
function sequenceInteractionKey(
  read: ReturnType<typeof readSequence>,
  duration: (assetId: string) => number | undefined,
  readOnly: boolean,
) {
  return JSON.stringify([
    readOnly,
    read.el?.nodeType,
    read.params.transition,
    read.params.transitionDuration,
    read.rows.map((row) => [
      sequenceRowKey(row),
      sequenceSourceIdentity(row),
      row.pending,
      row.in,
      row.out,
      row.speed,
      row.transition,
      row.transitionDuration,
      read.animatic ? row.out : duration(row.clip.assetId),
    ]),
  ])
}

/** 序列编辑器：调整镜头顺序、入出点，指定每段的对白、音效和字幕，导出成片 */
export function SequenceEditor() {
  const engine = useCanvas((s) => s.engine)
  const id = useCanvas((s) => s.sequence)
  const returnTarget = useCanvas((s) => s.sequenceReturn)
  const close = () => {
    const state = useCanvas.getState()
    if (state.engine !== engine || state.sequence !== id) return
    const target = state.sequenceReturn
    state.openSequence(null)
    if (
      target?.sequenceId === id &&
      target.canvasId === state.canvasId &&
      engine?.doc.get(target.boardId)?.nodeType === 'plein/storyboard'
    )
      state.openStoryboard(target.boardId)
  }
  return (
    <Presence>
      {engine && id && engine.doc.get(id) && (
        <GuardedEditor
          key={id}
          engine={engine}
          id={id}
          onClose={close}
          returnToBoard={returnTarget?.sequenceId === id}
        />
      )}
    </Presence>
  )
}

function GuardedEditor({
  engine,
  id,
  onClose,
  returnToBoard,
}: {
  engine: Engine
  id: string
  onClose(): void
  returnToBoard: boolean
}) {
  useEngineVersion(engine)
  const principal = useSession((s) => s.info?.principal)
  const el = engine.doc.get(id)
  if (!el) return null
  const problem = sequenceParameterProblem(el.params, el.nodeType === ANIMATIC_TYPE)
  if (!problem)
    return <Editor engine={engine} id={id} onClose={onClose} returnToBoard={returnToBoard} />
  const readOnly = engine.doc.readOnly || !!el.locked || !principal || principal.role === 'viewer'
  const captured = engine.doc.elementMaps.get(id),
    canvasId = useCanvas.getState().canvasId
  const canWrite = () => {
    const actor = useSession.getState().info?.principal,
      state = useCanvas.getState()
    return (
      !!actor &&
      actor.role !== 'viewer' &&
      !engine.doc.readOnly &&
      !engine.doc.get(id)?.locked &&
      state.engine === engine &&
      state.canvasId === canvasId &&
      state.sequence === id &&
      engine.doc.elementMaps.get(id) === captured
    )
  }
  const restore = () => {
    const current = engine.doc.get(id)
    const state = useCanvas.getState(),
      actor = useSession.getState().info?.principal
    if (
      !canWrite() ||
      !current ||
      current.locked ||
      !actor ||
      actor.role === 'viewer' ||
      state.engine !== engine ||
      state.sequence !== id
    )
      return
    const latest = sequenceParameterProblem(current.params, current.nodeType === ANIMATIC_TYPE)
    if (!latest) return
    engine.doc.undo.stopCapturing()
    setParams(engine.doc, id, latest.patch)
    engine.doc.flush()
    engine.doc.undo.stopCapturing()
  }
  return (
    <Modal label="序列参数问题" onClose={onClose} isolateKeys className="max-w-xl">
      <ModalHeader title="序列参数需要修复" onClose={onClose}>
        <button
          type="button"
          className="ui-btn"
          disabled={readOnly || !engine.doc.undo.undoStack.length}
          onClick={() => {
            if (canWrite()) engine.undo()
          }}
        >
          撤销
        </button>
        <button
          type="button"
          className="ui-btn"
          disabled={readOnly || !engine.doc.undo.redoStack.length}
          onClick={() => {
            if (canWrite()) engine.redo()
          }}
        >
          重做
        </button>
      </ModalHeader>
      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-5">
        <p role="alert" className="break-words">
          无法打开序列：{problem.whole ? '参数格式无效' : problem.labels.join('、')}。
        </p>
        <p>
          原始数据已保留。恢复将{problem.whole ? '重置全部参数' : '仅重置上述无效字段'}
          为默认值，可通过撤销恢复。画布连线和已生成结果会保留。
        </p>
        {problem.lists && <p>无效的镜头或字幕列表会整体重置，请确认后再恢复。</p>}
        {readOnly && <p>当前画布为只读，无法恢复参数。</p>}
        <button type="button" className="ui-btn self-start" disabled={readOnly} onClick={restore}>
          恢复无效字段默认值
        </button>
      </div>
    </Modal>
  )
}

/** 未生成或时长尚未读到的镜头先占这么长，信息就绪后换成真实时长。 */
const PENDING_LENGTH = 2
/** 方向键逐帧移动（按 30 帧） */
const FRAME = 1 / 30

const rowKey = sequenceRowKey

/** 焦点在输入框里时，空格、方向键留给输入框 */
const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))

function Editor({
  engine,
  id,
  onClose,
  returnToBoard,
}: {
  engine: Engine
  id: string
  onClose(): void
  returnToBoard: boolean
}) {
  // 协作者改了顺序也能看到
  const version = useDocVersion(engine.doc)
  const closing = useClosing()
  const catalog = useCatalog((s) => s.catalog)
  const canvasId = useCanvas((s) => s.canvasId)
  // 读序列要遍历上游图并排序，只有文档或节点目录变了才需要重算：
  // 面板自己的状态变化（选中、播放头、展开）不该把整条序列重新算一遍。
  const read = useMemo(
    () => readSequence(engine, id, catalog),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- version 变化即文档变化
    [version, engine, id, catalog, canvasId],
  )
  const { el, params, dialogue, sfx, music, animatic, inputProblem: upstreamProblem } = read
  const principal = useSession((s) => s.info?.principal)
  const [element] = useState(() => engine.doc.elementMaps.get(id))
  const readonly = engine.doc.readOnly || !!el?.locked || !principal || principal.role === 'viewer'
  const filmSequences = animatic ? relatedSequences(engine, id) : []
  const filmNames = filmSequences.map((film) => film.name?.trim() || '成片序列')
  const filmOptions = filmSequences.map((film, index) => {
    const name = filmNames[index]!
    let suffix = 6
    while (
      filmSequences.some(
        (other) => other.id !== film.id && other.id.slice(-suffix) === film.id.slice(-suffix),
      )
    )
      suffix++
    return {
      value: film.id,
      label:
        filmNames.filter((n) => n === name).length > 1
          ? `${name} · ${film.id.slice(-suffix)}`
          : name,
    }
  })
  const [playhead] = useState(() => new Playhead())
  useEffect(() => () => playhead.dispose(), [playhead])
  const [selected, setSelected] = useState<string | undefined>()
  /** 检查器显示选中镜头的设置还是整部成片的设置 */
  const [tab, setTab] = useState<'clip' | 'film' | 'subtitles' | 'overlays'>('clip')
  const [selectedOverlay, setSelectedOverlay] = useState<string>()
  const [view, setView] = useState<'edit' | 'delivery'>('edit')
  const deliverySession = useDeliveryReviewSession()
  const [previewRevision, setPreviewRevision] = useState(0)
  const [animaticError, setAnimaticError] = useState<string | null>(null)
  const latestDelivery = el?.deliveries?.[0]?.id
  const seenDelivery = useRef(latestDelivery)
  useEffect(() => {
    if (latestDelivery && latestDelivery !== seenDelivery.current) setView('delivery')
    seenDelivery.current = latestDelivery
  }, [latestDelivery])
  const [recognizing, setRecognizing] = useState(false)
  const [subtitleError, setSubtitleError] = useState<string | null>(null)
  const [subtitleRecovery, setSubtitleRecovery] = useState<SubtitleRecognitionInfo | null>(null)
  const subtitleStateRevision = useRef(0)
  const subtitleRequest = useRef<object | null>(null)
  /** 用户动过字幕的次数：识别等结果回来时用它判断编辑有没有被顶掉 */
  const subtitleEditRevision = useRef(0)
  // 在时间线上点了镜头就切回镜头设置
  const select = (key: string | undefined) => {
    setSelected(key)
    setSelectedOverlay(undefined)
    if (key) setTab('clip')
  }
  /** 正在拖动修剪的那段：松手前只改显示，不写文档 */
  const [draft, setDraft] = useState<{ key: string; patch: TrimPatch } | null>(null)
  const rows = read.rows.map((r, i) => {
    if (draft?.key !== rowKey(r, i)) return r
    return {
      ...r,
      in: draft.patch.in ?? r.in,
      out: 'out' in draft.patch ? draft.patch.out : r.out,
    }
  })
  // 素材时长（秒）
  const metadata = useAssetMetas(
    [
      ...rows.map((r) => r.clip.assetId),
      ...read.overlays.flatMap((value) => ('assetId' in value ? [value.assetId] : [])),
      ...rows.flatMap((r) => clipLines(r).map((d) => d.assetId)),
    ],
    previewRevision,
  )
  const meta = metadata.get
  const reloadPreview = () => {
    playhead.pause()
    setPreviewRevision((revision) => revision + 1)
  }
  // metadata.get 已经是稳定引用，所以 duration 稳定：可以拿它做 memo 的依赖。
  const duration = useCallback((assetId: string | undefined) => meta(assetId)?.duration, [meta])
  const videoDuration = (assetId: string) => {
    const value = duration(assetId)
    return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined
  }
  // 手势身份要对全部行做一次序列化：序列没变、素材时长没读到新值时不必重算。
  // metadata.revision 一变就说明已知素材集合变了，时长要跟着重算。
  const interactionKey = useMemo(
    () => sequenceInteractionKey(read, duration, readonly),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- metadata.revision 变化即素材时长变化
    [read, duration, readonly, metadata.revision],
  )
  const running = el?.run?.status === 'running' || el?.run?.status === 'queued'
  const active = useCallback(() => {
    const state = useCanvas.getState()
    return (
      !closing &&
      !engine.doc.ydoc.isDestroyed &&
      state.engine === engine &&
      state.canvasId === canvasId &&
      state.sequence === id &&
      engine.doc.elementMaps.get(id) === element
    )
  }, [closing, engine, canvasId, id, element])
  const writable = () => {
    const actor = useSession.getState().info?.principal
    return (
      active() &&
      !engine.doc.readOnly &&
      !engine.doc.get(id)?.locked &&
      !!actor &&
      actor.role !== 'viewer'
    )
  }
  useLayoutEffect(() => {
    subtitleRequest.current = null
    setRecognizing(false)
    return () => {
      // 已提交的识别 / 恢复事实由服务端保留；退出的编辑会话不再写字幕或继续识别。
      subtitleRequest.current = null
    }
  }, [engine, id, canvasId, closing])
  const beginSubtitleRequest = () => {
    const state = useCanvas.getState()
    const node = engine.doc.elementMaps.get(id)
    if (
      closing ||
      subtitleRequest.current ||
      !writable() ||
      !node ||
      state.engine !== engine ||
      state.canvasId !== canvasId ||
      state.sequence !== id
    )
      return null
    const request = {}
    subtitleRequest.current = request
    setRecognizing(true)
    return {
      current: () => {
        const current = useCanvas.getState()
        return (
          subtitleRequest.current === request &&
          current.engine === engine &&
          current.canvasId === canvasId &&
          current.sequence === id &&
          engine.doc.elementMaps.get(id) === node &&
          writable()
        )
      },
      finish: () => {
        if (subtitleRequest.current !== request) return
        subtitleRequest.current = null
        setRecognizing(false)
      },
    }
  }
  const openFilm = (target: string, explicit = false) => {
    if (!target) return
    const state = useCanvas.getState()
    if (state.engine !== engine || state.canvasId !== canvasId || state.sequence !== id) return
    const current = relatedSequences(engine, id)
    if ((!explicit && current.length !== 1) || !current.some((film) => film.id === target)) {
      setAnimaticError('关联成片已变化，本次切换未执行；请重新选择有效成片')
      return
    }
    state.openSequence(target)
  }
  const canceling = useCancelRequests((s) =>
    s.pending.has(cancelRequestKey(canvasId, id, el?.run?.id)),
  )
  const pending = rows.filter((r) => r.pending).length
  // 时间线、预览和导出用同一套排法；还没生成的镜头先按固定长度占位
  const timeline = sequenceTimeline(params, rows, {
    clips: rows.map((r) =>
      animatic
        ? (r.out ?? 0)
        : r.pending
          ? PENDING_LENGTH
          : (videoDuration(r.clip.assetId) ?? PENDING_LENGTH),
    ),
    dialogue: rows.map((r) => (r.dialogue ? duration(r.dialogue.assetId) : undefined)),
    more: rows.map((r) => r.more.map((m) => duration(m.assetId))),
  })
  const overlayProblem =
    sequenceOverlayProblem(params, rows, read.overlays, timeline) ??
    overlayMediaProblem(params, rows, read.overlays, timeline, (assetId) => meta(assetId)?.duration)
  const resolvedOverlays = overlayProblem
    ? []
    : sequenceOverlays(params, rows, read.overlays, timeline)
  const inputProblem = upstreamProblem ?? overlayProblem ?? null
  const selectOverlay = (overlay: string) => {
    setSelectedOverlay(overlay)
    setTab('overlays')
  }
  const known =
    !!animatic || rows.every((r) => !r.pending && videoDuration(r.clip.assetId) !== undefined)
  const subtitleKnown =
    known && rows.every((r) => clipLines(r).every((l) => duration(l.assetId) !== undefined))
  const total = known ? timeline.total : undefined
  const recognitionKey = JSON.stringify([
    params.model,
    ...new Set(read.rows.flatMap((r) => clipLines(r).map((l) => l.assetId)).filter(Boolean)),
  ])
  useEffect(() => {
    const revision = ++subtitleStateRevision.current
    let disposed = false
    const [model, ...assetIds] = JSON.parse(recognitionKey) as string[]
    setSubtitleRecovery(null)
    if (tab !== 'subtitles' || !model) return
    void Promise.all(assetIds.map((assetId) => api.subtitleRecognition(model, assetId)))
      .then((states) => {
        if (!disposed && subtitleStateRevision.current === revision)
          setSubtitleRecovery(states.find((state) => !!state) ?? null)
      })
      .catch((error) => {
        if (!disposed && subtitleStateRevision.current === revision)
          setSubtitleError(`读取识别恢复状态失败：${(error as Error).message}`)
      })
    return () => {
      disposed = true
    }
  }, [tab, recognitionKey])
  playhead.setTotal(timeline.total)

  const current = rows.findIndex((r, i) => rowKey(r, i) === selected)
  const focus = useCanvas((s) => s.sequenceFocus)
  useEffect(() => {
    if (!focus || focus.sequenceId !== id || !active()) return
    const at = rows.findIndex((row, i) => rowKey(row, i) === focus.clipInstanceId)
    if (at < 0 || !known) return
    select(focus.clipInstanceId)
    setView('edit')
    playhead.pause()
    playhead.seek(timeline.clips[at]!.start)
    useCanvas.getState().consumeSequenceFocus(focus.requestId)
  }, [focus, id, known, playhead, rows, active, timeline.clips])
  // 默认选中第一段；选中的镜头断开了就退回第一段
  const firstKey = rows[0] ? rowKey(rows[0], 0) : undefined
  useEffect(() => {
    if (focus?.sequenceId === id) return
    if (current < 0 && firstKey) setSelected(firstKey)
  }, [current, firstKey, focus, id])

  // 捕获阶段拦下按键：编辑器打开时画布的快捷键不生效；播放控制在这里处理
  const keys = useRef<(e: KeyboardEvent) => void>(() => {})
  keys.current = (e) => {
    if (
      !(e.target instanceof Element) ||
      !e.target.closest('[role="dialog"]')?.classList.contains('seq-editor')
    )
      return
    // 输入法候选键不交给字段提交、关闭或播放快捷键；保留浏览器默认组词行为。
    if (e.isComposing || e.keyCode === 229) {
      e.stopPropagation()
      return
    }
    if (e.target instanceof Element && e.target.closest('.ui-select, .ui-menu')) return
    const target = e.target instanceof HTMLElement ? e.target : null
    const key = e.key.toLowerCase()
    const nativeEditing =
      target?.isContentEditable ||
      target?.closest('textarea, select, audio, video, [role="textbox"], [role="combobox"]') ||
      (target instanceof HTMLInputElement &&
        !['checkbox', 'radio', 'button', 'submit', 'reset'].includes(target.type))
    if (
      !e.defaultPrevented &&
      !e.altKey &&
      (e.metaKey || e.ctrlKey) &&
      (key === 'z' || key === 'y') &&
      !nativeEditing
    ) {
      // 子面板保留自己的撤销归属；按钮与复选框上的撤销不回到最近编辑过的文本框。
      if (!target?.closest('[role="dialog"]')?.classList.contains('seq-editor')) return
      e.stopPropagation()
      e.preventDefault()
      const state = useCanvas.getState()
      if (
        writable() &&
        state.engine === engine &&
        state.canvasId === canvasId &&
        state.sequence === id &&
        engine.doc.has(id)
      ) {
        if (key === 'y' || e.shiftKey) engine.redo()
        else engine.undo()
      }
      return
    }
    // 输入框里的按键照常交给输入框（回车提交、Esc 由面板关闭）；画布的快捷键本来就不管输入框
    if (typing(e.target)) return
    // 镜头卡片负责自己的回车激活，避免捕获阶段挡住目标处理器。
    if (e.key === 'Enter' && target?.closest('.seq-clip')) return
    if (e.key === ' ' && target?.closest('button, a[href], [role="button"]')) return
    e.stopPropagation()
    if (e.key === 'Escape') return onClose()
    // 回看页使用原生视频与按钮的按键行为，不控制已经卸载的编辑预览。
    if (view === 'delivery') return
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const step = e.shiftKey ? 1 : FRAME
    if (e.key === ' ') {
      e.preventDefault()
      playhead.toggle()
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      playhead.pause()
      playhead.seek(playhead.t + (e.key === 'ArrowLeft' ? -step : step))
    } else if (e.key === 'Home') {
      e.preventDefault()
      playhead.seek(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      playhead.seek(playhead.total)
    }
  }
  useEffect(() => {
    const key = (e: KeyboardEvent) => keys.current(e)
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [])

  /** 参数里按当前显示顺序记下每段的设置 */
  // 自动对应的对白、音效在这时记下来：之后调换镜头顺序，对白跟着镜头走
  const settings = (list: Row[], clips = params.clips): SequenceClip[] =>
    list.flatMap((r) => {
      if (!r.source) return []
      if (r.clipInstanceId) {
        const original = clips.find((c) => c.clipInstanceId === r.clipInstanceId)
        return original ? [original] : []
      }
      const old = clips.find((c) => c.source === r.source) ?? { source: r.source, in: 0 }
      return [
        {
          ...old,
          dialogue: old.dialogue ?? r.dialogue?.source,
          sfx: old.sfx ?? r.sfx?.source,
        },
      ]
    })
  // 去掉值为 undefined 的键（清空入出点、改回自动）
  // 写完立即派发：复选框、下拉是受控的，等批量通知才重渲染会先弹回旧值再变过来
  const write = (clips: SequenceClip[]) => {
    if (!writable()) return
    setParam(
      engine.doc,
      id,
      'clips',
      clips.map((c) => Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined))),
    )
    engine.doc.flush()
  }
  const patch = (key: string | undefined, p: Partial<SequenceClip>) => {
    if (!key || !writable()) return
    const latest = readSequence(engine, id)
    const row = latest.rows.find((r, i) => rowKey(r, i) === key)
    const displayed = read.rows.find((r, i) => rowKey(r, i) === key)
    if (!row || !displayed || sequenceSourceIdentity(row) !== sequenceSourceIdentity(displayed))
      return
    if (row.clipInstanceId) {
      const raw = sequenceInstancesOf(engine.doc.get(id)!).find((c) => c.clipInstanceId === key)
      if (raw) editSequenceInstance(engine.doc, id, key, p, JSON.stringify(raw))
      engine.doc.flush()
      return
    }
    write(
      settings(latest.rows, latest.params.clips).map((c) =>
        c.source === row.source ? { ...c, ...p } : c,
      ),
    )
  }
  const move = (from: number, to: number) => {
    if (!writable()) return
    const currentElement = engine.doc.get(id)
    if (
      !currentElement ||
      (currentElement.nodeType !== ANIMATIC_TYPE &&
        currentElement.nodeType !== sequenceNode.type) ||
      sequenceParameterProblem(currentElement.params, currentElement.nodeType === ANIMATIC_TYPE)
    )
      return
    const latest = readSequence(engine, id)
    if (
      sequenceInteractionKey(latest, duration, !writable()) !==
      sequenceInteractionKey(read, duration, readonly)
    )
      return
    if (to < 0 || to >= latest.rows.length || from === to) return
    if (latest.animatic) {
      const next = [...latest.animatic.shots]
      const [shot] = next.splice(from, 1)
      next.splice(to, 0, shot!)
      setParam(engine.doc, id, 'shots', next)
      engine.doc.flush()
      return
    }
    const next = [...latest.rows]
    const [r] = next.splice(from, 1)
    next.splice(to, 0, r!)
    if (latest.params.instanceVersion === 2) {
      const raw = sequenceInstancesOf(engine.doc.get(id)!)
      const clips = next.flatMap((r) => raw.filter((c) => c.clipInstanceId === r.clipInstanceId))
      const afterParams = sequenceNode.params.parse({ ...latest.params, clips })
      let track = latest.params.subtitleTrack
      try {
        track = retainInstanceSubtitleTrack(latest.params, latest.rows, afterParams, next)
      } catch (error) {
        setSubtitleError((error as Error).message)
      }
      engine.doc.undo.stopCapturing()
      engine.doc.ydoc.transact(() => {
        if (
          reorderSequenceInstances(
            engine.doc,
            id,
            clips.map((c) => c.clipInstanceId),
            JSON.stringify(raw),
          ) &&
          track
        )
          setParam(engine.doc, id, 'subtitleTrack', track)
      }, engine.doc.origin)
      engine.doc.flush()
      engine.doc.undo.stopCapturing()
      return
    }
    write(settings(next, latest.params.clips))
  }
  const set = (key: keyof SequenceParams, value: unknown) => {
    if (!writable()) return
    setParams(engine.doc, id, { [key]: value })
    engine.doc.flush()
  }
  const updateOverlays = (update: (latest: SequenceOverlay[]) => SequenceOverlay[]) => {
    if (engine.doc.readOnly) return
    const state = useCanvas.getState()
    if (state.engine !== engine || state.sequence !== id) return
    const latest = readSequence(engine, id).params.overlays
    set(
      'overlays',
      update(latest).map((overlay) =>
        Object.fromEntries(Object.entries(overlay).filter(([, value]) => value !== undefined)),
      ),
    )
  }
  const patchOverlayGeometry = (overlayId: string, geometry: OverlayGeometry) => {
    if (engine.doc.readOnly) return
    const original = params.overlays.find((overlay) => overlay.id === overlayId)
    const latest = readSequence(engine, id).params.overlays.find(
      (overlay) => overlay.id === overlayId,
    )
    if (!original || JSON.stringify(original) !== JSON.stringify(latest)) return
    engine.doc.undo.stopCapturing()
    updateOverlays((overlays) =>
      overlays.map((overlay) => (overlay.id === overlayId ? { ...overlay, ...geometry } : overlay)),
    )
    engine.doc.undo.stopCapturing()
  }
  const subtitleDurations = () => ({
    clips: read.rows.map((r) => (animatic ? (r.out ?? 0) : (duration(r.clip.assetId) ?? 0))),
    dialogue: read.rows.map((r) => (r.dialogue ? duration(r.dialogue.assetId) : undefined)),
    more: read.rows.map((r) => r.more.map((m) => duration(m.assetId))),
  })
  const buildSubtitles = () => {
    if (!writable()) return
    const next = { ...params, asrTiming: false }
    setParams(engine.doc, id, {
      asrTiming: false,
      subtitleTrack: createSubtitleTrack(next, read.rows, subtitleDurations()),
    })
    engine.doc.flush()
    setSubtitleError(null)
  }
  const editSubtitles = (track: SequenceSubtitleTrack) => {
    if (!writable()) return
    // 用户动过字幕就算改过：哪怕这次编辑因为字幕轨过期没写进文档，
    // 等待中的识别结果也不能把用户刚输入的文字顶掉。
    subtitleEditRevision.current++
    const latest = readSequence(engine, id)
    if (JSON.stringify(latest.params.subtitleTrack) !== JSON.stringify(params.subtitleTrack)) {
      setSubtitleError('字幕轨已由其他操作更新，本次未覆盖，请重新核对')
      return
    }
    try {
      const next = commitSubtitleTrackEdit(latest.params, latest.rows, track.cues)
      setParam(engine.doc, id, 'subtitleTrack', next)
      engine.doc.flush()
      setSubtitleError(null)
    } catch (error) {
      setSubtitleError((error as Error).message)
    }
  }
  const recognizeSubtitles = async () => {
    if (!writable() || subtitleRequest.current || !subtitleKnown) return
    if (!params.model) {
      setSubtitleError('请先在成片设置中选择语音识别模型')
      return
    }
    const assetIds = [...new Set(read.rows.flatMap((r) => clipLines(r).map((l) => l.assetId)))]
    if (!assetIds.length) {
      setSubtitleError('没有连入对白，可按当前台词创建字幕后手动编辑')
      return
    }
    const snapshot = { ...params, asrTiming: true }
    const inputKey = subtitleInputKey(snapshot, read.rows)
    const originalTrack = JSON.stringify(params.subtitleTrack)
    const editRevision = subtitleEditRevision.current
    const request = beginSubtitleRequest()
    if (!request) return
    subtitleStateRevision.current++
    setSubtitleRecovery(null)
    setSubtitleError(null)
    try {
      const { transcripts } = await api.subtitleRecognize({ model: params.model, assetIds })
      if (!request.current()) return
      const latest = readSequence(engine, id)
      if (
        !engine.doc.get(id) ||
        !writable() ||
        latest.params.asrTiming !== params.asrTiming ||
        subtitleInputKey({ ...latest.params, asrTiming: true }, latest.rows) !== inputKey ||
        JSON.stringify(latest.params.subtitleTrack) !== originalTrack ||
        // 等待期间用户动过字幕：结果留着，但不能把用户刚输入的内容顶掉
        subtitleEditRevision.current !== editRevision
      ) {
        setSubtitleError(
          '识别期间素材或字幕已修改，本次结果已缓存，未覆盖编辑；请按当前内容重新识别（相同音频不重复提交）',
        )
        return
      }
      const track = createSubtitleTrack(snapshot, read.rows, subtitleDurations(), transcripts)
      setParams(engine.doc, id, { asrTiming: true, subtitleTrack: track })
      engine.doc.flush()
    } catch (error) {
      if (!request.current()) return
      setSubtitleError((error as Error).message)
      if (error instanceof ApiError)
        setSubtitleRecovery(
          (error.body as { recovery?: SubtitleRecognitionInfo | null })?.recovery ?? null,
        )
    } finally {
      request.finish()
    }
  }
  const recoverSubtitles = async (operation: RecoverJobOptions, confirmedNotAccepted = false) => {
    if (!writable() || !subtitleRecovery || subtitleRequest.current) return
    const inputKey = subtitleInputKey(params, read.rows)
    const request = beginSubtitleRequest()
    if (!request) return
    subtitleStateRevision.current++
    try {
      await api.subtitleRecover({
        model: subtitleRecovery.model,
        assetId: subtitleRecovery.assetId,
        expected: subtitleRecovery.expected,
        operation,
        confirmedNotAccepted,
      })
      if (!request.current()) return
      setSubtitleRecovery(null)
      if (operation.action === 'dismiss') {
        setSubtitleError(null)
        return
      }
      const latest = readSequence(engine, id)
      if (subtitleInputKey(latest.params, latest.rows) !== inputKey) {
        setSubtitleError('素材在恢复期间已变化，恢复记录已保存，请重新检查字幕后再识别')
        return
      }
      request.finish()
      await recognizeSubtitles()
    } catch (error) {
      if (request.current()) setSubtitleError((error as Error).message)
    } finally {
      request.finish()
    }
  }
  const trim = (key: string, p: TrimPatch, done: boolean) => {
    if (!writable()) return setDraft(null)
    if (!done) return setDraft('in' in p || 'out' in p ? { key, patch: p } : null)
    setDraft(null)
    const r = read.rows.find((x, i) => rowKey(x, i) === key)
    patch(r ? rowKey(r) : undefined, p)
  }

  /** 导出剪辑工程：和成片同一套合成参数，服务端打包成 OTIO / FCPXML + 素材的 zip */
  const [packing, setPacking] = useState(false)
  const [packError, setPackError] = useState<string | null>(null)
  const [packNotice, setPackNotice] = useState<string | null>(null)
  const packRequest = useRef<{ controller: AbortController; key: string } | null>(null)
  const packKey = useMemo(() => projectSourceKey(read), [read])
  const cancelProject = useCallback((silent = false) => {
    const pending = packRequest.current
    packRequest.current = null
    pending?.controller.abort()
    setPacking(false)
    setPackError(null)
    if (silent) setPackNotice(null)
    else if (pending) setPackNotice('已取消工程文件读取，可重新导出')
  }, [])
  useLayoutEffect(() => {
    cancelProject(true)
    return () => {
      const pending = packRequest.current
      packRequest.current = null
      pending?.controller.abort()
    }
  }, [engine, id, canvasId, closing, cancelProject])
  useLayoutEffect(() => {
    if (packRequest.current && packRequest.current.key !== packKey) {
      cancelProject(true)
      setPackError('剪辑内容已变化，本次工程未下载；请检查后重新导出')
    }
  }, [packKey, cancelProject])
  const exportProject = async () => {
    if (packing || packRequest.current || inputProblem || closing) return
    const pending = { controller: new AbortController(), key: packKey }
    packRequest.current = pending
    const signal = AbortSignal.any([pending.controller.signal, AbortSignal.timeout(10 * 60_000)])
    const active = () => {
      const state = useCanvas.getState()
      return (
        packRequest.current === pending &&
        !pending.controller.signal.aborted &&
        state.engine === engine &&
        state.canvasId === canvasId &&
        state.sequence === id
      )
    }
    const current = () => {
      if (!active()) return false
      if (projectSourceKey(readSequence(engine, id)) !== pending.key)
        throw new Error('剪辑内容已变化，本次工程未下载；请检查后重新导出')
      return true
    }
    setPacking(true)
    setPackError(null)
    setPackNotice(null)
    try {
      if (!current()) return
      const required = [
        ...new Set(
          rows.flatMap((row) => [
            ...(animatic ? [] : [row.clip.assetId]),
            ...clipLines(row).map((line) => line.assetId),
          ]),
        ),
      ]
      setPackNotice('正在读取素材时长，完成后继续导出工程…')
      signal.throwIfAborted()
      await new Promise<void>((resolve, reject) => {
        const aborted = () => reject(signal.reason)
        signal.addEventListener('abort', aborted, { once: true })
        // 元信息缓存由预览等界面共享，取消本次等待不取消共享读取。
        void Promise.all(
          required.map(async (assetId) => {
            const asset = await loadAssetMeta(assetId)
            if (
              asset.duration === undefined ||
              !Number.isFinite(asset.duration) ||
              asset.duration <= 0
            )
              throw new Error(`素材“${asset.name || assetId}”缺少有效时长，无法导出工程`)
          }),
        )
          .then(() => resolve(), reject)
          .finally(() => signal.removeEventListener('abort', aborted))
      })
      if (!current()) return
      setPackNotice(null)
      const spec = sequenceSpec(
        params,
        rows,
        {
          clips: rows.map((r) => (animatic ? (r.out ?? 0) : (duration(r.clip.assetId) ?? 0))),
          dialogue: rows.map((r) => (r.dialogue ? duration(r.dialogue.assetId) : undefined)),
          more: rows.map((r) => r.more.map((m) => duration(m.assetId))),
        },
        music ? [{ type: 'audio', assetId: music, kind: 'audio' }] : undefined,
        el?.name,
        undefined,
        read.overlays,
      )
      const { url } = await api.sequenceExport({ spec }, signal)
      if (!current()) return
      const blob = await api.sequenceExportFile(url, signal)
      if (!current()) return
      const local = URL.createObjectURL(blob)
      try {
        const a = document.createElement('a')
        a.href = local
        a.download = `${(el?.name ?? '序列').replace(/[\\/:*?"<>|]/g, '_')}.zip`
        document.body.appendChild(a)
        try {
          a.click()
        } finally {
          a.remove()
        }
      } finally {
        setTimeout(() => URL.revokeObjectURL(local), 1000)
      }
      setPackNotice('工程文件已交给浏览器下载，请查看保存状态')
    } catch (err) {
      if (active()) {
        setPackNotice(null)
        setPackError(
          signal.aborted
            ? '工程文件读取超时，请检查连接后重新导出'
            : (err as Error).message || '导出工程失败',
        )
      }
    } finally {
      if (packRequest.current === pending) {
        packRequest.current = null
        setPacking(false)
      }
    }
  }

  const exportVideo = () => {
    if (canceling || !writable()) return
    if (running) void cancelNode(id, el?.run?.id)
    else if (writable() && !inputProblem) void runNode(id)
  }
  const progress = el?.run?.status === 'running' ? el.run.progress : undefined
  const film = el && currentResult(el)?.value
  const filmAsset = film && film.type === 'video' ? film.assetId : undefined
  const subtitleProblem = subtitleExportProblem(params, read.rows)

  let timingReady = true
  const items: TrackItem[] = rows.map((r, i) => {
    const t = timeline.clips[i]!
    const m = meta(r.clip.assetId)
    const own = clipLines(r)
    timingReady =
      timingReady && (!!animatic || r.pending || videoDuration(r.clip.assetId) !== undefined)
    return {
      key: rowKey(r, i),
      timingReady,
      index: i,
      name: r.el?.name ?? `镜头 ${i + 1}`,
      assetId: r.clip.assetId,
      kind: animatic ? 'image' : 'video',
      pending: r.pending,
      start: t.start,
      length: t.length,
      in: r.in,
      out: r.out,
      full: m?.duration,
      aspect: m?.width && m.height ? m.width / m.height : 9 / 16,
      speed: r.speed,
      transition: t.transition,
      lines: t.lines.map((l, k) => ({
        assetId: own[k]!.assetId,
        start: l.start,
        duration: l.duration,
        caption: own[k]!.caption,
      })),
      sfx:
        r.sfx && t.length > 0
          ? { assetId: r.sfx.assetId, start: t.start, length: t.length }
          : undefined,
      cues: t.cues,
    }
  })
  const row = current >= 0 ? rows[current] : undefined

  return (
    <Modal label="序列" onClose={onClose} className="seq-editor h-full max-w-7xl">
      <ModalHeader
        title={el?.name ?? '序列'}
        onClose={onClose}
        meta={
          <span className="ui-chip tabular-nums">
            {rows.length} 段{total !== undefined && ` · ${total.toFixed(1)} 秒`}
          </span>
        }
      >
        {returnToBoard && (
          <button type="button" className="ui-btn ui-btn-quiet" onClick={onClose}>
            返回分镜表
          </button>
        )}
        {view === 'edit' && (
          <button
            type="button"
            className="ui-btn ui-btn-quiet"
            title="重新加载素材信息、画面、缩略图和波形，保留剪辑设置与播放位置"
            onClick={reloadPreview}
          >
            <Icon name="retry" />
            重新加载预览
          </button>
        )}
        {animatic && (
          <>
            <span className="ui-chip">样片 / 草稿</span>
            <button
              className="ui-btn ui-btn-quiet"
              type="button"
              title="更新当前采用的分镜图和配音；保留样片顺序与节奏，新增镜头追加，已删除镜头移除"
              disabled={readonly}
              onClick={() => {
                if (writable()) setAnimaticError(refreshAnimatic(engine, id))
              }}
            >
              更新已有素材
            </button>
            {filmSequences.length === 1 && (
              <button
                className="ui-btn ui-btn-quiet"
                type="button"
                onClick={() => openFilm(filmSequences[0]!.id)}
              >
                切回成片
              </button>
            )}
            {filmSequences.length > 1 && (
              <Select
                aria-label="选择成片序列"
                className="max-w-52"
                value=""
                options={[
                  { value: '', label: `选择成片序列（${filmSequences.length}）`, disabled: true },
                  ...filmOptions,
                ]}
                onChange={(target) => openFilm(target, true)}
              />
            )}
          </>
        )}
        <button
          type="button"
          className="ui-btn ui-btn-quiet"
          disabled={
            packing ||
            rows.length === 0 ||
            !known ||
            !!inputProblem ||
            !!subtitleProblem ||
            (!!animatic && pending > 0)
          }
          title={
            inputProblem ??
            (pending
              ? animatic
                ? `缺少 ${pending} 张分镜图；样片 MP4 可用占位，工程导出需要补齐素材`
                : `还有 ${pending} 段镜头没有生成`
              : (subtitleProblem ??
                '导出 OTIO / FCPXML 剪辑工程（连同素材打包），在达芬奇、Final Cut 里接着剪'))
          }
          onClick={() => void exportProject()}
        >
          <Icon name="exportFile" />
          {packing ? '正在读取工程…' : '导出工程'}
        </button>
        {packing && (
          <button type="button" className="ui-btn ui-btn-quiet" onClick={() => cancelProject()}>
            取消工程导出
          </button>
        )}
        {filmAsset && !running && view === 'edit' && (
          <AssetDownloadButton
            engine={engine}
            assetId={filmAsset}
            name={`${el?.name ?? '成片'}.mp4`}
            label={desktop ? '另存为…' : '下载成片'}
          />
        )}
        <span aria-hidden="true" className="ui-bar-sep" />
        <button
          type="button"
          className={running ? 'ui-btn ui-btn-secondary' : 'ui-btn ui-btn-primary'}
          disabled={
            canceling ||
            readonly ||
            (!running &&
              (readonly ||
                !!inputProblem ||
                rows.length === 0 ||
                (!animatic && pending > 0) ||
                !!subtitleProblem))
          }
          aria-busy={canceling}
          aria-label={running || canceling ? '停止导出' : undefined}
          title={
            running
              ? '停止当前导出任务'
              : (inputProblem ??
                (animatic
                  ? (subtitleProblem ?? '仅本地合成草稿；不生成视频、配音或自动识别字幕')
                  : pending
                    ? `还有 ${pending} 段镜头没有生成`
                    : subtitleProblem))
          }
          onClick={exportVideo}
        >
          {canceling ? (
            <span role="status">正在停止任务…</span>
          ) : running ? (
            <>
              <Icon name="stop" size={14} />
              {`导出中${progress ? ` ${Math.round(progress * 100)}%` : '…'}`}
            </>
          ) : (
            <>
              <Icon name="download" />
              {el?.results?.length ? '重新导出' : animatic ? '导出样片 MP4' : '导出 MP4'}
            </>
          )}
        </button>
      </ModalHeader>
      {readonly && (
        <p role="status" className="px-4 py-2 text-sm text-ink-muted">
          当前画布为只读，仍可预览，暂不能修改或生成新成片。
        </p>
      )}
      {view === 'edit' && metadata.loading && !packing && (
        <p
          role="status"
          aria-label="素材信息加载"
          className="flex-none px-4 py-2 text-xs text-ink-muted"
        >
          正在读取素材时长与尺寸，预览排布可能暂不完整。
        </p>
      )}
      {view === 'edit' && metadata.errors.length > 0 && (
        <div
          role="alert"
          aria-label="素材信息读取失败"
          className="flex-none border-b border-line px-4 py-3 text-sm"
        >
          <p className="font-medium text-danger">
            素材信息读取失败，预览时长或声音排布可能不完整。
          </p>
          <div className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap select-text [overflow-wrap:anywhere]">
            {[...new Set(metadata.errors.map((error) => error.message))].join('\n')}
          </div>
          <button
            type="button"
            className="ui-btn ui-btn-secondary ui-btn-xs mt-2"
            onClick={reloadPreview}
          >
            重试素材信息
          </button>
          <p className="mt-1 text-xs text-ink-muted">重试保留剪辑设置与播放位置。</p>
        </div>
      )}
      {packError && (
        <div
          role="alert"
          aria-label="工程导出失败"
          className="flex-none border-b border-line px-4 py-3 text-sm"
        >
          <p className="font-medium text-danger">工程导出失败</p>
          <p className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap select-text [overflow-wrap:anywhere]">
            {packError}
          </p>
          <p className="mt-1 text-xs text-ink-muted">修正后可再次点击“导出工程”重试。</p>
        </div>
      )}
      {packNotice && (
        <p role="status" className="flex-none px-4 py-2 text-sm text-ink-muted">
          {packNotice}
        </p>
      )}
      {el?.run?.status === 'failed' && !running && (
        <div
          role="alert"
          aria-label="成片导出失败"
          className="flex-none border-b border-line px-4 py-3 text-sm"
        >
          <p className="font-medium text-danger">成片导出失败</p>
          {filmAsset && <p className="mt-1 text-ink-muted">已有成片与交付记录已保留。</p>}
          <p className="mt-1 text-ink-muted">
            检查素材或导出设置，修正后可用右上角的导出按钮重试。
          </p>
          <details className="mt-2">
            <summary className="cursor-pointer text-xs underline underline-offset-2">
              查看错误详情
            </summary>
            <pre className="mt-2 max-h-32 overflow-auto rounded-md bg-surface-2 p-2 text-xs whitespace-pre-wrap select-text [overflow-wrap:anywhere]">
              {el.run.error || '未返回具体错误原因。'}
            </pre>
          </details>
        </div>
      )}
      {animaticError && (
        <p role="alert" className="flex-none border-b border-line px-5 py-3 text-sm text-danger">
          {animaticError}
        </p>
      )}
      {animatic && (
        <p className="px-4 text-xs text-ink-muted">
          仅使用创建或更新时已有的分镜图、配音。调整时长与对白节奏只改变样片；原生成结果保留。
          更新素材保留已有镜头顺序与节奏，新增镜头追加到末尾，已删除镜头移除。
          {pending > 0 && ` ${pending} 镜缺图，将显示占位。`}
        </p>
      )}
      {inputProblem && (
        <p role="status" className="px-4 py-2 text-sm text-danger [overflow-wrap:anywhere]">
          {inputProblem}。请先补齐结果或断开不需要的连线后再导出。
        </p>
      )}
      {overlayProblem && (
        <p role="alert" className="px-4 py-2 text-sm text-danger">
          {overlayProblem}
          <button type="button" className="ml-2 underline" onClick={() => setTab('overlays')}>
            检查叠加轨
          </button>
        </p>
      )}
      {subtitleProblem && (
        <p role="status" className="px-4 text-sm text-danger">
          {subtitleProblem}{' '}
          <button type="button" className="underline" onClick={() => setTab('subtitles')}>
            编辑字幕
          </button>
        </p>
      )}

      <div className="px-4 py-2">
        <Segmented
          label="序列视图"
          value={view}
          options={[
            { value: 'edit', label: animatic ? '样片编辑预览' : '剪辑预览' },
            { value: 'delivery', label: '实际 MP4 回看 / 交付' },
          ]}
          onChange={setView}
        />
      </div>
      {!animatic && canvasId && view === 'edit' && (
        <AddFixedInstance
          engine={engine}
          canvasId={canvasId}
          sequenceId={id}
          writable={writable}
          readCurrent={() => readSequence(engine, id)}
          onSelect={select}
        />
      )}
      {view === 'delivery' && el ? (
        <DeliveryReview engine={engine} node={el} session={deliverySession} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon="video"
          title="还没有镜头"
          hint="把视频节点的输出连到序列的「镜头」端口，配音连到「对白」，配乐连到「配乐」。"
        />
      ) : (
        <div className="seq-edit-body flex min-h-0 flex-1 flex-col">
          <div className="seq-edit-top flex min-h-0 flex-1">
            <SequencePreview
              key={previewRevision}
              rows={rows.map((row) => ({
                ...row,
                clip: { ...row.clip, mime: row.clip.mime ?? meta(row.clip.assetId)?.mime },
              }))}
              timeline={timeline}
              params={params}
              music={music}
              playhead={playhead}
              draft={!!animatic}
              overlays={resolvedOverlays}
              selectedOverlay={selectedOverlay}
              readOnly={readonly}
              onSelectOverlay={selectOverlay}
              onPatchOverlay={patchOverlayGeometry}
            />
            <aside className="seq-inspector" aria-label="剪辑设置">
              <div className="seq-tabs">
                <Segmented
                  label="设置范围"
                  value={tab}
                  options={[
                    { value: 'clip', label: '镜头' },
                    { value: 'film', label: '成片' },
                    { value: 'subtitles', label: '字幕' },
                    ...(!animatic ? [{ value: 'overlays' as const, label: '叠加' }] : []),
                  ]}
                  onChange={setTab}
                />
              </div>
              <div
                key={tab === 'clip' ? `clip:${selected ?? ''}` : 'film'}
                className="seq-inspector-body ui-scrollbar"
              >
                <fieldset disabled={readonly} className="m-0 min-w-0 border-0 p-0">
                  <legend className="sr-only">剪辑参数</legend>
                  {tab === 'overlays' ? (
                    <OverlayEditor
                      overlays={params.overlays}
                      readOnly={readonly}
                      sources={read.overlaySources.map((source) => ({
                        ...source,
                        duration: duration(
                          (
                            read.overlays.find((value) => value.source === source.value) as
                              | { assetId?: string }
                              | undefined
                          )?.assetId,
                        ),
                      }))}
                      clips={rows.flatMap((row, index) =>
                        row.source
                          ? [{ value: row.source, label: row.el?.name ?? `镜头 ${index + 1}` }]
                          : [],
                      )}
                      selected={selectedOverlay}
                      onSelect={selectOverlay}
                      onChange={updateOverlays}
                      onBoundary={() => engine.doc.undo.stopCapturing()}
                      duration={timeline.total}
                    />
                  ) : tab === 'subtitles' ? (
                    <SubtitleEditor
                      params={params}
                      rows={read.rows}
                      busy={recognizing || !subtitleKnown}
                      error={subtitleError}
                      onBuild={buildSubtitles}
                      onRecognize={() => void recognizeSubtitles()}
                      onChange={editSubtitles}
                      onEditBoundary={() => engine.doc.undo.stopCapturing()}
                      onModelChange={(model) => set('model', model)}
                      recovery={subtitleRecovery}
                      onRecover={(operation, confirmed) =>
                        void recoverSubtitles(operation, confirmed)
                      }
                    />
                  ) : tab === 'film' ? (
                    <FilmSettings
                      params={params}
                      readParams={() => readSequence(engine, id).params}
                      set={set}
                    />
                  ) : row && animatic ? (
                    <AnimaticSettings
                      shot={animatic.shots[current]!}
                      index={current}
                      count={rows.length}
                      onMove={(to) => move(current, to)}
                      onChange={(patch) => {
                        if (!writable()) return
                        const latest = readSequence(engine, id).animatic
                        if (!latest) return
                        const original = animatic.shots[current]
                        const shot = latest.shots.find((s) => s.shotId === row.source)
                        if (!original || !shot) return
                        if (
                          Object.keys(patch).some(
                            (key) =>
                              !Object.is(
                                original[key as keyof AnimaticShot],
                                shot[key as keyof AnimaticShot],
                              ),
                          )
                        ) {
                          setAnimaticError('镜头设置已更新，本次未覆盖；请核对最新数值后重新修改。')
                          return
                        }
                        setParam(
                          engine.doc,
                          id,
                          'shots',
                          latest.shots.map((s) =>
                            s.shotId === row.source ? { ...s, ...patch } : s,
                          ),
                        )
                        engine.doc.flush()
                        setAnimaticError(null)
                      }}
                    />
                  ) : row ? (
                    <>
                      {row.clipInstanceId && (
                        <SequenceInstanceTools
                          key={`instance:${row.clipInstanceId}`}
                          engine={engine}
                          canvasId={canvasId}
                          sequenceId={id}
                          row={row}
                          writable={writable}
                          readCurrent={() => readSequence(engine, id)}
                          onSelect={select}
                          onNotice={setSubtitleError}
                        />
                      )}
                      <SequenceRework
                        key={`rework:${row.clipInstanceId ?? row.source}`}
                        engine={engine}
                        sequenceId={id}
                        row={row}
                        writable={writable}
                      />
                      <ClipSettings
                        // 素材换了只重置入出点的草稿（它们自己按素材编号重新挂载），
                        // 字幕和音量的草稿要留着：换素材不该把没提交的字丢掉
                        key={rowKey(row, current)}
                        row={row}
                        readRow={() =>
                          readSequence(engine, id).rows.find((r, i) => rowKey(r, i) === selected)
                        }
                        index={current}
                        count={rows.length}
                        full={duration(row.clip.assetId)}
                        length={timeline.clips[current]?.length}
                        params={params}
                        dialogue={dialogue}
                        sfx={sfx}
                        onMove={(to) => move(current, to)}
                        onPatch={(p) => patch(rowKey(row, current), p)}
                      />
                    </>
                  ) : (
                    <p className="ui-help">在时间线上点一段镜头，在这里调整它。</p>
                  )}
                </fieldset>
              </div>
            </aside>
          </div>
          <MediaReloadContext.Provider value={previewRevision}>
            <Timeline
              readOnly={readonly}
              interactionKey={interactionKey}
              readInteractionKey={() =>
                sequenceInteractionKey(readSequence(engine, id), duration, !writable())
              }
              onBeforeInteract={() => {
                const active = document.activeElement
                if (active instanceof HTMLElement && active.closest('.seq-inspector'))
                  // 先提交字段并重算时间线，再处理选择／拖动，避免丢草稿或沿用旧起点。
                  flushSync(() => active.blur())
              }}
              items={items}
              overlays={resolvedOverlays.map((overlay, index) => ({
                id: overlay.id,
                name:
                  read.overlaySources.find(
                    (source) =>
                      source.value ===
                      params.overlays.find((entry) => entry.id === overlay.id)?.source,
                  )?.label ?? `叠加 ${index + 1}`,
                start: overlay.start,
                duration: overlay.duration,
              }))}
              selectedOverlay={selectedOverlay}
              onSelectOverlay={selectOverlay}
              total={timeline.total}
              music={
                music
                  ? {
                      assetId: music,
                      volume: params.musicVolume,
                      duck: params.duck ? duckEnvelope(timeline) : [],
                    }
                  : undefined
              }
              playhead={playhead}
              selected={selected}
              onSelect={select}
              onMove={move}
              onTrim={trim}
            />
          </MediaReloadContext.Provider>
        </div>
      )}
    </Modal>
  )
}
