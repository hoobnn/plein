import type { Engine } from '@plein/canvas-core'
import { type CanvasElement, setParam, setParams } from '@plein/doc'
import {
  type ArrangedClip,
  arrangeSequence,
  clipLength,
  type SequenceClip,
  sequenceNode,
  type SequenceParams,
} from '@plein/nodes'
import type { PortValue } from '@plein/plugin-sdk'
import { useEffect, useState } from 'react'
import { api, assetUrls } from '../api/client'
import { upstreams } from '../canvas/nodes'
import { cancelNode, runNode } from '../canvas/runner'
import { useCanvas } from '../stores/canvas'
import { useCatalog } from '../stores/catalog'
import { Icon } from '../ui/icons'
import { Select } from '../ui/Select'

/** 文档变化时重渲染（协作者改了顺序也能看到） */
function useDocVersion(engine: Engine) {
  const [v, setV] = useState(0)
  useEffect(() => engine.onViewChange(() => setV((x) => x + 1)), [engine])
  return v
}

/** 素材时长（秒），按资产 id 缓存 */
const durations = new Map<string, number | undefined>()
function useDurations(ids: string[]) {
  const [, setV] = useState(0)
  const key = ids.join(',')
  // biome-ignore lint/correctness/useExhaustiveDependencies: key 即 ids
  useEffect(() => {
    let alive = true
    for (const id of ids) {
      if (!id || durations.has(id)) continue
      durations.set(id, undefined)
      api.assetMeta(id).then(
        (a) => {
          durations.set(id, a.duration)
          if (alive) setV((x) => x + 1)
        },
        () => durations.delete(id),
      )
    }
    return () => {
      alive = false
    }
  }, [key])
  return (id: string | undefined) => (id ? durations.get(id) : undefined)
}

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
  return { el, params, rows, dialogue: options('dialogue'), sfx: options('sfx') }
}

/** 序列编辑器：调整镜头顺序、入出点，指定每段的对白、音效和字幕，导出成片 */
export function SequenceEditor() {
  const engine = useCanvas((s) => s.engine)
  const id = useCanvas((s) => s.sequence)
  const close = () => useCanvas.getState().openSequence(null)
  if (!engine || !id || !engine.doc.get(id)) return null
  return <Editor engine={engine} id={id} onClose={close} />
}

function Editor({ engine, id, onClose }: { engine: Engine; id: string; onClose(): void }) {
  useDocVersion(engine)
  const { el, params, rows, dialogue, sfx } = readSequence(engine, id)
  const [dragging, setDragging] = useState<number | null>(null)
  const duration = useDurations([
    ...rows.map((r) => r.clip.assetId),
    ...rows.flatMap((r) => (r.dialogue ? [r.dialogue.assetId] : [])),
  ])
  const running = el?.run?.status === 'running' || el?.run?.status === 'queued'
  const lengths = rows.map((r) => {
    const d = duration(r.clip.assetId)
    return d === undefined ? undefined : clipLength(r, d)
  })
  const total = lengths.every((l) => l !== undefined)
    ? lengths.reduce<number>((a, b) => a + (b ?? 0), 0)
    : undefined
  const pending = rows.filter((r) => r.pending).length

  useEffect(() => {
    // 捕获阶段拦下按键：编辑器打开时画布的快捷键不生效
    const key = (e: KeyboardEvent) => {
      e.stopPropagation()
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [onClose])

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
  const write = (clips: SequenceClip[]) =>
    setParam(
      engine.doc,
      id,
      'clips',
      clips.map((c) => Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined))),
    )
  const patch = (source: string | undefined, p: Partial<SequenceClip>) => {
    if (!source) return
    write(settings(rows).map((c) => (c.source === source ? { ...c, ...p } : c)))
  }
  const move = (from: number, to: number) => {
    if (to < 0 || to >= rows.length || from === to) return
    const next = [...rows]
    const [r] = next.splice(from, 1)
    next.splice(to, 0, r!)
    write(settings(next))
  }
  const set = (key: keyof SequenceParams, value: unknown) =>
    setParams(engine.doc, id, { [key]: value })

  const exportVideo = () => {
    if (running) void cancelNode(id)
    else void runNode(id)
  }
  const progress = el?.run?.status === 'running' ? el.run.progress : undefined

  return (
    <div
      className="ui-dialog-scrim pointer-events-auto fixed inset-0 z-40 flex items-center justify-center bg-scrim p-6"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <section
        role="dialog"
        aria-label="序列"
        className="ui-dialog flex max-h-full w-full max-w-6xl flex-col overflow-hidden rounded-2xl bg-surface shadow-[var(--shadow-4)]"
      >
        <header className="flex min-h-14 flex-wrap items-center gap-2 border-b border-line py-2.5 pl-5 pr-3">
          <h2 className="mr-1 text-lg font-semibold">{el?.name ?? '序列'}</h2>
          <span className="ui-chip">
            {rows.length} 段{total !== undefined && ` · ${total.toFixed(1)} 秒`}
          </span>
          <div className="ml-auto flex items-center gap-2">
            {el?.run?.status === 'failed' && !running && (
              <span className="max-w-80 truncate text-xs text-danger" title={el.run.error}>
                {el.run.error ?? '导出失败'}
              </span>
            )}
            <button
              type="button"
              className={running ? 'ui-btn ui-btn-secondary' : 'ui-btn ui-btn-primary'}
              disabled={!running && (rows.length === 0 || pending > 0)}
              title={pending ? `还有 ${pending} 段镜头没有生成` : undefined}
              onClick={exportVideo}
            >
              {running
                ? `导出中${progress ? ` ${Math.round(progress * 100)}%` : '…'} · 停止`
                : el?.results?.length
                  ? '重新导出'
                  : '导出 MP4'}
            </button>
            <button
              type="button"
              aria-label="关闭"
              className="ui-btn ui-btn-quiet ui-icon-btn"
              onClick={onClose}
            >
              <Icon name="x" />
            </button>
          </div>
        </header>

        {rows.length === 0 ? (
          <p className="px-6 py-16 text-center text-sm text-ink-subtle">
            还没有镜头。把视频节点的输出连到序列的「镜头」端口，配音连到「对白」，配乐连到「配乐」。
          </p>
        ) : (
          <div className="ui-scrollbar min-h-0 flex-1 overflow-auto">
            <ol className="flex flex-col">
              {rows.map((r, i) => {
                const full = duration(r.clip.assetId)
                const caption = r.dialogue?.caption
                return (
                  <li
                    key={r.source ?? i}
                    draggable
                    onDragStart={(e) => {
                      setDragging(i)
                      e.dataTransfer.effectAllowed = 'move'
                    }}
                    onDragOver={(e) => {
                      if (dragging === null) return
                      e.preventDefault()
                      e.dataTransfer.dropEffect = 'move'
                    }}
                    onDrop={(e) => {
                      e.preventDefault()
                      if (dragging !== null) move(dragging, i)
                      setDragging(null)
                    }}
                    onDragEnd={() => setDragging(null)}
                    className={`grid grid-cols-[auto_auto_minmax(0,1fr)] items-start gap-3 border-t border-line px-5 py-3 first:border-t-0 ${
                      dragging === i ? 'opacity-40' : ''
                    }`}
                  >
                    <div className="flex flex-col items-center gap-0.5 pt-1 text-ink-subtle">
                      <span className="cursor-grab" title="拖动排序">
                        <Icon name="grip" size={14} />
                      </span>
                      <span className="text-xs tabular-nums">{String(i + 1).padStart(2, '0')}</span>
                    </div>
                    <div className="relative flex aspect-video w-36 items-center justify-center overflow-hidden rounded-md bg-surface-2">
                      {r.pending ? (
                        <span className="text-xs text-ink-subtle">还没有生成</span>
                      ) : (
                        <img
                          alt=""
                          src={assetUrls.variant(r.clip.assetId, 'poster')}
                          className="h-full w-full object-cover"
                        />
                      )}
                    </div>
                    <div className="flex min-w-0 flex-col gap-2">
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 truncate text-sm font-medium">
                          {r.el?.name ?? `镜头 ${i + 1}`}
                        </span>
                        <span className="text-xs text-ink-subtle">
                          {lengths[i] !== undefined && full !== undefined && lengths[i] !== full
                            ? `${seconds(lengths[i])} / 原 ${seconds(full)}`
                            : seconds(full)}
                        </span>
                        <span className="ml-auto flex">
                          <button
                            type="button"
                            aria-label="上移"
                            className="ui-btn ui-btn-quiet ui-btn-sm ui-icon-btn"
                            disabled={i === 0}
                            onClick={() => move(i, i - 1)}
                          >
                            <Icon name="arrowUp" size={14} />
                          </button>
                          <button
                            type="button"
                            aria-label="下移"
                            className="ui-btn ui-btn-quiet ui-btn-sm ui-icon-btn"
                            disabled={i === rows.length - 1}
                            onClick={() => move(i, i + 1)}
                          >
                            <Icon name="arrowDown" size={14} />
                          </button>
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-ink-muted">
                        <div className="flex items-center gap-1.5">
                          入点
                          <NumberField
                            label="入点（秒）"
                            value={r.in}
                            max={full}
                            onChange={(v) => patch(r.source, { in: v ?? 0 })}
                          />
                        </div>
                        <div className="flex items-center gap-1.5">
                          出点
                          <NumberField
                            label="出点（秒）"
                            value={r.out}
                            placeholder={full === undefined ? '结尾' : full.toFixed(1)}
                            max={full}
                            onChange={(v) => patch(r.source, { out: v })}
                          />
                        </div>
                        {dialogue.length > 0 && (
                          <ChoiceField
                            label="对白"
                            options={dialogue}
                            chosen={params.clips.find((c) => c.source === r.source)?.dialogue}
                            current={r.dialogue?.source}
                            onChange={(v) => patch(r.source, { dialogue: v })}
                          />
                        )}
                        {sfx.length > 0 && (
                          <ChoiceField
                            label="音效"
                            options={sfx}
                            chosen={params.clips.find((c) => c.source === r.source)?.sfx}
                            current={r.sfx?.source}
                            onChange={(v) => patch(r.source, { sfx: v })}
                          />
                        )}
                      </div>
                      {params.subtitles && (
                        <SubtitleField
                          value={r.subtitle}
                          placeholder={caption ? caption : '这段没有字幕，可以在这里写'}
                          onChange={(v) => patch(r.source, { subtitle: v })}
                        />
                      )}
                    </div>
                  </li>
                )
              })}
            </ol>
          </div>
        )}

        <footer className="flex flex-wrap items-center gap-x-5 gap-y-3 border-t border-line px-5 py-3 text-xs text-ink-muted">
          <div className="flex items-center gap-2">
            画幅
            <Select
              aria-label="画幅"
              className="ui-input"
              value={params.aspectRatio}
              options={[
                { value: '9:16', label: '竖屏 9:16' },
                { value: '16:9', label: '横屏 16:9' },
              ]}
              onChange={(v) => set('aspectRatio', v)}
            />
          </div>
          <div className="flex items-center gap-2">
            分辨率
            <Select
              aria-label="分辨率"
              className="ui-input"
              value={params.resolution}
              options={[{ value: '1080p' }, { value: '720p' }]}
              onChange={(v) => set('resolution', v)}
            />
          </div>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={params.subtitles}
              onChange={(e) => set('subtitles', e.target.checked)}
            />
            字幕
          </label>
          {params.subtitles && (
            <Select
              aria-label="字幕样式"
              className="ui-input"
              value={params.subtitleStyle}
              options={[{ value: '常规' }, { value: '醒目' }, { value: '底框' }]}
              onChange={(v) => set('subtitleStyle', v)}
            />
          )}
          <span className="mx-1 h-4 w-px bg-line" />
          <Volume label="原声" value={params.clipVolume} onChange={(v) => set('clipVolume', v)} />
          <Volume
            label="对白"
            value={params.dialogueVolume}
            onChange={(v) => set('dialogueVolume', v)}
          />
          <Volume label="配乐" value={params.musicVolume} onChange={(v) => set('musicVolume', v)} />
          <Volume label="音效" value={params.sfxVolume} onChange={(v) => set('sfxVolume', v)} />
        </footer>
      </section>
    </div>
  )
}

/** 秒数输入：失焦或回车时写入，清空表示用默认值 */
function NumberField(props: {
  label: string
  value: number | undefined
  placeholder?: string
  max?: number
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
    <input
      type="number"
      aria-label={props.label}
      min={0}
      step={0.1}
      max={props.max}
      className="ui-input w-20 tabular-nums"
      value={draft ?? (props.value === undefined ? '' : String(props.value))}
      placeholder={props.placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
      }}
    />
  )
}

const AUTO = '__auto'
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
    <div className="flex items-center gap-1.5">
      {props.label}
      <Select
        aria-label={props.label}
        className="ui-input w-40"
        value={value}
        options={[
          { value: AUTO, label: auto ? `自动（${auto.label}）` : '自动（无）' },
          { value: NONE, label: '不配' },
          ...props.options,
        ]}
        onChange={(v) => props.onChange(v === AUTO ? undefined : v === NONE ? '' : v)}
      />
    </div>
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

function Volume(props: { label: string; value: number; onChange(v: number): void }) {
  const [draft, setDraft] = useState<number | null>(null)
  return (
    <label className="flex items-center gap-2">
      {props.label}
      <input
        type="range"
        min={0}
        max={2}
        step={0.05}
        className="w-20"
        value={draft ?? props.value}
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
      <span className="w-8 tabular-nums text-ink-subtle">
        {Math.round((draft ?? props.value) * 100)}%
      </span>
    </label>
  )
}
