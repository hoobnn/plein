import type { Engine } from '@plein/canvas-core'
import {
  type CanvasElement,
  connect,
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
  SEQUENCE_TYPE,
  STORYBOARD_TYPE,
  slashQuery,
} from '@plein/nodes'
import type { Catalog } from '@plein/protocol'

type PromptPreset = Catalog['prompts'][number]
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ApiError, api, assetUrls } from '../api/client'
import { importFiles } from '../canvas/import'
import {
  applyAspect,
  aspectKey,
  type FieldSchema,
  fieldsOf,
  findNode,
  isPure,
  mentionTargets,
  type NodeInfo,
  parseAspect,
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
import { Icon } from '../ui/icons'
import { Popover } from '../ui/Popover'
import { SchemaForm } from './SchemaForm'

const PANEL_W = 540
const GAP = 12
/** 节点标题行在卡片上方，面板放上方时让开它 */
const TITLE_H = 30
/** 面板离视口底边的最小距离；可以盖住底部工具栏（选中节点时工具栏用得少） */
const BOTTOM_RESERVED = 12
/** 顶部页头占的高度 */
const TOP_RESERVED = 64

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

/** 选中单个节点时浮在它下方的生成器：参考素材、主提示词、模型与参数、生成 */
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
  const above = tl.y - TITLE_H - TOP_RESERVED
  const left = Math.min(
    Math.max(GAP, (tl.x + br.x) / 2 - PANEL_W / 2),
    window.innerWidth - PANEL_W - GAP,
  )
  // 默认放在节点下方；下方实在放不下才放上方（让开标题行）
  const style: React.CSSProperties =
    below >= 280 || below >= above
      ? {
          left,
          top: Math.max(TOP_RESERVED, br.y + GAP),
          maxHeight: Math.max(180, below - GAP * 2),
        }
      : {
          left,
          bottom: window.innerHeight - tl.y + TITLE_H + GAP,
          maxHeight: Math.max(180, above - GAP),
        }

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
  const ak = aspectKey(node)
  const set = (key: string, value: unknown) => {
    setParam(engine.doc, el.id, key, value)
    if (key === ak) applyAspect(engine, el.id, value)
  }
  const pk = promptKey(node)
  const fields = fieldsOf(node).filter(([, f]) => f.widget !== 'hidden')
  const main = fields.filter(([k, f]) => k !== pk && isMainField(k, f))
  const rest = Object.fromEntries(fields.filter(([k, f]) => k !== pk && !isMainField(k, f)))
  const ups = upstreams(engine, el.id, catalog)
  const presets = presetsFor(catalog?.prompts ?? [], node)
  const pure = isPure(node)
  const problem = validate(node, el, ups, catalog)
  const running = el.run?.status === 'running' || el.run?.status === 'queued'
  const modelField = main.find(([, f]) => f.widget === 'model')
  // 画幅放最前：摘要读起来是“16:9 · 5s”
  const paramFields = main
    .filter(([, f]) => f.widget !== 'model')
    .sort(([a], [b]) => Number(b === ak) - Number(a === ak))

  // 双击节点、套用预设后聚焦提示词；有【占位】时选中第一个，直接打字替换
  useEffect(() => {
    const focus = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== el.id) return
      const ta = promptRef.current
      if (!ta) return
      ta.focus()
      const hole = firstPlaceholder(ta.value)
      if (hole) ta.setSelectionRange(hole.start, hole.end)
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
      className="ui-float ui-scrollbar pointer-events-auto fixed z-20 flex flex-col overflow-y-auto rounded-xl"
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault()
          run()
        }
      }}
    >
      {ASSET_NODE_TYPES.has(node.type) && (
        <NameField
          value={el.name ?? node.title}
          onChange={(name) => updateElement(engine.doc, el.id, { name })}
          hint={`在提示词里输入 @${el.name ?? node.title} 引用`}
        />
      )}
      {node.inputs.length > 0 && <Inputs engine={engine} el={el} node={node} ups={ups} />}
      {node.type === STORYBOARD_TYPE && (
        <div className="px-4 pt-4">
          <button
            type="button"
            onClick={() => useCanvas.getState().openStoryboard(el.id)}
            className="ui-btn ui-btn-secondary w-full"
          >
            编辑分镜表（{shotsOf(el).length} 个镜头）
          </button>
        </div>
      )}
      {node.type === SEQUENCE_TYPE && (
        <div className="px-4 pt-4">
          <button
            type="button"
            onClick={() => useCanvas.getState().openSequence(el.id)}
            className="ui-btn ui-btn-secondary w-full"
          >
            编辑序列（{ups.get('clips')?.length ?? 0} 段镜头）
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
              : `描述你想生成的内容，@ 引用角色或场景${presets.length ? '，行首 / 选预设' : ''}`)
          }
          onChange={(v) => set(pk, v)}
        />
      )}
      {pure && Object.keys(rest).length > 0 && (
        <div className="px-4 pb-3">
          <button
            type="button"
            onClick={() => setMore(!more)}
            className="ui-btn ui-btn-quiet ui-btn-sm -ml-2.5"
            aria-expanded={more}
          >
            {more ? '收起设置' : '更多设置'}
          </button>
          {more && (
            <div className="pt-2">
              <SchemaForm
                dense
                schema={{ properties: rest }}
                value={params}
                onChange={(next) => {
                  for (const k of Object.keys(rest)) if (next[k] !== params[k]) set(k, next[k])
                }}
              />
            </div>
          )}
        </div>
      )}
      {!pure && (
        // 底栏吸底：面板被视口截短时生成按钮仍然可见
        <footer className="sticky bottom-0 flex flex-col gap-2 bg-float px-3 pb-3 pt-1 backdrop-blur-xl">
          {(problem || (!running && el.run?.status === 'failed')) && (
            <p
              className={`px-1 text-xs ${problem ? 'text-ink-subtle' : 'text-danger'}`}
              title={problem ?? el.run?.error ?? undefined}
            >
              {problem ?? el.run?.error ?? '生成失败'}
            </p>
          )}
          <div className="flex items-center gap-1">
            {modelField && (
              <ModelPicker
                value={String(params[modelField[0]] ?? '')}
                node={node}
                catalog={catalog}
                onChange={(v) => set(modelField[0], v)}
              />
            )}
            {(paramFields.length > 0 || Object.keys(rest).length > 0) && (
              <ParamsPill
                fields={paramFields}
                rest={rest}
                params={params}
                aspect={ak}
                onChange={set}
              />
            )}
            <span className="flex-1" />
            {pk && (
              <PromptTools
                engine={engine}
                elId={el.id}
                promptKey={pk}
                text={String(params[pk] ?? '')}
                node={node}
                catalog={catalog}
              />
            )}
            <button
              type="button"
              onClick={run}
              disabled={!running && !!problem}
              title={
                problem ?? (running ? '取消' : `${el.results?.length ? '重新生成' : '生成'}（⌘↵）`)
              }
              aria-label={running ? '取消' : el.results?.length ? '重新生成' : '生成'}
              className={`ml-1 flex size-9 flex-none items-center justify-center rounded-full transition-colors duration-[var(--dur-fast)] disabled:opacity-35 ${
                running
                  ? 'bg-surface-3 text-ink hover:bg-active'
                  : 'bg-primary text-on-primary hover:bg-primary-hover disabled:hover:bg-primary'
              }`}
            >
              <Icon name={running ? 'stop' : 'arrowUp'} size={running ? 14 : 18} />
            </button>
          </div>
        </footer>
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
    <div className="flex items-center gap-2 border-b border-line px-4 py-3">
      <input
        aria-label="节点名称"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
        }}
        className="min-w-0 flex-1 rounded-sm bg-transparent text-base font-semibold text-ink outline-none"
      />
      {hint && <span className="flex-none text-xs text-ink-subtle">{hint}</span>}
    </div>
  )
}

/** 模型、枚举和小范围整数放进参数胶囊，其余进“更多参数” */
function isMainField(key: string, f: FieldSchema) {
  if (f.widget === 'model' || f.enum) return true
  return f.type === 'integer' && (key === 'count' || key === 'duration')
}

const pill =
  'flex h-8 min-w-0 items-center gap-1.5 rounded-md px-2.5 text-xs text-ink-muted transition-colors duration-[var(--dur-fast)] hover:bg-hover hover:text-ink aria-expanded:bg-active aria-expanded:text-ink'

/** 模型选择：按平台分组，每项带一句说明；“自动”交给服务端按能力挑 */
function ModelPicker({
  value,
  node,
  catalog,
  onChange,
}: {
  value: string
  node: NodeInfo
  catalog: Catalog | null
  onChange(v: string): void
}) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const providers = (catalog?.providers ?? [])
    .filter((p) => p.enabled && p.configured)
    .map((p) => ({
      ...p,
      models: p.models.filter((m) => !node.capability || m.capabilities.includes(node.capability)),
    }))
    .filter((p) => p.models.length > 0)
  const current = providers
    .flatMap((p) => p.models.map((m) => ({ ref: `${p.id}:${m.id}`, title: m.title })))
    .find((m) => m.ref === value)
  const pick = (v: string) => {
    onChange(v)
    setAnchor(null)
  }
  const Row = ({ v, title, desc }: { v: string; title: string; desc?: string }) => (
    <button
      type="button"
      role="option"
      aria-selected={v === value}
      onClick={() => pick(v)}
      className="ui-menu-item !items-start"
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
        <span className="truncate text-sm">{title}</span>
        {desc && <span className="line-clamp-2 text-xs text-ink-subtle">{desc}</span>}
      </span>
      {v === value && (
        <span className="mt-0.5 text-accent">
          <Icon name="check" size={14} />
        </span>
      )}
    </button>
  )
  return (
    <>
      <button
        type="button"
        aria-label="模型"
        aria-expanded={!!anchor}
        title={current?.title ?? '自动选择模型'}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
        className={`${pill} max-w-44 font-medium text-ink`}
      >
        <Icon name="sparkle" size={13} />
        <span className="truncate">{current?.title ?? '自动'}</span>
        <Icon name="chevronDown" size={12} />
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} label="选择模型" width={300}>
          <div role="listbox" aria-label="模型">
            <Row v="" title="自动选择" desc="按节点能力使用第一个可用的模型" />
            {providers.map((p) => (
              <div key={p.id}>
                <div className="ui-menu-label">{p.title}</div>
                {p.models.map((m) => (
                  <Row key={m.id} v={`${p.id}:${m.id}`} title={m.title} desc={m.description} />
                ))}
              </div>
            ))}
            {providers.length === 0 && (
              <p className="px-2 py-2 text-xs text-ink-subtle">
                还没有可用的模型：在设置的「模型平台」里填写密钥并启用。
              </p>
            )}
          </div>
        </Popover>
      )}
    </>
  )
}

const tool =
  'flex size-8 flex-none items-center justify-center rounded-md text-ink-muted transition-colors duration-[var(--dur-fast)] hover:bg-hover hover:text-ink aria-disabled:opacity-35 aria-disabled:hover:bg-transparent aria-disabled:hover:text-ink-muted'

/**
 * 发送按钮左侧的“优化提示词”“翻译提示词”：用已启用的对话模型改写，
 * 结果整段写回提示词，算一个撤销步；`@引用` 和【占位】由服务端原样保留。
 */
function PromptTools({
  engine,
  elId,
  promptKey: pk,
  text,
  node,
  catalog,
}: {
  engine: Engine
  elId: string
  promptKey: string
  text: string
  node: NodeInfo
  catalog: Catalog | null
}) {
  const [busy, setBusy] = useState<'optimize' | 'translate' | null>(null)
  const hasChat = (catalog?.providers ?? []).some(
    (p) => p.enabled && p.configured && p.models.some((m) => m.capabilities.includes('text.chat')),
  )
  const target =
    node.capability === 'video.generate'
      ? 'video'
      : node.capability === 'image.generate'
        ? 'image'
        : null
  const empty = !text.trim()

  const rewrite = async (mode: 'optimize' | 'translate') => {
    const { notify } = useCanvas.getState()
    if (busy) return
    if (!hasChat) return notify('没有可用的对话模型：在设置的「模型平台」里启用支持对话的平台')
    if (empty) return notify('先写提示词')
    setBusy(mode)
    try {
      const res = await api.rewritePrompt({
        text,
        mode,
        target: target ?? 'image',
        mentions: [...mentionTargets(engine).keys()],
      })
      // 等待期间提示词被改过（自己或协作者）就不覆盖
      if (String(engine.doc.get(elId)?.params?.[pk] ?? '') !== text)
        return notify('提示词已经改动，没有写回改写结果')
      engine.doc.undo.stopCapturing()
      setParam(engine.doc, elId, pk, res.text)
      engine.doc.undo.stopCapturing()
    } catch (err) {
      notify(err instanceof ApiError ? err.message : '改写失败，请重试')
    } finally {
      setBusy(null)
    }
  }

  const button = (mode: 'optimize' | 'translate', label: string, icon: 'wand' | 'languages') => {
    const disabled = !hasChat || empty || (busy !== null && busy !== mode)
    const hint = !hasChat
      ? '没有可用的对话模型：在设置的「模型平台」里启用支持对话的平台'
      : empty
        ? `先写提示词再${label}`
        : busy === mode
          ? `正在${label}…`
          : label
    return (
      <button
        type="button"
        aria-label={label}
        aria-disabled={disabled || undefined}
        aria-busy={busy === mode || undefined}
        title={hint}
        onClick={() => void rewrite(mode)}
        className={tool}
      >
        {busy === mode ? (
          <span className="plein-spinner !size-3.5" />
        ) : (
          <Icon name={icon} size={16} />
        )}
      </button>
    )
  }

  return (
    <div className="flex items-center gap-0.5">
      {target && button('optimize', '优化提示词', 'wand')}
      {button('translate', '翻译提示词', 'languages')}
    </div>
  )
}

/** 参数值的简写：画幅原样、张数“1 张”、时长“5s” */
function shortValue(key: string, f: FieldSchema, v: unknown) {
  if (v === undefined || v === '') return null
  if (key === 'count') return `${v} 张`
  if (key === 'duration') return `${v}s`
  if (f.enum) return String(v)
  return `${f.title ?? key} ${v}`
}

/** 参数胶囊：一行摘要（16:9 · 1 张 · 5s），点开是可视化的参数面板 */
function ParamsPill({
  fields,
  rest,
  params,
  aspect,
  onChange,
}: {
  fields: Array<[string, FieldSchema]>
  rest: Record<string, FieldSchema>
  params: Record<string, unknown>
  aspect?: string
  onChange(key: string, v: unknown): void
}) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const [more, setMore] = useState(false)
  const summary = fields
    .map(([k, f]) => shortValue(k, f, params[k]))
    .filter(Boolean)
    .join(' · ')
  const ratio = aspect ? parseAspect(params[aspect]) : null
  return (
    <>
      <button
        type="button"
        aria-label="参数"
        aria-expanded={!!anchor}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
        className={pill}
      >
        {ratio ? <AspectGlyph ratio={ratio} size={14} /> : <Icon name="sliders" size={13} />}
        <span className="truncate tabular-nums">{summary || '参数'}</span>
        <Icon name="chevronDown" size={12} />
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} label="参数" width={340}>
          <div className="flex flex-col gap-3 p-2">
            {fields.map(([k, f]) => (
              <ParamControl
                key={k}
                name={k}
                field={f}
                value={params[k]}
                aspect={k === aspect}
                onChange={(v) => onChange(k, v)}
              />
            ))}
            {Object.keys(rest).length > 0 && (
              <div className="border-t border-line pt-2">
                <button
                  type="button"
                  onClick={() => setMore(!more)}
                  aria-expanded={more}
                  className="flex w-full items-center justify-between text-xs text-ink-muted hover:text-ink"
                >
                  更多参数
                  <Icon name="chevronDown" size={12} />
                </button>
                {more && (
                  <div className="pt-2">
                    <SchemaForm
                      dense
                      schema={{ properties: rest }}
                      value={params}
                      onChange={(next) => {
                        for (const k of Object.keys(rest))
                          if (next[k] !== params[k]) onChange(k, next[k])
                      }}
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        </Popover>
      )}
    </>
  )
}

/** 画幅图标：按比例画的小矩形 */
function AspectGlyph({ ratio, size }: { ratio: number; size: number }) {
  const w = ratio >= 1 ? size : Math.max(4, size * ratio)
  const h = ratio >= 1 ? Math.max(4, size / ratio) : size
  return (
    <span
      className="flex flex-none items-center justify-center"
      style={{ width: size, height: size }}
    >
      <span
        className="rounded-[2px] border-[1.5px] border-current"
        style={{ width: w, height: h }}
      />
    </span>
  )
}

const seg =
  'flex h-8 flex-1 items-center justify-center gap-1 rounded-md text-xs text-ink-muted ring-1 ring-line transition-colors hover:bg-hover hover:text-ink aria-pressed:bg-accent-soft aria-pressed:text-accent aria-pressed:ring-accent/40'

/** 参数面板里的一个参数：画幅用形状按钮，少量选项用分段按钮，范围用滑块 */
function ParamControl({
  name,
  field,
  value,
  aspect,
  onChange,
}: {
  name: string
  field: FieldSchema
  value: unknown
  aspect: boolean
  onChange(v: unknown): void
}) {
  const label = field.title ?? name
  let control: React.ReactNode
  if (field.enum && aspect) {
    control = (
      <div className="grid grid-cols-5 gap-1.5">
        {field.enum.map((o) => {
          const r = parseAspect(o) ?? 1
          return (
            <button
              key={String(o)}
              type="button"
              aria-pressed={String(value) === String(o)}
              onClick={() => onChange(o)}
              className={`${seg} !h-14 flex-col !gap-1.5`}
            >
              <AspectGlyph ratio={r} size={18} />
              <span className="tabular-nums">{String(o)}</span>
            </button>
          )
        })}
      </div>
    )
  } else if (field.enum) {
    control = (
      <div className="flex flex-wrap gap-1.5">
        {field.enum.map((o) => (
          <button
            key={String(o)}
            type="button"
            aria-pressed={String(value) === String(o)}
            onClick={() => onChange(o)}
            className={`${seg} min-w-14`}
          >
            {String(o)}
          </button>
        ))}
      </div>
    )
  } else {
    const min = field.minimum ?? 1
    const max = field.maximum ?? min + 9
    const n = Number(value ?? field.default ?? min)
    control =
      max - min <= 5 ? (
        <div className="flex gap-1.5">
          {Array.from({ length: max - min + 1 }, (_, i) => min + i).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={n === v}
              onClick={() => onChange(v)}
              className={seg}
            >
              {name === 'count' ? `${v} 张` : v}
            </button>
          ))}
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <input
            type="range"
            aria-label={label}
            min={min}
            max={max}
            step={1}
            value={n}
            onChange={(e) => onChange(Number(e.target.value))}
            className="flex-1"
          />
          <span className="w-12 text-right text-xs tabular-nums text-ink">
            {n}
            {name === 'duration' ? ' 秒' : ''}
          </span>
        </div>
      )
  }
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-ink-subtle">{label}</span>
      {control}
    </div>
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
        className="field-sizing-content max-h-60 min-h-24 w-full resize-none bg-transparent px-4 py-3 text-base text-ink outline-none placeholder:text-ink-subtle"
      />
      {mentions.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 px-4 pb-2 text-xs text-ink-subtle">
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
          className="ui-menu absolute left-3 top-full z-10 mt-1 w-72"
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
              className="ui-menu-item flex-col !items-start !gap-0.5"
            >
              <span className="text-sm">{p.title}</span>
              {p.description && (
                <span className="truncate text-xs text-ink-subtle">{p.description}</span>
              )}
            </button>
          ))}
        </div>
      )}
      {mentionOptions.length > 0 && (
        <div
          role="listbox"
          aria-label="引用资产"
          className="ui-menu absolute left-3 top-full z-10 mt-1 w-64"
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
              className="ui-menu-item"
            >
              <Thumb engine={engine} target={t} />
              <span className="truncate">{name}</span>
              <span className="ml-auto text-xs text-ink-subtle">{targetKind(t)}</span>
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
      className="size-6 flex-none rounded-sm object-cover"
    />
  ) : (
    <span className="size-6 flex-none rounded-sm bg-surface-3" />
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
      className="flex h-7 items-center gap-1.5 rounded-md bg-accent-soft pl-0.5 pr-2 text-accent hover:brightness-110"
    >
      <Thumb engine={engine} target={target} />
      {name}
    </button>
  )
}

/**
 * 连入的素材（生成器顶部那一排）：参考图 / 首尾帧是带编号的缩略图，
 * 空着的单连输入显示虚线占位，点一下直接上传并连上；上游文本是一行小标签。
 */
function Inputs({
  engine,
  el,
  node,
  ups,
}: {
  engine: Engine
  el: CanvasElement
  node: NodeInfo
  ups: Map<string, Upstream[]>
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [target, setTarget] = useState<NodeInfo['inputs'][number] | null>(null)
  const media = node.inputs.filter((p) => p.type !== 'text')
  const texts = node.inputs.filter((p) => p.type === 'text').flatMap((p) => ups.get(p.id) ?? [])
  const locate = (u: Upstream) => {
    engine.selection.set([u.source.id])
    engine.zoomToFit([u.source.id])
  }

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
        { x: rect.x - 420, y: rect.y + rect.h / 2 },
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
  const pick = (port: NodeInfo['inputs'][number]) => {
    setTarget(port)
    requestAnimationFrame(() => fileRef.current?.click())
  }

  let n = 0
  const tiles: React.ReactNode[] = []
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
          onRemove={() => removeEdges(engine.doc, [u.edgeId])}
        />,
      )
    }
    if (port.multiple || list.length === 0)
      tiles.push(
        <button
          key={`add-${port.id}`}
          type="button"
          onClick={() => pick(port)}
          title={`上传${port.label}，也可以从画布上的图片拖线连入`}
          className={`group flex flex-none flex-col items-center gap-1 text-2xs ${port.required && list.length === 0 ? 'text-danger' : 'text-ink-subtle'} hover:text-ink`}
        >
          <span className="flex size-12 items-center justify-center rounded-md border border-dashed border-line-strong bg-surface-2/50 transition-colors duration-[var(--dur-fast)] group-hover:border-ink-subtle">
            <Icon name="plus" size={16} />
          </span>
          {port.label}
        </button>,
      )
  }

  if (!tiles.length && !texts.length) return null
  return (
    <div className="flex flex-col gap-2 px-4 pt-4">
      {tiles.length > 0 && (
        <div className="ui-scrollbar flex items-start gap-2 overflow-x-auto pb-0.5">{tiles}</div>
      )}
      {texts.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-ink-subtle">
          上游文本
          {texts.map((u) => (
            <TextChip
              key={u.edgeId}
              up={u}
              onLocate={() => locate(u)}
              onRemove={() => removeEdges(engine.doc, [u.edgeId])}
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
        className="relative size-12 overflow-hidden rounded-md bg-surface-2 ring-1 ring-line"
      >
        {img ? (
          <img src={img} alt="" className="size-full object-cover" />
        ) : (
          <span className="flex size-full items-center justify-center text-ink-subtle">
            <Icon name={v?.type === 'video' ? 'video' : 'image'} size={16} />
          </span>
        )}
        <span className="absolute left-1 top-1 flex size-4 items-center justify-center rounded-full bg-black/60 text-2xs font-medium text-white tabular-nums">
          {index}
        </span>
        {!v && <span className="absolute inset-0 bg-canvas/50" />}
      </button>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`断开「${name}」`}
        className="absolute -right-1.5 -top-1.5 hidden size-5 items-center justify-center rounded-full bg-surface-3 text-ink shadow ring-1 ring-line group-hover:flex"
      >
        <Icon name="x" size={11} />
      </button>
      {caption && <span>{caption}</span>}
    </div>
  )
}

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
    <span className="group flex h-6 max-w-56 items-center gap-1 rounded-sm bg-surface-2 pl-2 pr-0.5 ring-1 ring-line">
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
        className="flex size-5 flex-none items-center justify-center rounded-xs text-ink-subtle opacity-60 hover:bg-active hover:text-ink group-hover:opacity-100"
      >
        ×
      </button>
    </span>
  )
}
