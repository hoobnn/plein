import type { Engine } from '@plein/canvas-core'
import { type CanvasElement, currentResult, setParam, setParams } from '@plein/doc'
import {
  type ArrangedClip,
  arrangeSequence,
  clipLines,
  duckEnvelope,
  type SequenceClip,
  sequenceNode,
  type SequenceParams,
  sequenceSpec,
  sequenceTimeline,
  TRANSITIONS,
} from '@plein/nodes'
import type { PortValue } from '@plein/plugin-sdk'
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react'
import { api } from '../../api/client'
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
import { Presence } from '../../ui/Presence'
import { EmptyState } from '../../ui/EmptyState'
import { Playhead } from './playhead'
import { Timeline, type TrackItem, type TrimPatch } from './Timeline'

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
  }
}

/** 序列编辑器：调整镜头顺序、入出点，指定每段的对白、音效和字幕，导出成片 */
export function SequenceEditor() {
  const engine = useCanvas((s) => s.engine)
  const id = useCanvas((s) => s.sequence)
  const close = () => useCanvas.getState().openSequence(null)
  return (
    <Presence>
      {engine && id && engine.doc.get(id) && <Editor engine={engine} id={id} onClose={close} />}
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
  const { el, params, dialogue, sfx, music } = read
  const [playhead] = useState(() => new Playhead())
  useEffect(() => () => playhead.dispose(), [playhead])
  const [selected, setSelected] = useState<string | undefined>()
  /** 检查器显示选中镜头的设置还是整部成片的设置 */
  const [tab, setTab] = useState<'clip' | 'film'>('clip')
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
    clips: rows.map((r) => (r.pending ? PENDING_LENGTH : (duration(r.clip.assetId) ?? 0))),
    dialogue: rows.map((r) => (r.dialogue ? duration(r.dialogue.assetId) : undefined)),
    more: rows.map((r) => r.more.map((m) => duration(m.assetId))),
  })
  const known = rows.every((r) => !r.pending && duration(r.clip.assetId) !== undefined)
  const total = known ? timeline.total : undefined
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
    const next = [...read.rows]
    const [r] = next.splice(from, 1)
    next.splice(to, 0, r!)
    write(settings(next))
  }
  const set = (key: keyof SequenceParams, value: unknown) => {
    setParams(engine.doc, id, { [key]: value })
    engine.doc.flush()
  }
  const trim = (key: string, p: TrimPatch, done: boolean) => {
    if (!done) return setDraft({ key, patch: p })
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
          clips: rows.map((r) => duration(r.clip.assetId) ?? 0),
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

  const items: TrackItem[] = rows.map((r, i) => {
    const t = timeline.clips[i]!
    const m = meta(r.clip.assetId)
    const own = clipLines(r)
    return {
      key: rowKey(r, i),
      index: i,
      name: r.el?.name ?? `镜头 ${i + 1}`,
      assetId: r.clip.assetId,
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
          disabled={packing || rows.length === 0 || !known}
          title={
            pending
              ? `还有 ${pending} 段镜头没有生成`
              : '导出 OTIO / FCPXML 剪辑工程（连同素材打包），在达芬奇、Final Cut 里接着剪'
          }
          onClick={() => void exportProject()}
        >
          <Icon name="exportFile" />
          {packing ? '打包中…' : '导出工程'}
        </button>
        {filmAsset && !running && (
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
          disabled={!running && (rows.length === 0 || pending > 0)}
          title={pending ? `还有 ${pending} 段镜头没有生成` : undefined}
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
              {el?.results?.length ? '重新导出' : '导出 MP4'}
            </>
          )}
        </button>
      </ModalHeader>

      {rows.length === 0 ? (
        <EmptyState
          icon="video"
          title="还没有镜头"
          hint="把视频节点的输出连到序列的「镜头」端口，配音连到「对白」，配乐连到「配乐」。"
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1">
            <SequencePreview
              rows={rows}
              timeline={timeline}
              params={params}
              music={music}
              playhead={playhead}
            />
            <aside className="seq-inspector" aria-label="剪辑设置">
              <div className="seq-tabs">
                <Segmented
                  label="设置范围"
                  value={tab}
                  options={[
                    { value: 'clip', label: '镜头' },
                    { value: 'film', label: '成片' },
                  ]}
                  onChange={setTab}
                />
              </div>
              <div
                key={tab === 'clip' ? `clip:${selected ?? ''}` : 'film'}
                className="seq-inspector-body ui-scrollbar"
              >
                {tab === 'film' ? (
                  <FilmSettings params={params} set={set} />
                ) : row ? (
                  <ClipSettings
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
          <Timeline
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
          help="导出时按识别出的语音校准字幕时间"
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
                onChange={(v) => onPatch({ in: v ?? 0 })}
              />
            </Field>
            <Field label="出点">
              <NumberField
                label="出点（秒）"
                value={row.out}
                placeholder={full === undefined ? '结尾' : full.toFixed(1)}
                max={full}
                unit="秒"
                onChange={(v) => onPatch({ out: v })}
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
          <SubtitleField
            value={row.subtitle}
            placeholder={caption ? caption : '这段没有字幕，可以在这里写'}
            onChange={(v) => onPatch({ subtitle: v })}
          />
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
          onChange={(e) => setDraft(Number(e.target.value))}
          onPointerUp={() => {
            if (draft !== null) props.onChange(draft)
            setDraft(null)
          }}
          onKeyUp={() => {
            if (draft !== null) props.onChange(draft)
            setDraft(null)
          }}
        />
        <span className="seq-volume-value">{Math.round(v * 100)}%</span>
      </span>
    </Field>
  )
}
