import type { Engine } from '@plein/canvas-core'
import { type CanvasElement, primaryResult, setParam, updateElement } from '@plein/doc'
import {
  ASSET_NODE_TYPES,
  ANIMATIC_TYPE,
  firstPlaceholder,
  presetsFor,
  SEQUENCE_TYPE,
  STAGE_TYPE,
  stageSnapshotsOf,
  STORYBOARD_TYPE,
  SHOT_ANALYSIS_TYPE,
  type VideoMode,
} from '@plein/nodes'
import type { Catalog } from '@plein/protocol'
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { useEngineVersion, useFollow } from '../../canvas/hooks'
import { canvasBottomSpace, fitFloatingPanel } from '../../canvas/floatingPanel'
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
import { cancelRequestKey, useCancelRequests } from '../runs/cancelRequests'
import { runRequestKey, useRunRequests } from '../runs/runRequests'
import { shotsOf } from '../storyboard/model'
import { useCanvas } from '../../stores/canvas'
import { useCatalog } from '../../stores/catalog'
import { Icon } from '../../ui/icons'
import { withShortcut } from '../../ui/keys'
import { mediaOf } from '../../canvas/grid'
import { ResultActions } from '../../shell/ResultBar'
import { AssetDownloadButton } from '../../shell/AssetDownloadButton'
import { type ObjectSchema, SchemaForm } from '../../ui/SchemaForm'
import { InputPreview, issueText, useInputPreview } from './InputPreview'
import { ContinuedFrom } from './ContinuedFrom'
import { MaskField } from './MaskField'
import { Inputs } from './Inputs'
import { LibrarySave } from './LibrarySave'
import { ProfileSummary } from './ProfileSummary'
import { ModelPicker } from './ModelPicker'
import { ModePicker } from './ModePicker'
import { countUnit, isMainField, type ModelOptions, ParamsPill } from './ParamsPill'
import { ShotPresets } from './ShotPresets'
import { PromptBox } from './PromptBox'
import { PromptTools } from './PromptTools'
import { RecipeLibrary } from './RecipeLibrary'

const PANEL_W = 600
const GAP = 12
/** 节点标题行在卡片上方，面板放上方时让开它 */
const TITLE_H = 30
/** 让开底部工具条及画布剩余宽度不足时上移的助手入口。 */
const bottomReserved = (engine: Engine) =>
  canvasBottomSpace(window.innerWidth, engine.camera.insets.left).generator
/** 顶部页头占的高度 */
const TOP_RESERVED = 64
/** 下方剩余空间不少于这么高时总放在下方 */
const PREFER_BELOW = 280
const MIN_H = 180

/** 选中单个节点时浮在它下方的生成器：参考素材、主提示词、模型与参数、生成 */
/** 损坏的历史值仅在显示时按空表单呈现；用户明确修改或恢复默认才写回。 */
function optionRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

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
  if (!el || !node || el.locked || engine.doc.readOnly) return null
  return <NodeGenerator key={el.id} engine={engine} el={el} node={node} catalog={catalog} />
}

function NodeGenerator({
  engine,
  el,
  node,
  catalog,
}: {
  engine: Engine
  el: CanvasElement
  node: NodeInfo
  catalog: Catalog | null
}) {
  const [expanded, setExpanded] = useState(false)
  // 平移不经过 React 的引擎状态订阅；只有可用空间跨过阈值时才重渲染面板。
  const cramped = useSyncExternalStore(
    useCallback((notify: () => void) => engine.onMove(notify), [engine]),
    () => {
      const rect = engine.scene.rect(el.id)
      if (!rect) return false
      const tl = engine.worldToClient(rect.x, rect.y)
      const br = engine.worldToClient(rect.x + rect.w, rect.y + rect.h)
      return (
        Math.max(
          tl.y - TITLE_H - TOP_RESERVED,
          window.innerHeight - bottomReserved(engine) - br.y,
        ) <
        MIN_H + GAP
      )
    },
  )
  const collapsed = cramped && !expanded
  const place = () => placeBeside(engine, el.id, collapsed, cramped && expanded)
  const ref = useFollow<HTMLElement>(engine, place)
  const style = place()
  if (!style) return null
  return (
    <Panel
      engine={engine}
      el={el}
      node={node}
      catalog={catalog}
      style={style}
      panelRef={ref}
      collapsed={collapsed}
      canCollapse={cramped}
      onExpand={() => setExpanded(true)}
      onCollapse={() => setExpanded(false)}
    />
  )
}

/** 默认放在节点下方；下方实在放不下才放上方，让开标题行 */
function placeBeside(engine: Engine, id: string, collapsed = false, expanded = false) {
  const rect = engine.scene.rect(id)
  if (!rect) return null
  const tl = engine.worldToClient(rect.x, rect.y)
  const br = engine.worldToClient(rect.x + rect.w, rect.y + rect.h)
  const bottom = bottomReserved(engine)
  const below = window.innerHeight - bottom - br.y
  const above = tl.y - TITLE_H - TOP_RESERVED
  const preferBelow = below >= PREFER_BELOW || below >= above
  const availableHeight = Math.max(0, window.innerHeight - TOP_RESERVED - bottom)
  // 空间不足时，用户主动展开应能使用窗口内的可用高度，不能仍挤在节点旁的窄缝里。
  const maxHeight = expanded
    ? availableHeight
    : Math.min(availableHeight, Math.max(MIN_H, (preferBelow ? below : above) - GAP))
  // 让开两侧面板；可见区域不够宽时面板跟着变窄。
  const minLeft = engine.camera.insets.left + GAP
  const right = window.innerWidth - engine.camera.insets.right - GAP
  const { left, width } = fitFloatingPanel((tl.x + br.x) / 2, PANEL_W, minLeft, right)
  if (collapsed) {
    // 紧凑入口避开两侧端口所在的中线；展开由用户主动接管编辑。
    const portY = (tl.y + br.y) / 2
    const height = 44
    const limit = window.innerHeight - bottom
    const top = portY + GAP + height <= limit ? portY + GAP : portY - GAP - height
    return {
      left,
      width,
      top: Math.max(TOP_RESERVED, Math.min(top, limit - height)),
      maxHeight: height,
    }
  }
  return preferBelow
    ? {
        left,
        width,
        top: Math.max(TOP_RESERVED, Math.min(br.y + GAP, window.innerHeight - bottom - maxHeight)),
        maxHeight,
      }
    : {
        left,
        width,
        bottom: Math.max(
          bottom,
          Math.min(
            window.innerHeight - tl.y + TITLE_H + GAP,
            window.innerHeight - TOP_RESERVED - maxHeight,
          ),
        ),
        maxHeight,
      }
}

function Panel({
  engine,
  el,
  node,
  catalog,
  style,
  panelRef,
  collapsed,
  canCollapse,
  onExpand,
  onCollapse,
}: {
  engine: Engine
  el: CanvasElement
  node: NodeInfo
  catalog: Catalog | null
  style: React.CSSProperties
  panelRef: React.Ref<HTMLElement>
  collapsed: boolean
  canCollapse: boolean
  onExpand(): void
  onCollapse(): void
}) {
  const [more, setMore] = useState(false)
  const canvasId = useCanvas((s) => s.canvasId)
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const pendingFocus = useRef(false)
  const params = { ...node.defaults, ...el.params }
  const ak = aspectKey(node)
  const set = (key: string, value: unknown) => {
    setParam(engine.doc, el.id, key, value)
    if (key === ak) applyAspect(engine, el.id, value)
  }
  const pk = promptKey(node)
  const model = selectedModel(catalog, node, params)
  const hiddenInstruction =
    node.capability === 'audio.speech' &&
    model?.info.limits?.instruction === false &&
    typeof params.instruction === 'string' &&
    params.instruction.trim() !== ''
  // 选项和范围跟着所选模型走，模型不支持的参数不显示
  const fields = constrainFields(
    node,
    fieldsOf(node).filter(([, f]) => f.widget !== 'hidden'),
    model?.info.limits,
    params,
  )
  // 换模型时自动校正了哪些参数
  const [notes, setNotes] = useState<string[]>([])
  // oxlint-disable react-hooks/exhaustive-deps -- 换节点时清空
  useEffect(() => setNotes([]), [el.id])
  // oxlint-enable react-hooks/exhaustive-deps
  const optionsKey = fieldsOf(node).find(([, f]) => f.widget === 'modelOptions')?.[0]
  const rawOptions = optionsKey ? params[optionsKey] : undefined
  const allOptions = optionRecord(rawOptions)
  // 没有专属表单的模型也可能读到旧参数；仍需提供显式恢复入口。
  const storedOptions =
    rawOptions !== undefined &&
    (!rawOptions ||
      typeof rawOptions !== 'object' ||
      Array.isArray(rawOptions) ||
      (model?.ref && Object.hasOwn(allOptions, model.ref)))
  const modelOptions: ModelOptions | undefined =
    optionsKey && model?.ref && (model.info.optionsSchema || storedOptions)
      ? {
          title: model.info.title,
          schema: (model.info.optionsSchema ?? { properties: {} }) as ObjectSchema,
          value: optionRecord(allOptions[model.ref]),
          readValue: () =>
            optionRecord(optionRecord(engine.doc.get(el.id)?.params?.[optionsKey])[model.ref]),
          onChange: (next: Record<string, unknown>) =>
            set(optionsKey, {
              ...optionRecord(engine.doc.get(el.id)?.params?.[optionsKey]),
              [model.ref]: next,
            }),
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
  // 生成前的实际输入：调模型的节点才有
  const input = useInputPreview(engine, !pure && node.capability ? canvasId : null, el.id)
  // 必需参考用不上这类问题只有服务端准备过才知道；输入刚改、还在重新准备时先不拦
  const blocked =
    !input.loading && !input.error && input.data?.blocked.length
      ? issueText(input.data.blocked).join('；')
      : null
  const own = validate(node, el, ups, catalog)
  const problem = own ?? blocked
  // 只差提示词时不在底栏重复说（输入框的占位文字已经在说），按钮的悬停提示照常给原因
  const onlyPromptMissing =
    !!own && !!pk && !validate(node, { ...el, params: { ...el.params, [pk]: '-' } }, ups, catalog)
  const running = el.run?.status === 'running' || el.run?.status === 'queued'
  const submitting = useRunRequests((s) => s.pending.has(runRequestKey(canvasId, el.id)))
  const awaitingAcceptance = submitting && !running
  const canceling = useCancelRequests((s) =>
    s.pending.has(cancelRequestKey(canvasId, el.id, el.run?.id)),
  )
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
      // 迟到的编辑请求不能把焦点从后来打开的面板抢回背景画布。
      if (
        document.querySelector(
          '[role="dialog"]:not([data-closing]), [role="alertdialog"]:not([data-closing])',
        )
      )
        return
      if (collapsed) {
        pendingFocus.current = true
        onExpand()
        return
      }
      focusPrompt()
    }
    window.addEventListener('plein:focus-generator', focus)
    return () => window.removeEventListener('plein:focus-generator', focus)
  }, [el.id, collapsed, onExpand])
  function focusPrompt() {
    if (
      document.querySelector(
        '[role="dialog"]:not([data-closing]), [role="alertdialog"]:not([data-closing])',
      )
    )
      return
    const ta = promptRef.current
    if (!ta) return
    ta.focus()
    const hole = firstPlaceholder(ta.value)
    if (hole) ta.setSelectionRange(hole.start, hole.end)
  }
  useEffect(() => {
    if (collapsed || !pendingFocus.current) return
    pendingFocus.current = false
    focusPrompt()
  }, [collapsed])

  // 已有结果时，预设、生成视频、宫格切分、下载、全屏放在第一行右侧
  const media = running ? null : mediaOf(el)
  const result = running ? undefined : primaryResult(el)
  const audio = result?.value.type === 'audio' ? result : undefined
  const actions = media ? (
    <ResultActions
      key={`actions:${media.assetId}`}
      engine={engine}
      el={el}
      media={media}
      catalog={catalog}
      remote={!!canvasId}
      variant="inline"
    />
  ) : result ? (
    <>
      {audio && audio.value.type === 'audio' && (
        <AssetDownloadButton
          engine={engine}
          elementId={el.id}
          assetId={audio.value.assetId}
          name={el.name ?? node.title}
          className="ui-btn ui-btn-quiet ui-btn-sm ui-icon-btn"
          iconOnly
        />
      )}
      <button
        type="button"
        className="ui-btn ui-btn-quiet ui-btn-sm ui-icon-btn"
        aria-label="全屏查看"
        title="全屏查看"
        onClick={() =>
          useCanvas.getState().view({
            kind: 'result',
            nodeId: el.id,
            resultId: result.id,
            name: el.name ?? node.title,
          })
        }
      >
        <Icon name="expand" size={14} />
      </button>
    </>
  ) : null

  const run = () => {
    if (canceling || awaitingAcceptance) return
    if (running) void cancelNode(el.id, el.run?.id)
    // 带上用户看到的实际输入：提交时输入已经变了就不运行，换成新的预览
    else if (!problem)
      void runNode(
        el.id,
        input.data?.inputHash && !input.loading
          ? { expect: input.data.inputHash, onChanged: input.setData }
          : undefined,
      )
  }

  return (
    <section
      ref={panelRef}
      aria-label={`${node.title} 生成器`}
      data-testid="generator"
      data-compact={collapsed}
      style={style}
      className="plein-generator ui-scrollbar pointer-events-auto fixed z-20 flex flex-col overflow-y-auto rounded-xl"
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault()
          run()
        }
      }}
    >
      {canCollapse && (
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={() => {
            if (collapsed) {
              pendingFocus.current = true
              onExpand()
            } else onCollapse()
          }}
          className="plein-generator-toggle ui-btn ui-btn-quiet sticky top-0 z-10 min-h-11 shrink-0 justify-between rounded-none px-4"
        >
          <span>{collapsed ? `编辑${node.title}` : '收起编辑器'}</span>
          <Icon name={collapsed ? 'expand' : 'collapse'} size={14} />
        </button>
      )}
      <div
        className={collapsed ? 'hidden' : 'contents'}
        onFocusCapture={(event) => {
          const target = event.target
          // Portal 中的模型搜索等浮层保持各自生命周期，不锁定主编辑器。
          if (!event.currentTarget.contains(target)) return
          if (
            target instanceof HTMLInputElement ||
            target instanceof HTMLTextAreaElement ||
            target.isContentEditable
          )
            onExpand()
        }}
      >
        {ASSET_NODE_TYPES.has(node.type) && (
          <NameField
            value={el.name ?? node.title}
            onChange={(name) => {
              if (engine.doc.readOnly) {
                useCanvas.getState().notify('画布已变为只读，名称未保存')
                return false
              }
              engine.doc.undo.stopCapturing()
              updateElement(engine.doc, el.id, { name })
              engine.doc.undo.stopCapturing()
            }}
            hint={`在提示词里输入 @${el.name ?? node.title} 引用`}
            trailing={canvasId ? <LibrarySave engine={engine} el={el} /> : null}
          />
        )}
        {(node.inputs.length > 0 || actions) && (
          <Inputs engine={engine} el={el} node={node} ups={ups} trailing={actions} />
        )}
        <ContinuedFrom engine={engine} el={el} />
        {node.type === SHOT_ANALYSIS_TYPE && (
          <div className="px-4 pt-4">
            <button
              type="button"
              className="ui-btn ui-btn-secondary w-full"
              onClick={() => useCanvas.getState().openShotAnalysis(el.id)}
            >
              打开拉片清单
            </button>
          </div>
        )}
        {node.capability === 'image.edit' && (
          <MaskField engine={engine} el={el} source={ups.get('image')?.[0]} />
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
        {(node.type === SEQUENCE_TYPE || node.type === ANIMATIC_TYPE) && (
          <div className="px-4 pt-4">
            <button
              type="button"
              onClick={() => useCanvas.getState().openSequence(el.id)}
              className="ui-btn ui-btn-secondary w-full"
            >
              {node.type === ANIMATIC_TYPE
                ? '编辑节奏样片'
                : `编辑序列（${ups.get('clips')?.length ?? 0} 段镜头）`}
            </button>
          </div>
        )}
        {node.type === STAGE_TYPE && (
          <div className="flex flex-col gap-2 px-4 pt-4">
            <button
              type="button"
              onClick={() => useCanvas.getState().openStage(el.id)}
              className="ui-btn ui-btn-secondary w-full"
            >
              打开 3D 构图
            </button>
            <p className="ui-help">
              {stageSnapshotsOf(el.params).length
                ? `已截 ${stageSnapshotsOf(el.params).length} 张，下游用当前采用的那张；改场景后要重新截图才会更新`
                : '摆好人物和机位后截图，把「构图」连到图片节点的参考图'}
            </p>
          </div>
        )}
        {pk && presets.length > 0 && (
          <RecipeLibrary key={el.id} engine={engine} el={el} node={node} />
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
        {pk && !pure && (
          <ShotPresets engine={engine} el={el} node={node} catalog={catalog} promptKey={pk} />
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
                  readValue={() => engine.doc.get(el.id)?.params ?? {}}
                  onChange={(next) => {
                    for (const k of Object.keys(rest)) if (next[k] !== params[k]) set(k, next[k])
                  }}
                />
              </div>
            )}
          </div>
        )}
        {!pure && (
          <InputPreview
            engine={engine}
            el={el}
            node={node}
            data={input.data}
            loading={input.loading}
            error={input.error}
            onRetry={input.retry}
          />
        )}
        {!pure && (
          // 底栏吸底：面板被视口截短时生成按钮仍然可见
          <footer className="plein-generator-footer sticky bottom-0 flex flex-col gap-2 px-3 py-3">
            {hiddenInstruction && (
              <div className="flex items-start gap-2 px-1 text-xs text-ink-muted">
                <p
                  className="min-w-0 flex-1 line-clamp-2 break-words"
                  title={String(params.instruction)}
                >
                  当前模型不支持自由语气，已保留指令：{String(params.instruction)}
                </p>
                <button
                  type="button"
                  className="ui-btn ui-btn-xs ui-btn-secondary shrink-0"
                  onClick={() => {
                    focusPrompt()
                    set('instruction', '')
                  }}
                >
                  清空语气指令
                </button>
              </div>
            )}
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
                  videos={ups.get('videos')?.length ?? 0}
                  audios={ups.get('audios')?.length ?? 0}
                  allowedModes={model?.info.limits?.videoModes}
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
                  readParams={() => engine.doc.get(el.id)?.params ?? {}}
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
                disabled={canceling || awaitingAcceptance || (!running && !!problem)}
                aria-busy={canceling || awaitingAcceptance}
                title={problem ?? (running ? runLabel : withShortcut(runLabel, 'mod+enter'))}
                aria-label={runLabel}
                className={`ui-btn ui-btn-lg ui-icon-btn ml-1 ${running ? 'ui-btn-secondary' : 'ui-btn-primary'}`}
              >
                {canceling || awaitingAcceptance ? (
                  <span className="ui-spinner size-3" />
                ) : (
                  <Icon name={running ? 'stop' : 'arrowUp'} size={running ? 14 : 16} />
                )}
              </button>
            </div>
            {canceling && (
              <p role="status" className="text-xs text-ink-muted">
                正在停止任务…
              </p>
            )}
            {awaitingAcceptance && (
              <p role="status" className="text-xs text-ink-muted">
                正在提交生成请求…
              </p>
            )}
          </footer>
        )}
      </div>
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
  onChange(v: string): boolean | void
}) {
  const [edit, setEdit] = useState({ base: value, draft: value })
  const conflictId = useId()
  useEffect(() => {
    setEdit((prev) =>
      prev.draft === prev.base || prev.draft === value ? { base: value, draft: value } : prev,
    )
  }, [value])
  const { draft, base } = edit
  const conflict = base !== value && draft.trim() !== value
  const reset = () => setEdit({ base: value, draft: value })
  const commit = () => {
    const v = draft.trim()
    if (v && v !== value) {
      if (onChange(v) === false) reset()
      else setEdit({ base: v, draft: v })
    } else reset()
  }
  return (
    <div className="plein-generator-name border-b border-line">
      <div className="flex items-center gap-2 px-4 py-3">
        <input
          aria-label="节点名称"
          aria-describedby={conflict ? conflictId : undefined}
          value={draft}
          onChange={(e) => setEdit({ base, draft: e.target.value })}
          onBlur={() => {
            if (!conflict) commit()
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) {
              e.stopPropagation()
              return
            }
            if (e.key === 'Escape' && draft !== value) {
              e.preventDefault()
              e.stopPropagation()
              reset()
            }
            if (e.key === 'Enter') {
              e.preventDefault()
              if (conflict) commit()
              e.currentTarget.blur()
            }
          }}
          className="min-w-0 flex-1 rounded-sm bg-transparent text-base font-semibold text-ink outline-none"
        />
        {hint && (
          <span title={hint} className="max-w-1/2 truncate text-xs text-ink-subtle">
            {hint}
          </span>
        )}
        {trailing}
      </div>
      {conflict && (
        <div className="space-y-2 px-4 pb-3">
          <p id={conflictId} role="status" className="break-words text-xs text-ink-subtle">
            名称已在其他位置更新为「{value}」。请选择要使用的名称。
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="ui-btn ui-btn-secondary" onClick={reset}>
              使用更新后的名称
            </button>
            <button type="button" className="ui-btn ui-btn-secondary" onClick={commit}>
              保留当前输入
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
