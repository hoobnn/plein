import type { Engine } from '@plein/canvas-core'
import { type CanvasElement, currentResult, setParam, setParams } from '@plein/doc'
import {
  type ArrangedClip,
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
  type SequenceParams,
  sequenceSpec,
  sequenceTimeline,
  subtitleExportProblem,
  subtitleInputKey,
  TRANSITIONS,
} from '@plein/nodes'
import type { PortValue } from '@plein/plugin-sdk'
import type { RecoverJobOptions, SubtitleRecognitionInfo } from '@plein/protocol'
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { flushSync } from 'react-dom'
import { ApiError, api } from '../../api/client'
import { downloadAsset } from '../../canvas/grid'
import { useDocVersion } from '../../canvas/hooks'
import { desktop } from '../../desktop'
import { findNode, upstreams } from '../../canvas/nodes'
import { cancelNode, runNode } from '../runs/run'
import { useAssetMetas } from '../../stores/assetMeta'
import { useCanvas } from '../../stores/canvas'
import { useCatalog } from '../../stores/catalog'
import { Icon } from '../../ui/icons'
import { Modal, ModalHeader } from '../../ui/Modal'
import { Segmented } from '../../ui/Segmented'
import { Select } from '../../ui/Select'
import { Switch } from '../../ui/Switch'
import { ModelPicker } from '../generator/ModelPicker'
import { SequencePreview } from './SequencePreview'
import { Presence, useClosing } from '../../ui/Presence'
import { EmptyState } from '../../ui/EmptyState'
import { Playhead } from './playhead'
import { Timeline, type TrackItem, type TrimPatch } from './Timeline'
import { SubtitleEditor } from './SubtitleEditor'
import { refreshAnimatic, relatedSequence } from './animatic'
import { DeliveryReview } from './DeliveryReview'
import { MediaReloadContext } from './media'

const seconds = (s: number | undefined) => (s === undefined ? '—' : `${s.toFixed(1)} 秒`)

interface Row extends ArrangedClip {
  el?: CanvasElement
  /** 上游还没有结果 */
  pending: boolean
}

/** 从画布连线读出各端口的值，交给与服务端相同的 arrangeSequence 排序；没结果的上游先占位 */
function readSequence(engine: Engine, id: string) {
  const catalog = useCatalog.getState().catalog
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
      animatic: params,
    }
  }
  const params = sequenceNode.params.parse(el?.params ?? {}) as SequenceParams
  const ups = upstreams(engine, id, catalog)
  const values = (port: string): PortValue[] =>
    (ups.get(port) ?? []).map((u) => {
      const v = u.value
      if (v && v.type !== 'text' && v.type !== 'json')
        return {
          type: v.type,
          assetId: v.assetId,
          kind: v.type,
          caption: v.caption,
          source: u.source.id,
        }
      return { type: 'video', assetId: '', kind: 'video', source: u.source.id }
    })
  const inputs = { clips: values('clips'), dialogue: values('dialogue'), sfx: values('sfx') }
  const named = new Map<string, CanvasElement>()
  for (const list of ups.values()) for (const u of list) named.set(u.source.id, u.source)
  const rows: Row[] = arrangeSequence(params, inputs).map((c) => ({
    ...c,
    el: c.source ? named.get(c.source) : undefined,
    pending: !c.clip.assetId,
  }))
  const options = (port: 'dialogue' | 'sfx') =>
    (ups.get(port) ?? []).map((u, i) => ({
      value: u.source.id,
      label: u.source.name ?? `${port === 'dialogue' ? '对白' : '音效'} ${i + 1}`,
      caption: u.value && 'caption' in u.value ? u.value.caption : undefined,
    }))
  const music = values('music').find((v) => 'assetId' in v && v.assetId)
  return {
    el,
    params,
    rows,
    dialogue: options('dialogue'),
    sfx: options('sfx'),
    music: music && 'assetId' in music ? music.assetId : undefined,
    animatic: undefined,
  }
}

/** 序列编辑器：调整镜头顺序、入出点，指定每段的对白、音效和字幕，导出成片 */
export function SequenceEditor() {
  const engine = useCanvas((s) => s.engine)
  const id = useCanvas((s) => s.sequence)
  const close = () => useCanvas.getState().openSequence(null)
  return (
    <Presence>
      {engine && id && engine.doc.get(id) && (
        <Editor key={id} engine={engine} id={id} onClose={close} />
      )}
    </Presence>
  )
}

/** 还没生成的镜头在时间线上先占这么长，生成后换成真实时长 */
const PENDING_LENGTH = 2
/** 方向键逐帧移动（按 30 帧） */
const FRAME = 1 / 30

const rowKey = (r: Row, i: number) => r.source ?? String(i)

/** 焦点在输入框里时，空格、方向键留给输入框 */
const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))

function Editor({ engine, id, onClose }: { engine: Engine; id: string; onClose(): void }) {
  // 协作者改了顺序也能看到
  useDocVersion(engine.doc)
  const read = readSequence(engine, id)
  const { el, params, dialogue, sfx, music, animatic } = read
  const filmSequence = animatic ? relatedSequence(engine, id) : undefined
  const [playhead] = useState(() => new Playhead())
  useEffect(() => () => playhead.dispose(), [playhead])
  const [selected, setSelected] = useState<string | undefined>()
  /** 检查器显示选中镜头的设置还是整部成片的设置 */
  const [tab, setTab] = useState<'clip' | 'film' | 'subtitles'>('clip')
  const [view, setView] = useState<'edit' | 'delivery'>('edit')
  const [previewRevision, setPreviewRevision] = useState(0)
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
  // 在时间线上点了镜头就切回镜头设置
  const select = (key: string | undefined) => {
    setSelected(key)
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
  const meta = useAssetMetas([
    ...rows.map((r) => r.clip.assetId),
    ...rows.flatMap((r) => clipLines(r).map((d) => d.assetId)),
  ])
  const duration = (assetId: string | undefined) => meta(assetId)?.duration
  const running = el?.run?.status === 'running' || el?.run?.status === 'queued'
  const pending = rows.filter((r) => r.pending).length
  // 时间线、预览和导出用同一套排法；还没生成的镜头先按固定长度占位
  const timeline = sequenceTimeline(params, rows, {
    clips: rows.map((r) =>
      animatic ? (r.out ?? 0) : r.pending ? PENDING_LENGTH : (duration(r.clip.assetId) ?? 0),
    ),
    dialogue: rows.map((r) => (r.dialogue ? duration(r.dialogue.assetId) : undefined)),
    more: rows.map((r) => r.more.map((m) => duration(m.assetId))),
  })
  const known =
    !!animatic || rows.every((r) => !r.pending && duration(r.clip.assetId) !== undefined)
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
  // 默认选中第一段；选中的镜头断开了就退回第一段
  const firstKey = rows[0] ? rowKey(rows[0], 0) : undefined
  useEffect(() => {
    if (current < 0 && firstKey) setSelected(firstKey)
  }, [current, firstKey])

  // 捕获阶段拦下按键：编辑器打开时画布的快捷键不生效；播放控制在这里处理
  const keys = useRef<(e: KeyboardEvent) => void>(() => {})
  keys.current = (e) => {
    // 输入法候选键不交给字段提交、关闭或播放快捷键；保留浏览器默认组词行为。
    if (e.isComposing || e.keyCode === 229) {
      e.stopPropagation()
      return
    }
    // 输入框里的按键照常交给输入框（回车提交、Esc 由面板关闭）；画布的快捷键本来就不管输入框
    if (typing(e.target)) return
    e.stopPropagation()
    if (e.key === 'Escape') return onClose()
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
  const settings = (list: Row[]): SequenceClip[] =>
    list.flatMap((r) => {
      if (!r.source) return []
      const old = params.clips.find((c) => c.source === r.source) ?? { source: r.source, in: 0 }
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
    setParam(
      engine.doc,
      id,
      'clips',
      clips.map((c) => Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined))),
    )
    engine.doc.flush()
  }
  const patch = (source: string | undefined, p: Partial<SequenceClip>) => {
    if (!source) return
    write(settings(read.rows).map((c) => (c.source === source ? { ...c, ...p } : c)))
  }
  const move = (from: number, to: number) => {
    if (to < 0 || to >= rows.length || from === to) return
    if (animatic) {
      const next = [...animatic.shots]
      const [shot] = next.splice(from, 1)
      next.splice(to, 0, shot!)
      setParam(engine.doc, id, 'shots', next)
      engine.doc.flush()
      return
    }
    const next = [...read.rows]
    const [r] = next.splice(from, 1)
    next.splice(to, 0, r!)
    write(settings(next))
  }
  const set = (key: keyof SequenceParams, value: unknown) => {
    setParams(engine.doc, id, { [key]: value })
    engine.doc.flush()
  }
  const subtitleDurations = () => ({
    clips: read.rows.map((r) => (animatic ? (r.out ?? 0) : (duration(r.clip.assetId) ?? 0))),
    dialogue: read.rows.map((r) => (r.dialogue ? duration(r.dialogue.assetId) : undefined)),
    more: read.rows.map((r) => r.more.map((m) => duration(m.assetId))),
  })
  const buildSubtitles = () => {
    const next = { ...params, asrTiming: false }
    setParams(engine.doc, id, {
      asrTiming: false,
      subtitleTrack: createSubtitleTrack(next, read.rows, subtitleDurations()),
    })
    engine.doc.flush()
    setSubtitleError(null)
  }
  const recognizeSubtitles = async () => {
    if (recognizing || !subtitleKnown) return
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
    setRecognizing(true)
    subtitleStateRevision.current++
    setSubtitleRecovery(null)
    setSubtitleError(null)
    try {
      const { transcripts } = await api.subtitleRecognize({ model: params.model, assetIds })
      const latest = readSequence(engine, id)
      if (
        !engine.doc.get(id) ||
        engine.doc.readOnly ||
        latest.params.asrTiming !== params.asrTiming ||
        subtitleInputKey({ ...latest.params, asrTiming: true }, latest.rows) !== inputKey ||
        JSON.stringify(latest.params.subtitleTrack) !== originalTrack
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
      setSubtitleError((error as Error).message)
      if (error instanceof ApiError)
        setSubtitleRecovery(
          (error.body as { recovery?: SubtitleRecognitionInfo | null })?.recovery ?? null,
        )
    } finally {
      setRecognizing(false)
    }
  }
  const recoverSubtitles = async (operation: RecoverJobOptions, confirmedNotAccepted = false) => {
    if (!subtitleRecovery || recognizing) return
    const inputKey = subtitleInputKey(params, read.rows)
    setRecognizing(true)
    subtitleStateRevision.current++
    try {
      await api.subtitleRecover({
        model: subtitleRecovery.model,
        assetId: subtitleRecovery.assetId,
        expected: subtitleRecovery.expected,
        operation,
        confirmedNotAccepted,
      })
      setSubtitleRecovery(null)
      const latest = readSequence(engine, id)
      if (subtitleInputKey(latest.params, latest.rows) !== inputKey) {
        setSubtitleError('素材在恢复期间已变化，恢复记录已保存，请重新检查字幕后再识别')
        return
      }
      await recognizeSubtitles()
    } catch (error) {
      setSubtitleError((error as Error).message)
    } finally {
      setRecognizing(false)
    }
  }
  const trim = (key: string, p: TrimPatch, done: boolean) => {
    if (!done) return setDraft('in' in p || 'out' in p ? { key, patch: p } : null)
    setDraft(null)
    const r = read.rows.find((x, i) => rowKey(x, i) === key)
    patch(r?.source, p)
  }

  /** 导出剪辑工程：和成片同一套合成参数，服务端打包成 OTIO / FCPXML + 素材的 zip */
  const [packing, setPacking] = useState(false)
  const [packError, setPackError] = useState<string | null>(null)
  const exportProject = async () => {
    setPacking(true)
    setPackError(null)
    try {
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
      )
      const { url } = await api.sequenceExport({ spec })
      const a = document.createElement('a')
      a.href = url
      a.download = `${(el?.name ?? '序列').replace(/[\\/:*?"<>|]/g, '_')}.zip`
      document.body.appendChild(a)
      a.click()
      a.remove()
    } catch (err) {
      setPackError((err as Error).message || '导出工程失败')
    } finally {
      setPacking(false)
    }
  }

  const exportVideo = () => {
    if (running) void cancelNode(id)
    else void runNode(id)
  }
  const progress = el?.run?.status === 'running' ? el.run.progress : undefined
  const film = el && currentResult(el)?.value
  const filmAsset = film && film.type === 'video' ? film.assetId : undefined
  const subtitleProblem = subtitleExportProblem(params, read.rows)

  const items: TrackItem[] = rows.map((r, i) => {
    const t = timeline.clips[i]!
    const m = meta(r.clip.assetId)
    const own = clipLines(r)
    return {
      key: rowKey(r, i),
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
    <Modal label="序列" onClose={onClose} className="h-full max-w-7xl">
      <ModalHeader
        title={el?.name ?? '序列'}
        onClose={onClose}
        meta={
          <span className="ui-chip tabular-nums">
            {rows.length} 段{total !== undefined && ` · ${total.toFixed(1)} 秒`}
          </span>
        }
      >
        {view === 'edit' && (
          <button
            type="button"
            className="ui-btn ui-btn-quiet"
            title="重新加载画面、缩略图和波形，保留剪辑设置与播放位置"
            onClick={() => {
              playhead.pause()
              setPreviewRevision((revision) => revision + 1)
            }}
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
              onClick={() => refreshAnimatic(engine, id)}
            >
              更新已有素材
            </button>
            {filmSequence && (
              <button
                className="ui-btn ui-btn-quiet"
                type="button"
                onClick={() => useCanvas.getState().openSequence(filmSequence)}
              >
                切回成片
              </button>
            )}
          </>
        )}
        {el?.run?.status === 'failed' && !running && (
          <span className="max-w-80 truncate text-xs text-danger" title={el.run.error}>
            {el.run.error ?? '导出失败'}
          </span>
        )}
        {packError && (
          <span className="max-w-80 truncate text-xs text-danger" title={packError}>
            {packError}
          </span>
        )}
        <button
          type="button"
          className="ui-btn ui-btn-quiet"
          disabled={
            packing ||
            rows.length === 0 ||
            !known ||
            !!subtitleProblem ||
            (!!animatic && pending > 0)
          }
          title={
            pending
              ? animatic
                ? `缺少 ${pending} 张分镜图；样片 MP4 可用占位，工程导出需要补齐素材`
                : `还有 ${pending} 段镜头没有生成`
              : (subtitleProblem ??
                '导出 OTIO / FCPXML 剪辑工程（连同素材打包），在达芬奇、Final Cut 里接着剪')
          }
          onClick={() => void exportProject()}
        >
          <Icon name="exportFile" />
          {packing ? '打包中…' : '导出工程'}
        </button>
        {filmAsset && !running && view === 'edit' && (
          <button
            type="button"
            className="ui-btn ui-btn-quiet"
            title="把导出的成片保存到电脑上"
            onClick={() => downloadAsset(filmAsset, `${el?.name ?? '成片'}.mp4`)}
          >
            {desktop ? '另存为…' : '下载成片'}
          </button>
        )}
        <span aria-hidden="true" className="ui-bar-sep" />
        <button
          type="button"
          className={running ? 'ui-btn ui-btn-secondary' : 'ui-btn ui-btn-primary'}
          disabled={
            !running && (rows.length === 0 || (!animatic && pending > 0) || !!subtitleProblem)
          }
          title={
            animatic
              ? (subtitleProblem ?? '仅本地合成草稿；不生成视频、配音或自动识别字幕')
              : pending
                ? `还有 ${pending} 段镜头没有生成`
                : subtitleProblem
          }
          onClick={exportVideo}
        >
          {running ? (
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
      {animatic && (
        <p className="px-4 text-xs text-muted">
          仅使用创建或更新时已有的分镜图、配音。调整时长与对白节奏只改变样片；原生成结果保留。
          {pending > 0 && ` ${pending} 镜缺图，将显示占位。`}
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
      {view === 'delivery' && el ? (
        <DeliveryReview engine={engine} node={el} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon="video"
          title="还没有镜头"
          hint="把视频节点的输出连到序列的「镜头」端口，配音连到「对白」，配乐连到「配乐」。"
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1">
            <SequencePreview
              key={previewRevision}
              rows={rows}
              timeline={timeline}
              params={params}
              music={music}
              playhead={playhead}
              draft={!!animatic}
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
                  ]}
                  onChange={setTab}
                />
              </div>
              <div
                key={tab === 'clip' ? `clip:${selected ?? ''}` : 'film'}
                className="seq-inspector-body ui-scrollbar"
              >
                {tab === 'subtitles' ? (
                  <SubtitleEditor
                    params={params}
                    rows={read.rows}
                    busy={recognizing || !subtitleKnown}
                    error={subtitleError}
                    onBuild={buildSubtitles}
                    onRecognize={() => void recognizeSubtitles()}
                    onChange={(track) => set('subtitleTrack', track)}
                    onModelChange={(model) => set('model', model)}
                    recovery={subtitleRecovery}
                    onRecover={(operation, confirmed) =>
                      void recoverSubtitles(operation, confirmed)
                    }
                  />
                ) : tab === 'film' ? (
                  <FilmSettings params={params} set={set} />
                ) : row && animatic ? (
                  <AnimaticSettings
                    shot={animatic.shots[current]!}
                    index={current}
                    count={rows.length}
                    onMove={(to) => move(current, to)}
                    onChange={(patch) => {
                      setParam(
                        engine.doc,
                        id,
                        'shots',
                        animatic.shots.map((s) =>
                          s.shotId === row.source ? { ...s, ...patch } : s,
                        ),
                      )
                      engine.doc.flush()
                    }}
                  />
                ) : row ? (
                  <ClipSettings
                    key={rowKey(row, current)}
                    row={row}
                    index={current}
                    count={rows.length}
                    full={duration(row.clip.assetId)}
                    length={timeline.clips[current]?.length}
                    params={params}
                    dialogue={dialogue}
                    sfx={sfx}
                    onMove={(to) => move(current, to)}
                    onPatch={(p) => patch(row.source, p)}
                  />
                ) : (
                  <p className="ui-help">在时间线上点一段镜头，在这里调整它。</p>
                )}
              </div>
            </aside>
          </div>
          <MediaReloadContext.Provider value={previewRevision}>
            <Timeline
              onBeforeInteract={() => {
                const active = document.activeElement
                if (active instanceof HTMLElement && active.closest('.seq-inspector'))
                  // 先提交字段并重算时间线，再处理选择／拖动，避免丢草稿或沿用旧起点。
                  flushSync(() => active.blur())
              }}
              items={items}
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

/** 检查器里的一组设置：小标题加若干行 */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="seq-section">
      <h3 className="ui-section-title">{title}</h3>
      {children}
    </section>
  )
}

/** 一行设置：左边固定宽的名字，右边控件铺满 */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="seq-field">
      <span className="seq-field-label">{label}</span>
      <div className="seq-field-control">{children}</div>
    </div>
  )
}

/** 开关行：名字和说明在左，开关在右，整行可点 */
function SwitchRow(props: {
  label: string
  help?: string
  checked: boolean
  disabled?: boolean
  onChange(v: boolean): void
}) {
  return (
    <div className="seq-switch-row" data-disabled={props.disabled || undefined}>
      <div className="min-w-0">
        <div className="text-sm text-ink">{props.label}</div>
        {props.help && <div className="ui-help">{props.help}</div>}
      </div>
      <Switch
        label={props.label}
        checked={props.checked}
        disabled={props.disabled}
        onChange={props.onChange}
      />
    </div>
  )
}

/** 等分分段：选项少的参数（画幅、分辨率、字幕样式），选中底色滑过去 */
function SegBlock<T extends string>(props: {
  label: string
  options: ReadonlyArray<{ value: T; label: string }>
  value: T
  onChange(v: T): void
}) {
  const i = props.options.findIndex((o) => o.value === props.value)
  return (
    <fieldset
      aria-label={props.label}
      className="ui-seg ui-seg-block"
      style={{ '--seg-n': props.options.length, '--seg-i': i } as CSSProperties}
    >
      {props.options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === props.value}
          className="ui-seg-item"
          onClick={() => props.onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </fieldset>
  )
}

/** 成片的设置：画面、字幕、转场、混音，对所有镜头生效 */
function FilmSettings({
  params,
  set,
}: {
  params: SequenceParams
  set(key: keyof SequenceParams, value: unknown): void
}) {
  const catalog = useCatalog((s) => s.catalog)
  const node = findNode(catalog, sequenceNode.type)
  return (
    <>
      <Section title="画面">
        <Field label="画幅">
          <SegBlock
            label="画幅"
            value={params.aspectRatio}
            options={[
              { value: '9:16', label: '竖屏 9:16' },
              { value: '16:9', label: '横屏 16:9' },
            ]}
            onChange={(v) => set('aspectRatio', v)}
          />
        </Field>
        <Field label="分辨率">
          <SegBlock
            label="分辨率"
            value={params.resolution}
            options={[
              { value: '1080p', label: '1080p' },
              { value: '720p', label: '720p' },
            ]}
            onChange={(v) => set('resolution', v)}
          />
        </Field>
      </Section>
      <Section title="字幕">
        <SwitchRow
          label="开启字幕"
          help="把台词烧进成片"
          checked={params.subtitles}
          onChange={(v) => set('subtitles', v)}
        />
        {params.subtitles && (
          <Field label="样式">
            <SegBlock
              label="字幕样式"
              value={params.subtitleStyle}
              options={[
                { value: '常规', label: '常规' },
                { value: '醒目', label: '醒目' },
                { value: '底框', label: '底框' },
              ]}
              onChange={(v) => set('subtitleStyle', v)}
            />
          </Field>
        )}
        <SwitchRow
          label="按语音识别对齐字幕"
          help="先在字幕页显式识别全部对白，检查后再导出；导出不会自动调用识别"
          checked={params.asrTiming}
          disabled={!params.subtitles}
          onChange={(v) => set('asrTiming', v)}
        />
        {params.subtitles && params.asrTiming && node && (
          <Field label="语音识别模型">
            <ModelPicker
              value={params.model}
              node={{ ...node, capability: 'audio.transcribe' }}
              catalog={catalog}
              onChange={(v) => set('model', v)}
            />
          </Field>
        )}
      </Section>
      <Section title="转场">
        <Field label="默认">
          <Select
            aria-label="转场"
            className="ui-input w-full"
            value={params.transition}
            options={TRANSITIONS.map((value) => ({ value }))}
            onChange={(v) => set('transition', v)}
          />
        </Field>
        {params.transition !== '无' && (
          <Field label="时长">
            <NumberField
              label="转场时长（秒）"
              value={params.transitionDuration}
              max={2}
              unit="秒"
              onChange={(v) => set('transitionDuration', Math.max(0.2, v ?? 0.5))}
            />
          </Field>
        )}
      </Section>
      <Section title="混音">
        <Volume label="原声" value={params.clipVolume} onChange={(v) => set('clipVolume', v)} />
        <Volume
          label="对白"
          value={params.dialogueVolume}
          onChange={(v) => set('dialogueVolume', v)}
        />
        <Volume label="配乐" value={params.musicVolume} onChange={(v) => set('musicVolume', v)} />
        <Volume label="音效" value={params.sfxVolume} onChange={(v) => set('sfxVolume', v)} />
        <SwitchRow
          label="对白时压低配乐"
          help="有台词的地方配乐自动降低约 10 dB"
          checked={params.duck}
          onChange={(v) => set('duck', v)}
        />
        <SwitchRow
          label="响度标准化"
          help="成片统一到 -14 LUFS，只在导出时处理"
          checked={params.loudnorm}
          onChange={(v) => set('loudnorm', v)}
        />
      </Section>
    </>
  )
}

/** 选中镜头的设置：顺序、入出点、速度、转场、声音、字幕 */
function ClipSettings({
  row,
  index,
  count,
  full,
  length,
  params,
  dialogue,
  sfx,
  onMove,
  onPatch,
}: {
  row: Row
  index: number
  count: number
  full: number | undefined
  length: number | undefined
  params: SequenceParams
  dialogue: Array<{ value: string; label: string; caption?: string }>
  sfx: Array<{ value: string; label: string }>
  onMove(to: number): void
  onPatch(p: Partial<SequenceClip>): void
}) {
  const chosen = params.clips.find((c) => c.source === row.source)
  // 同一镜头里依次播放的几句台词都列出来
  const caption =
    clipLines(row)
      .map((d) => d.caption)
      .filter(Boolean)
      .join(' / ') || undefined
  const trimmed = length !== undefined && full !== undefined && Math.abs(length - full) > 0.01
  const [trimError, setTrimError] = useState<string | null>(null)
  const changeIn = (value: number | undefined) => {
    const start = value ?? 0
    if (start >= (row.out ?? full ?? Infinity)) {
      setTrimError('入点需要早于出点，已保留原设置')
      return
    }
    setTrimError(null)
    onPatch({ in: start })
  }
  const changeOut = (value: number | undefined) => {
    if ((value ?? full ?? Infinity) <= row.in) {
      setTrimError('出点需要晚于入点，已保留原设置')
      return
    }
    setTrimError(null)
    onPatch({ out: value })
  }
  return (
    <>
      <div className="seq-clip-head">
        <span className="seq-clip-index">{String(index + 1).padStart(2, '0')}</span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{row.el?.name ?? `镜头 ${index + 1}`}</div>
          <div className="text-xs text-ink-subtle tabular-nums">
            {row.pending
              ? '还没有生成'
              : trimmed
                ? `用 ${seconds(length)}，原 ${seconds(full)}`
                : `时长 ${seconds(full)}`}
          </div>
        </div>
        <span className="flex flex-none">
          <button
            type="button"
            aria-label="前移"
            title="前移一段"
            className="ui-btn ui-btn-quiet ui-btn-sm ui-icon-btn"
            disabled={index === 0}
            onClick={() => onMove(index - 1)}
          >
            <Icon name="chevronLeft" size={14} />
          </button>
          <button
            type="button"
            aria-label="后移"
            title="后移一段"
            className="ui-btn ui-btn-quiet ui-btn-sm ui-icon-btn"
            disabled={index === count - 1}
            onClick={() => onMove(index + 1)}
          >
            <Icon name="chevronRight" size={14} />
          </button>
        </span>
      </div>
      {row.pending ? (
        <p className="ui-help">这段镜头还没有生成，生成后可以修剪和配音。</p>
      ) : (
        <>
          <Section title="剪辑">
            <Field label="入点">
              <NumberField
                label="入点（秒）"
                value={row.in}
                max={full}
                unit="秒"
                onChange={changeIn}
              />
            </Field>
            <Field label="出点">
              <NumberField
                label="出点（秒）"
                value={row.out}
                placeholder={full === undefined ? '结尾' : full.toFixed(1)}
                max={full}
                unit="秒"
                onChange={changeOut}
              />
            </Field>
            <Field label="速度">
              <Select
                aria-label="速度"
                className="ui-input w-full"
                value={String(row.speed)}
                options={SPEEDS.map((v) => ({ value: String(v), label: `${v}×` }))}
                onChange={(v) => onPatch({ speed: Number(v) === 1 ? undefined : Number(v) })}
              />
            </Field>
            {trimError && (
              <p role="alert" className="text-xs text-danger">
                {trimError}
              </p>
            )}
          </Section>
          {index > 0 && (
            <Section title="转场">
              <Field label="进入">
                <Select
                  aria-label="进入这段的转场"
                  className="ui-input w-full"
                  value={row.transition ?? AUTO}
                  options={[
                    { value: AUTO, label: `跟随成片（${params.transition}）` },
                    ...TRANSITIONS.map((value) => ({ value })),
                  ]}
                  onChange={(v) =>
                    onPatch({
                      transition: v === AUTO ? undefined : (v as SequenceClip['transition']),
                    })
                  }
                />
              </Field>
              {(row.transition ?? params.transition) !== '无' && (
                <Field label="时长">
                  <NumberField
                    label="这段转场时长（秒）"
                    value={row.transitionDuration}
                    placeholder={String(params.transitionDuration)}
                    max={2}
                    unit="秒"
                    onChange={(v) =>
                      onPatch({
                        transitionDuration: v === undefined ? undefined : Math.max(0.2, v),
                      })
                    }
                  />
                </Field>
              )}
            </Section>
          )}
        </>
      )}
      <Section title="声音">
        {!row.pending && (
          <Volume
            label="原声"
            aria="本段原声"
            value={row.volume}
            onChange={(v) => onPatch({ volume: v === 1 ? undefined : v })}
          />
        )}
        {dialogue.length > 0 && (
          <ChoiceField
            label="对白"
            options={dialogue}
            chosen={chosen?.dialogue}
            current={row.dialogue?.source}
            onChange={(v) => onPatch({ dialogue: v })}
          />
        )}
        {clipLines(row).length > 0 && (
          <Field label="台词延后">
            <NumberField
              label="台词延后（秒）"
              value={row.lineDelay || undefined}
              placeholder="0"
              max={10}
              unit="秒"
              onChange={(v) => onPatch({ lineDelay: v ? v : undefined })}
            />
          </Field>
        )}
        {sfx.length > 0 && (
          <ChoiceField
            label="音效"
            options={sfx}
            chosen={chosen?.sfx}
            current={row.sfx?.source}
            onChange={(v) => onPatch({ sfx: v })}
          />
        )}
      </Section>
      {params.subtitles && (
        <Section title="字幕">
          {params.subtitleTrack ? (
            <p className="ui-help">已使用可编辑字幕轨，请切到「字幕」逐句调整文字与时间。</p>
          ) : (
            <SubtitleField
              value={row.subtitle}
              placeholder={caption ? caption : '这段没有字幕，可以在这里写'}
              onChange={(v) => onPatch({ subtitle: v })}
            />
          )}
        </Section>
      )}
    </>
  )
}

/** 秒数输入：失焦或回车时写入，清空表示用默认值 */
function NumberField(props: {
  label: string
  value: number | undefined
  placeholder?: string
  max?: number
  /** 输入框里靠右的单位 */
  unit?: string
  onChange(v: number | undefined): void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    if (draft === null) return
    const n = draft.trim() === '' ? undefined : Number(draft)
    setDraft(null)
    if (n === undefined || (Number.isFinite(n) && n >= 0))
      props.onChange(n === undefined ? undefined : Math.min(n, props.max ?? n))
  }
  return (
    <span className="seq-number">
      <input
        type="number"
        aria-label={props.label}
        min={0}
        step={0.1}
        max={props.max}
        className="ui-input w-full tabular-nums"
        value={draft ?? (props.value === undefined ? '' : String(props.value))}
        placeholder={props.placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
        }}
      />
      {props.unit && <span className="seq-number-unit">{props.unit}</span>}
    </span>
  )
}

const AUTO = '__auto'
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2]
const NONE = '__none'

/** 对白 / 音效：自动（按顺序）、不配，或指定某一条 */
function ChoiceField(props: {
  label: string
  options: Array<{ value: string; label: string }>
  /** 参数里记的选择：undefined 自动，'' 不配 */
  chosen: string | undefined
  /** 实际对应到的那条 */
  current: string | undefined
  onChange(v: string | undefined): void
}) {
  const auto = props.options.find((o) => o.value === props.current)
  const value = props.chosen === undefined ? AUTO : props.chosen === '' ? NONE : props.chosen
  return (
    <Field label={props.label}>
      <Select
        aria-label={props.label}
        className="ui-input w-full"
        value={value}
        options={[
          { value: AUTO, label: auto ? `自动（${auto.label}）` : '自动（无）' },
          { value: NONE, label: '不配' },
          ...props.options,
        ]}
        onChange={(v) => props.onChange(v === AUTO ? undefined : v === NONE ? '' : v)}
      />
    </Field>
  )
}

/** 字幕：留空用对白的台词；失焦时写入 */
function SubtitleField(props: {
  value: string | undefined
  placeholder: string
  onChange(v: string | undefined): void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <input
      aria-label="字幕"
      className="ui-input w-full"
      value={draft ?? props.value ?? ''}
      placeholder={props.placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft === null) return
        const v = draft.trim()
        setDraft(null)
        props.onChange(v ? v : undefined)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
      }}
    />
  )
}

/** 音量：0–200%，松手时写入；滑轨左段按音量填色 */
function Volume(props: {
  label: string
  /** 无障碍名称，默认同 label */
  aria?: string
  value: number
  onChange(v: number): void
}) {
  const [draft, setDraft] = useState<number | null>(null)
  const pending = useRef<number | null>(null)
  const pointer = useRef<number | null>(null)
  const cancelled = useRef<number | null>(null)
  const change = useRef(props.onChange)
  change.current = props.onChange
  const closing = useClosing()
  const finish = useCallback((save: boolean) => {
    const value = pending.current
    if (!save && pointer.current !== null) cancelled.current = pointer.current
    pointer.current = null
    pending.current = null
    setDraft(null)
    if (save && value !== null) change.current(value)
  }, [])
  // 外部值更新、面板退场或卸载时，都不能把旧草稿留到下一次松手。
  useLayoutEffect(() => {
    finish(false)
    return () => finish(false)
  }, [props.value, closing, finish])
  useEffect(() => {
    const up = (e: PointerEvent) => {
      if (cancelled.current === e.pointerId) cancelled.current = null
      else if (pointer.current === e.pointerId) finish(true)
    }
    const cancel = (e: PointerEvent) => {
      if (pointer.current === e.pointerId) finish(false)
    }
    const blur = () => finish(false)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('blur', blur)
    }
  }, [finish])
  const v = draft ?? props.value
  return (
    <Field label={props.label}>
      <span className="seq-volume">
        <input
          type="range"
          aria-label={props.aria ?? props.label}
          min={0}
          max={2}
          step={0.05}
          className="seq-range"
          style={{ '--fill': `${(v / 2) * 100}%` } as CSSProperties}
          value={v}
          onPointerDown={(e) => {
            if (e.button !== 0 || closing) return
            cancelled.current = null
            pointer.current = e.pointerId
          }}
          onChange={(e) => {
            if (cancelled.current !== null || closing) {
              e.currentTarget.value = String(props.value)
              return
            }
            pending.current = Number(e.currentTarget.value)
            setDraft(pending.current)
          }}
          onKeyDown={() => {
            cancelled.current = null
          }}
          onKeyUp={() => {
            if (pointer.current === null) finish(true)
          }}
          onBlur={() => {
            finish(pointer.current === null)
          }}
        />
        <span className="seq-volume-value">{Math.round(v * 100)}%</span>
      </span>
    </Field>
  )
}

/** 必填秒数保留逐字草稿，回车／失焦后校验；不把清空过程当作 0。 */
function RequiredSecondsField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  onChange(value: number): void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pending = useRef<string | null>(null)
  const errorId = useId()
  const closing = useClosing()
  useLayoutEffect(() => {
    pending.current = null
    setDraft(null)
    setError(null)
    return () => {
      pending.current = null
    }
  }, [value, closing])
  const commit = () => {
    const raw = pending.current
    pending.current = null
    setDraft(null)
    if (raw === null || closing) return
    const next = raw.trim() === '' ? NaN : Number(raw)
    if (!Number.isFinite(next) || next < min || next > max) {
      setError(`请输入 ${min}–${max} 秒，已保留原设置`)
      return
    }
    setError(null)
    if (next !== value) onChange(next)
  }
  return (
    <label className="block space-y-1 text-xs">
      <span>{label}</span>
      <input
        aria-label={label}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className="ui-input w-full"
        type="number"
        required
        min={min}
        max={max}
        step="0.1"
        value={draft ?? value}
        onChange={(e) => {
          pending.current = e.currentTarget.value
          setDraft(pending.current)
          setError(null)
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            e.currentTarget.blur()
          } else if (e.key === 'Escape') {
            pending.current = null
            setDraft(null)
          }
        }}
      />
      {error && (
        <span id={errorId} role="alert" className="block text-danger">
          {error}
        </span>
      )}
    </label>
  )
}

function AnimaticSettings({
  shot,
  index,
  count,
  onMove,
  onChange,
}: {
  shot: AnimaticShot
  index: number
  count: number
  onMove(to: number): void
  onChange(patch: Partial<AnimaticShot>): void
}) {
  return (
    <div className="space-y-4">
      <p className="ui-help">
        样片镜头 {index + 1} · {shot.dialogue.length} 句已有配音
      </p>
      {(
        [
          ['duration', '样片镜头时长（秒）', 0.2, 300],
          ['lineDelay', '对白起始延迟（秒）', 0, 30],
          ['lineGap', '对白句间停顿（秒）', 0, 10],
        ] as const
      ).map(([key, label, min, max]) => (
        <RequiredSecondsField
          key={key}
          label={label}
          value={shot[key]}
          min={min}
          max={max}
          onChange={(value) => onChange({ [key]: value })}
        />
      ))}
      <p className="ui-help">超出镜头时长的对白会按镜头边界裁切，请在预览中检查节奏。</p>
      <div className="flex gap-2">
        <button
          type="button"
          className="ui-btn ui-btn-quiet"
          disabled={index === 0}
          onClick={() => onMove(index - 1)}
        >
          前移
        </button>
        <button
          type="button"
          className="ui-btn ui-btn-quiet"
          disabled={index === count - 1}
          onClick={() => onMove(index + 1)}
        >
          后移
        </button>
      </div>
    </div>
  )
}
