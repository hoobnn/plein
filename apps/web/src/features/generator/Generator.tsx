import type { Engine } from '@plein/canvas-core'
import { type CanvasElement, setParam, updateElement } from '@plein/doc'
import {
  ASSET_NODE_TYPES,
  firstPlaceholder,
  presetsFor,
  SEQUENCE_TYPE,
  STORYBOARD_TYPE,
  type VideoMode,
} from '@plein/nodes'
import type { Catalog } from '@plein/protocol'
import { useEffect, useRef, useState } from 'react'
import { useEngineVersion, useFollow } from '../../canvas/hooks'
import { adaptToModel, constrainFields, selectedModel } from '../../canvas/modelParams'
import {
  applyAspect,
  aspectKey,
  fieldsOf,
  findNode,
  isPure,
  type NodeInfo,
  promptKey,
  upstreams,
  validate,
} from '../../canvas/nodes'
import { cancelNode, runNode } from '../runs/run'
import { shotsOf } from '../storyboard/model'
import { useCanvas } from '../../stores/canvas'
import { useCatalog } from '../../stores/catalog'
import { Icon } from '../../ui/icons'
import { withShortcut } from '../../ui/keys'
import { mediaOf } from '../../canvas/grid'
import { ResultActions } from '../../shell/ResultBar'
import { type ObjectSchema, SchemaForm } from '../../ui/SchemaForm'
import { Inputs } from './Inputs'
import { LibrarySave } from './LibrarySave'
import { ProfileSummary } from './ProfileSummary'
import { ModelPicker } from './ModelPicker'
import { ModePicker } from './ModePicker'
import { countUnit, isMainField, type ModelOptions, ParamsPill } from './ParamsPill'
import { PromptBox } from './PromptBox'
import { PromptTools } from './PromptTools'

const PANEL_W = 600
const GAP = 12
/** 节点标题行在卡片上方，面板放上方时让开它 */
const TITLE_H = 30
/** 面板离视口底边的最小距离：让开底部工具条（12 边距 + 44 高 + 8 间隔） */
const BOTTOM_RESERVED = 64
/** 顶部页头占的高度 */
const TOP_RESERVED = 64
/** 下方剩余空间不少于这么高时总放在下方 */
const PREFER_BELOW = 280
const MIN_H = 180

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
  const place = () => (el ? placeBeside(engine, el.id) : null)
  const ref = useFollow<HTMLElement>(engine, place)
  const style = place()
  if (!el || !style || !node || el.locked || engine.doc.readOnly) return null
  return (
    <Panel
      key={el.id}
      engine={engine}
      el={el}
      node={node}
      catalog={catalog}
      style={style}
      panelRef={ref}
    />
  )
}

/** 默认放在节点下方；下方实在放不下才放上方，让开标题行 */
function placeBeside(engine: Engine, id: string) {
  const rect = engine.scene.rect(id)
  if (!rect) return null
  const tl = engine.worldToClient(rect.x, rect.y)
  const br = engine.worldToClient(rect.x + rect.w, rect.y + rect.h)
  const below = window.innerHeight - BOTTOM_RESERVED - br.y
  const above = tl.y - TITLE_H - TOP_RESERVED
  // 左边让开侧栏；可见区域不够宽时面板跟着变窄
  const minLeft = engine.camera.insets.left + GAP
  const width = Math.max(320, Math.min(PANEL_W, window.innerWidth - minLeft - GAP))
  const left = Math.max(
    minLeft,
    Math.min((tl.x + br.x) / 2 - width / 2, window.innerWidth - width - GAP),
  )
  return below >= PREFER_BELOW || below >= above
    ? {
        left,
        width,
        top: Math.max(TOP_RESERVED, br.y + GAP),
        maxHeight: Math.max(MIN_H, below - GAP),
      }
    : {
        left,
        width,
        bottom: window.innerHeight - tl.y + TITLE_H + GAP,
        maxHeight: Math.max(MIN_H, above - GAP),
      }
}

function Panel({
  engine,
  el,
  node,
  catalog,
  style,
  panelRef,
}: {
  engine: Engine
  el: CanvasElement
  node: NodeInfo
  catalog: Catalog | null
  style: React.CSSProperties
  panelRef: React.Ref<HTMLElement>
}) {
  const [more, setMore] = useState(false)
  const canvasId = useCanvas((s) => s.canvasId)
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const params = { ...node.defaults, ...el.params }
  const ak = aspectKey(node)
  const set = (key: string, value: unknown) => {
    setParam(engine.doc, el.id, key, value)
    if (key === ak) applyAspect(engine, el.id, value)
  }
  const pk = promptKey(node)
  const model = selectedModel(catalog, node, params)
  // 选项和范围跟着所选模型走，模型不支持的参数不显示
  const fields = constrainFields(
    node,
    fieldsOf(node).filter(([, f]) => f.widget !== 'hidden'),
    model?.info.limits,
  )
  // 换模型时自动校正了哪些参数
  const [notes, setNotes] = useState<string[]>([])
  // oxlint-disable react-hooks/exhaustive-deps -- 换节点时清空
  useEffect(() => setNotes([]), [el.id])
  // oxlint-enable react-hooks/exhaustive-deps
  const optionsKey = fieldsOf(node).find(([, f]) => f.widget === 'modelOptions')?.[0]
  const allOptions = (optionsKey ? params[optionsKey] : undefined) as
    | Record<string, Record<string, unknown>>
    | undefined
  // 专属参数只在明确选了模型时可设（自动选择时不知道会落到哪个模型）
  const modelOptions: ModelOptions | undefined =
    optionsKey && model?.ref && model.info.optionsSchema
      ? {
          title: model.info.title,
          schema: model.info.optionsSchema as ObjectSchema,
          value: allOptions?.[model.ref] ?? {},
          onChange: (next: Record<string, unknown>) =>
            set(optionsKey, { ...allOptions, [model.ref]: next }),
        }
      : undefined
  const main = fields.filter(([k, f]) => k !== pk && f.widget !== 'videoMode' && isMainField(k, f))
  const rest = Object.fromEntries(
    fields.filter(([k, f]) => k !== pk && f.widget !== 'videoMode' && !isMainField(k, f)),
  )
  const modeField = fields.find(([, f]) => f.widget === 'videoMode')
  const ups = upstreams(engine, el.id, catalog)
  const presets = presetsFor(catalog?.prompts ?? [], node)
  const pure = isPure(node)
  const problem = validate(node, el, ups, catalog)
  // 只差提示词时不在底栏重复说（输入框的占位文字已经在说），按钮的悬停提示照常给原因
  const onlyPromptMissing =
    !!problem &&
    !!pk &&
    !validate(node, { ...el, params: { ...el.params, [pk]: '-' } }, ups, catalog)
  const running = el.run?.status === 'running' || el.run?.status === 'queued'
  const modelField = main.find(([, f]) => f.widget === 'model')
  // 画幅放最前：摘要读起来是“16:9 · 5s”
  const paramFields = main
    .filter(([, f]) => f.widget !== 'model')
    .sort(([a], [b]) => Number(b === ak) - Number(a === ak))
  const countField = fieldsOf(node).find(([k]) => k === 'count')
  const hasParams = paramFields.length > 0 || Object.keys(rest).length > 0 || !!modelOptions
  const runLabel = running ? '取消' : el.results?.length ? '重新生成' : '生成'

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

  // 已有结果时，预设、生成视频、宫格切分、下载、全屏放在第一行右侧
  const media = running ? null : mediaOf(el)
  const actions = media && (
    <ResultActions
      engine={engine}
      el={el}
      media={media}
      catalog={catalog}
      remote={!!canvasId}
      variant="inline"
    />
  )

  const run = () => {
    if (running) void cancelNode(el.id)
    else if (!problem) void runNode(el.id)
  }

  return (
    <section
      ref={panelRef}
      aria-label={`${node.title} 生成器`}
      data-testid="generator"
      style={style}
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
          trailing={canvasId ? <LibrarySave engine={engine} el={el} /> : null}
        />
      )}
      {(node.inputs.length > 0 || actions) && (
        <Inputs engine={engine} el={el} node={node} ups={ups} trailing={actions} />
      )}
      {node.type === 'plein/character' && canvasId && <ProfileSummary engine={engine} el={el} />}
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
            <span className={`transition-transform ${more ? 'rotate-180' : ''}`}>
              <Icon name="chevronDown" size={14} />
            </span>
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
          {notes.length > 0 && !problem && (
            <p className="px-1 text-xs text-ink-subtle">{notes.join('；')}</p>
          )}
          {((problem && !onlyPromptMissing) || (!running && el.run?.status === 'failed')) && (
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
                onChange={(v) => {
                  const next = { ...params, [modelField[0]]: v }
                  const { patch, notes } = adaptToModel(
                    node,
                    next,
                    selectedModel(catalog, node, next)?.info,
                  )
                  set(modelField[0], v)
                  for (const [k, value] of Object.entries(patch)) set(k, value)
                  setNotes(notes)
                }}
              />
            )}
            {modeField && (
              <ModePicker
                value={params[modeField[0]] as VideoMode}
                images={ups.get('images')?.length ?? 0}
                onChange={(v) => set(modeField[0], v)}
              />
            )}
            {(modelField || modeField) && hasParams && (
              <span aria-hidden="true" className="ui-bar-sep" />
            )}
            {hasParams && (
              <ParamsPill
                fields={paramFields}
                rest={rest}
                params={params}
                aspect={ak}
                options={modelOptions}
                // 模型只能出 1 张时张数不可选，摘要里照样写出来
                fixed={
                  countField && !paramFields.some(([k]) => k === 'count')
                    ? [`1 ${countUnit(countField[1])}`]
                    : []
                }
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
              title={problem ?? (running ? runLabel : withShortcut(runLabel, 'mod+enter'))}
              aria-label={runLabel}
              className={`ui-btn ui-btn-lg ui-icon-btn ml-1 ${running ? 'ui-btn-secondary' : 'ui-btn-primary'}`}
            >
              <Icon name={running ? 'stop' : 'arrowUp'} size={running ? 14 : 16} />
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
  trailing,
  onChange,
}: {
  value: string
  hint?: string
  trailing?: React.ReactNode
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
      {trailing}
    </div>
  )
}
