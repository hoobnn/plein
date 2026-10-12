import type { Engine } from '@plein/canvas-core'
import {
  type CanvasElement,
  removeEdges,
  type ResultValue,
  setParam,
  updateElement,
} from '@plein/doc'
import {
  ASSET_NODE_TYPES,
  findMentions,
  firstPlaceholder,
  mentionQuery,
  presetsFor,
  STORYBOARD_TYPE,
  slashQuery,
} from '@plein/nodes'
import type { Catalog } from '@plein/protocol'

type PromptPreset = Catalog['prompts'][number]
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { assetUrls } from '../api/client'
import {
  type FieldSchema,
  fieldsOf,
  findNode,
  isPure,
  mentionTargets,
  type NodeInfo,
  promptKey,
  targetImages,
  type Upstream,
  upstreams,
  validate,
} from '../canvas/nodes'
import { cancelNode, runNode } from '../canvas/runner'
import { shotsOf } from '../canvas/storyboard'
import { useCanvas } from '../stores/canvas'
import { useCatalog } from '../stores/catalog'
import { SchemaForm } from './SchemaForm'

const PANEL_W = 420
const GAP = 12
/** 底部工具栏占的高度，面板不压住它 */
const BOTTOM_RESERVED = 72

/** 引擎任一变化（相机、选中、文档内容）时递增，驱动面板重渲染和跟随定位 */
export function useEngineVersion(engine: Engine) {
  const ref = useRef(0)
  return useSyncExternalStore(
    (notify) => {
      const bump = () => {
        ref.current++
        notify()
      }
      const offs = [engine.onStateChange(bump), engine.onViewChange(bump)]
      const offSel = engine.selection.onChange(bump)
      return () => {
        for (const off of offs) off()
        offSel()
      }
    },
    () => ref.current,
  )
}

/** 选中单个节点时浮在它下方的生成器：主提示词、模型与常用参数、上游输入、生成 */
export function Generator() {
  const engine = useCanvas((s) => s.engine)
  if (!engine) return null
  return <GeneratorHost engine={engine} />
}

function GeneratorHost({ engine }: { engine: Engine }) {
  useEngineVersion(engine)
  const catalog = useCatalog((s) => s.catalog)
  const ids = engine.selection.values()
  const el = ids.length === 1 ? engine.scene.get(ids[0]!) : undefined
  const node = el?.kind === 'node' ? findNode(catalog, el.nodeType) : undefined
  const rect = el && engine.scene.rect(el.id)
  if (!el || !rect || !node || el.locked || engine.doc.readOnly) return null

  const tl = engine.worldToClient(rect.x, rect.y)
  const br = engine.worldToClient(rect.x + rect.w, rect.y + rect.h)
  const below = window.innerHeight - BOTTOM_RESERVED - br.y
  const above = tl.y - 16
  const left = Math.min(
    Math.max(GAP, (tl.x + br.x) / 2 - PANEL_W / 2),
    window.innerWidth - PANEL_W - GAP,
  )
  const style: React.CSSProperties =
    below >= 300 || below >= above
      ? { left, top: Math.max(GAP, br.y + GAP), maxHeight: Math.max(160, below - GAP * 2) }
      : { left, bottom: window.innerHeight - tl.y + GAP, maxHeight: Math.max(160, above - GAP) }

  return <Panel key={el.id} engine={engine} el={el} node={node} catalog={catalog} style={style} />
}

function Panel({
  engine,
  el,
  node,
  catalog,
  style,
}: {
  engine: Engine
  el: CanvasElement
  node: NodeInfo
  catalog: Catalog | null
  style: React.CSSProperties
}) {
  const [more, setMore] = useState(false)
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const params = { ...node.defaults, ...el.params }
  const set = (key: string, value: unknown) => setParam(engine.doc, el.id, key, value)
  const pk = promptKey(node)
  const fields = fieldsOf(node).filter(([, f]) => f.widget !== 'hidden')
  const main = fields.filter(([k, f]) => k !== pk && isMainField(k, f))
  const rest = Object.fromEntries(fields.filter(([k, f]) => k !== pk && !isMainField(k, f)))
  const ups = upstreams(engine, el.id, catalog)
  const presets = presetsFor(catalog?.prompts ?? [], node)
  const pure = isPure(node)
  const problem = validate(node, el, ups, catalog)
  const running = el.run?.status === 'running' || el.run?.status === 'queued'

  // 双击节点时聚焦提示词
  useEffect(() => {
    const focus = (e: Event) => {
      if ((e as CustomEvent<string>).detail === el.id) promptRef.current?.focus()
    }
    window.addEventListener('plein:focus-generator', focus)
    return () => window.removeEventListener('plein:focus-generator', focus)
  }, [el.id])

  const run = () => {
    if (running) void cancelNode(el.id)
    else if (!problem) void runNode(el.id)
  }

  return (
    <section
      aria-label={`${node.title} 生成器`}
      data-testid="generator"
      style={{ ...style, width: PANEL_W }}
      className="pointer-events-auto fixed z-20 flex flex-col overflow-y-auto rounded-2xl bg-surface/95 shadow-[var(--shadow-3)] backdrop-blur-xl"
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault()
          run()
        }
      }}
    >
      <NameField
        value={el.name ?? node.title}
        onChange={(name) => updateElement(engine.doc, el.id, { name })}
        hint={
          ASSET_NODE_TYPES.has(node.type)
            ? `在提示词里输入 @${el.name ?? node.title} 引用`
            : undefined
        }
      />
      {node.inputs.length > 0 && <Inputs engine={engine} node={node} ups={ups} />}
      {node.type === STORYBOARD_TYPE && (
        <div className="px-3 pb-3">
          <button
            type="button"
            onClick={() => useCanvas.getState().openStoryboard(el.id)}
            className="h-8 w-full rounded-lg bg-white/5 text-sm text-ink hover:bg-white/10"
          >
            编辑分镜表（{shotsOf(el).length} 个镜头）
          </button>
        </div>
      )}
      {pk && (
        <PromptBox
          ref={promptRef}
          engine={engine}
          selfId={el.id}
          value={String(params[pk] ?? '')}
          presets={presets}
          onPreset={(p) => {
            for (const [k, v] of Object.entries(p.params ?? {})) {
              if (fields.some(([f]) => f === k)) set(k, v)
            }
          }}
          placeholder={
            fields.find(([k]) => k === pk)?.[1].placeholder ??
            (pure
              ? '写下文本'
              : `描述你想生成的内容，输入 @ 引用角色或场景${presets.length ? '，行首输入 / 选预设' : ''}`)
          }
          onChange={(v) => set(pk, v)}
        />
      )}
      {(!pure || Object.keys(rest).length > 0) && (
        <div className="flex flex-wrap items-center gap-1.5 px-3 pb-3">
          {main.map(([key, f]) => (
            <Compact
              key={key}
              name={key}
              field={f}
              value={params[key]}
              node={node}
              catalog={catalog}
              onChange={(v) => set(key, v)}
            />
          ))}
          {Object.keys(rest).length > 0 && (
            <button
              type="button"
              onClick={() => setMore(!more)}
              className="h-8 rounded-lg px-2 text-xs text-ink-muted hover:bg-white/5 hover:text-ink"
              aria-expanded={more}
            >
              {more ? '收起' : '更多参数'}
            </button>
          )}
          {!pure && (
            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                onClick={run}
                disabled={!running && !!problem}
                title={problem ?? '⌘↵'}
                className={`h-8 rounded-lg px-4 text-sm font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40 ${
                  running
                    ? 'bg-white/10 text-ink hover:bg-white/15'
                    : 'bg-accent text-[#18181b] hover:bg-[#f3e4ca]'
                }`}
              >
                {running ? '取消' : el.results?.length ? '重新生成' : '生成'}
              </button>
            </div>
          )}
        </div>
      )}
      {more && (
        <div className="border-t border-line px-3 py-3">
          <SchemaForm
            schema={{ properties: rest }}
            value={params}
            onChange={(next) => {
              for (const k of Object.keys(rest)) if (next[k] !== params[k]) set(k, next[k])
            }}
          />
        </div>
      )}
      {!pure && (problem || el.run?.status === 'failed') && !running && (
        <p
          className={`border-t border-line px-3 py-2 text-xs ${problem ? 'text-ink-muted' : 'text-[#ff8a8a]'}`}
        >
          {problem ?? el.run?.error ?? '生成失败'}
        </p>
      )}
    </section>
  )
}

/** 节点名：资产卡靠它被 @ 引用；失焦或回车时写入文档 */
function NameField({
  value,
  hint,
  onChange,
}: {
  value: string
  hint?: string
  onChange(v: string): void
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = () => {
    const v = draft.trim()
    if (v && v !== value) onChange(v)
    else setDraft(value)
  }
  return (
    <div className="flex items-center gap-2 border-b border-line px-4 py-2">
      <input
        aria-label="节点名称"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
        }}
        className="min-w-0 flex-1 bg-transparent text-sm font-medium text-ink outline-none"
      />
      {hint && <span className="flex-none text-xs text-ink-muted">{hint}</span>}
    </div>
  )
}

/** 模型、枚举和小范围整数放进紧凑行，其余进“更多参数” */
function isMainField(key: string, f: FieldSchema) {
  if (f.widget === 'model' || f.enum) return true
  return f.type === 'integer' && (key === 'count' || key === 'duration')
}

const chip =
  'h-8 rounded-lg bg-surface-2 px-2 text-xs text-ink outline-none ring-1 ring-line hover:ring-white/20 focus:ring-accent/60'

function Compact({
  name,
  field,
  value,
  node,
  catalog,
  onChange,
}: {
  name: string
  field: FieldSchema
  value: unknown
  node: NodeInfo
  catalog: Catalog | null
  onChange(v: unknown): void
}) {
  const label = field.title ?? name
  if (field.widget === 'model') {
    const models = (catalog?.providers ?? [])
      .filter((p) => p.enabled && p.configured)
      .flatMap((p) =>
        p.models
          .filter((m) => !node.capability || m.capabilities.includes(node.capability))
          .map((m) => ({ ref: `${p.id}:${m.id}`, title: m.title, provider: p.title })),
      )
    return (
      <select
        aria-label={label}
        className={`${chip} max-w-44`}
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">自动选择模型</option>
        {models.map((m) => (
          <option key={m.ref} value={m.ref}>
            {m.title} · {m.provider}
          </option>
        ))}
      </select>
    )
  }
  if (field.enum) {
    return (
      <select
        aria-label={label}
        className={chip}
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value)}
      >
        {field.enum.map((o) => (
          <option key={String(o)} value={String(o)}>
            {String(o)}
          </option>
        ))}
      </select>
    )
  }
  const min = field.minimum ?? 1
  const max = field.maximum ?? min + 9
  if (max - min <= 9) {
    return (
      <select
        aria-label={label}
        className={chip}
        value={String(value ?? min)}
        onChange={(e) => onChange(Number(e.target.value))}
      >
        {Array.from({ length: max - min + 1 }, (_, i) => min + i).map((n) => (
          <option key={n} value={n}>
            {name === 'count' ? `${n} 个` : `${label} ${n}`}
          </option>
        ))}
      </select>
    )
  }
  return (
    <label className={`${chip} flex items-center gap-1`}>
      <input
        aria-label={label}
        type="number"
        min={min}
        max={max}
        className="w-10 bg-transparent text-right outline-none"
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
      />
      <span className="text-ink-muted">{name === 'duration' ? '秒' : label}</span>
    </label>
  )
}

/**
 * 主提示词：本地草稿保证输入流畅，每次修改立即写入文档（协作端实时可见）；
 * 未聚焦时跟随文档，其他人改了能看到。
 * 输入 @ 弹出画布上的角色、场景和有名字的图片，选中后插入 `@名字`。
 */
function PromptBox({
  ref,
  engine,
  selfId,
  value,
  presets,
  placeholder,
  onChange,
  onPreset,
}: {
  ref: React.RefObject<HTMLTextAreaElement | null>
  engine: Engine
  selfId: string
  value: string
  presets: PromptPreset[]
  placeholder: string
  onChange(v: string): void
  onPreset(p: PromptPreset): void
}) {
  const [draft, setDraft] = useState(value)
  const [focused, setFocused] = useState(false)
  // 正在输入的 @ 引用或行首 / 预设
  const [query, setQuery] = useState<{ kind: '@' | '/'; start: number; query: string } | null>(null)
  const [active, setActive] = useState(0)
  const shown = focused ? draft : value
  const targets = mentionTargets(engine)
  targets.forEach((t, name) => {
    if (t.id === selfId) targets.delete(name)
  })
  const q = query?.query.toLowerCase() ?? ''
  const mentionOptions =
    query?.kind === '@'
      ? [...targets].filter(([name]) => name.toLowerCase().includes(q)).slice(0, 8)
      : []
  const presetOptions =
    query?.kind === '/'
      ? presets
          .filter((p) => p.title.toLowerCase().includes(q) || p.id.toLowerCase().includes(q))
          .slice(0, 8)
      : []
  const count = mentionOptions.length + presetOptions.length
  const mentions = findMentions(shown, targets)

  const detect = (text: string, caret: number) => {
    const slash = presets.length ? slashQuery(text, caret) : null
    if (slash) return { kind: '/' as const, ...slash }
    const at = mentionQuery(text, caret)
    return at && { kind: '@' as const, ...at }
  }
  const update = (text: string, caret: number) => {
    setDraft(text)
    onChange(text)
    setQuery(detect(text, caret))
    setActive(0)
  }
  /** 把正在输入的查询换成 replacement，然后选中 [selStart, selEnd)（相对替换起点） */
  const replaceQuery = (replacement: string, sel: (inserted: string) => [number, number]) => {
    if (!query) return
    const caret = query.start + 1 + query.query.length
    const text = `${shown.slice(0, query.start)}${replacement}${shown.slice(caret)}`
    update(text, -1)
    setQuery(null)
    const [a, b] = sel(replacement).map((n) => query.start + n)
    requestAnimationFrame(() => {
      ref.current?.focus()
      ref.current?.setSelectionRange(a!, b!)
    })
  }
  const insert = (name: string) => replaceQuery(`@${name} `, (r) => [r.length, r.length])
  const applyPreset = (p: PromptPreset) => {
    onPreset(p)
    // 选中第一个【占位】，直接打字替换
    replaceQuery(p.template, (r) => {
      const hole = firstPlaceholder(r)
      return hole ? [hole.start, hole.end] : [r.length, r.length]
    })
  }
  const pick = (i: number) => {
    if (query?.kind === '/') applyPreset(presetOptions[i]!)
    else insert(mentionOptions[i]![0])
  }

  return (
    <div className="relative">
      <textarea
        ref={ref}
        aria-label="提示词"
        value={shown}
        placeholder={placeholder}
        rows={3}
        onFocus={() => {
          setDraft(value)
          setFocused(true)
        }}
        onBlur={() => {
          setFocused(false)
          // 让候选项的点击先生效
          setTimeout(() => setQuery(null), 150)
        }}
        onChange={(e) => update(e.target.value, e.target.selectionStart)}
        onKeyDown={(e) => {
          if (!count) return
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            const d = e.key === 'ArrowDown' ? 1 : -1
            setActive((a) => (a + d + count) % count)
          } else if ((e.key === 'Enter' && !e.metaKey && !e.ctrlKey) || e.key === 'Tab') {
            e.preventDefault()
            pick(active)
          } else if (e.key === 'Escape') {
            e.stopPropagation()
            setQuery(null)
          }
        }}
        className="field-sizing-content max-h-60 min-h-20 w-full resize-none bg-transparent px-4 py-3 text-sm leading-relaxed text-ink outline-none placeholder:text-ink-muted"
      />
      {mentions.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 px-4 pb-2 text-xs text-ink-muted">
          引用
          {[...new Map(mentions.map((m) => [m.name, m.target])).entries()].map(([name, t]) => (
            <MentionChip key={name} engine={engine} name={name} target={t} />
          ))}
        </div>
      )}
      {presetOptions.length > 0 && (
        <div
          role="listbox"
          aria-label="提示词预设"
          className="absolute left-3 top-full z-10 mt-1 w-72 rounded-xl bg-surface p-1 shadow-[var(--shadow-3)]"
        >
          {presetOptions.map((p, i) => (
            <button
              key={p.id}
              type="button"
              role="option"
              aria-selected={i === active}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => applyPreset(p)}
              onPointerEnter={() => setActive(i)}
              className={`flex w-full flex-col rounded-lg px-2 py-1.5 text-left ${i === active ? 'bg-white/8' : ''}`}
            >
              <span className="text-sm">{p.title}</span>
              {p.description && (
                <span className="truncate text-xs text-ink-muted">{p.description}</span>
              )}
            </button>
          ))}
        </div>
      )}
      {mentionOptions.length > 0 && (
        <div
          role="listbox"
          aria-label="引用资产"
          className="absolute left-3 top-full z-10 mt-1 w-64 rounded-xl bg-surface p-1 shadow-[var(--shadow-3)]"
        >
          {mentionOptions.map(([name, t], i) => (
            <button
              key={name}
              type="button"
              role="option"
              aria-selected={i === active}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => insert(name)}
              onPointerEnter={() => setActive(i)}
              className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm ${i === active ? 'bg-white/8' : ''}`}
            >
              <Thumb engine={engine} target={t} />
              <span className="truncate">{name}</span>
              <span className="ml-auto text-xs text-ink-muted">{targetKind(t)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function targetKind(t: CanvasElement) {
  if (t.nodeType === 'plein/character') return '角色'
  if (t.nodeType === 'plein/scene') return '场景'
  return '图片'
}

function Thumb({ engine, target }: { engine: Engine; target: CanvasElement }) {
  const id = targetImages(engine, target)[0]
  return id ? (
    <img
      src={assetUrls.variant(id, 'thumb-256')}
      alt=""
      className="size-6 flex-none rounded object-cover"
    />
  ) : (
    <span className="size-6 flex-none rounded bg-surface-2" />
  )
}

function MentionChip({
  engine,
  name,
  target,
}: {
  engine: Engine
  name: string
  target: CanvasElement
}) {
  return (
    <button
      type="button"
      title={`定位到「${name}」`}
      onClick={() => {
        engine.selection.set([target.id])
        engine.zoomToFit([target.id])
      }}
      className="flex h-7 items-center gap-1.5 rounded-md bg-accent/10 pl-0.5 pr-2 text-accent ring-1 ring-accent/20 hover:bg-accent/15"
    >
      <Thumb engine={engine} target={target} />
      {name}
    </button>
  )
}

/** 连入的上游：参考图缩略图、上游文本摘要；可断开 */
function Inputs({
  engine,
  node,
  ups,
}: {
  engine: Engine
  node: NodeInfo
  ups: Map<string, Upstream[]>
}) {
  return (
    <div className="flex flex-col gap-1.5 border-b border-line px-3 py-2.5">
      {node.inputs.map((port) => {
        const list = ups.get(port.id) ?? []
        return (
          <div key={port.id} className="flex min-h-7 items-center gap-2 text-xs">
            <span
              className={`w-12 flex-none ${port.required && list.length === 0 ? 'text-[#ff8a8a]' : 'text-ink-muted'}`}
            >
              {port.label}
            </span>
            {list.length === 0 ? (
              <span className="text-ink-muted/70">
                从左侧端口连入{port.multiple ? '，可连多个' : ''}
              </span>
            ) : (
              <div className="flex min-w-0 flex-wrap gap-1.5">
                {list.map((u) => (
                  <UpstreamChip
                    key={u.edgeId}
                    up={u}
                    onLocate={() => {
                      engine.selection.set([u.source.id])
                      engine.zoomToFit([u.source.id])
                    }}
                    onRemove={() => removeEdges(engine.doc, [u.edgeId])}
                  />
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function preview(v: ResultValue | undefined) {
  if (!v) return null
  if (v.type === 'image') return assetUrls.variant(v.assetId, 'thumb-256')
  if (v.type === 'video') return assetUrls.variant(v.assetId, 'poster')
  return null
}

function UpstreamChip({
  up,
  onLocate,
  onRemove,
}: {
  up: Upstream
  onLocate(): void
  onRemove(): void
}) {
  const v = up.value
  const img = preview(v)
  const name = up.source.name ?? '上游'
  const text =
    v?.type === 'text'
      ? v.text.trim().slice(0, 24) || '（空）'
      : v?.type === 'audio'
        ? `♪ ${name}`
        : v
          ? name
          : `${name}（未生成）`
  return (
    <span className="group flex h-7 max-w-56 items-center gap-1 rounded-md bg-surface-2 pr-1 ring-1 ring-line">
      <button
        type="button"
        onClick={onLocate}
        title={`定位到「${name}」`}
        className="flex min-w-0 items-center gap-1.5 pl-0.5 text-left"
      >
        {img ? (
          <img src={img} alt="" className="size-6 flex-none rounded object-cover" />
        ) : (
          <span className="w-1" />
        )}
        <span className={`truncate ${v ? 'text-ink' : 'text-ink-muted'}`}>{text}</span>
      </button>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`断开「${name}」`}
        className="flex size-5 flex-none items-center justify-center rounded text-ink-muted opacity-60 hover:bg-white/10 hover:text-ink group-hover:opacity-100"
      >
        ×
      </button>
    </span>
  )
}
