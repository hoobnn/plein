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
import { isAiAnalysisType } from '@plein/nodes'
import type { Catalog } from '@plein/protocol'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useEngineVersion, useFollow } from '../../canvas/hooks'
import { canvasBottomSpace } from '../../canvas/floatingPanel'
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
import { AiAnalysisEntry } from '../ai-shot-analysis/AiAnalysisEditor'
import { RecipeLibrary } from './RecipeLibrary'
import { CharacterImageArchiveButton } from '../library/ArchiveCharacterImage'

/** 卡片下方的编辑器尺寸：固定 840px 宽、440px 高。 */
const EDITOR_W = 840
const EDITOR_H = 440
/** 可见画布再窄，编辑器也要留得下这些控件。 */
const MIN_EDITOR_W = 320
const MIN_EDITOR_H = 180

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
  if (!el || !node) return null
  if (el.locked || engine.doc.readOnly)
    return isAiAnalysisType(node.type) ? <AiAnalysisEntry engine={engine} el={el} /> : null
  return (
    <NodeBelow engine={engine} nodeId={el.id} title={el.name ?? node.title}>
      {isAiAnalysisType(node.type) ? (
        <div className="p-4">
          <button
            type="button"
            className="ui-btn ui-btn-secondary w-full"
            onClick={() => useCanvas.getState().openAiAnalysis({ kind: 'node', nodeId: el.id })}
          >
            查看 AI 分析与预检
          </button>
        </div>
      ) : (
        <GeneratorPanel key={el.id} engine={engine} el={el} node={node} catalog={catalog} />
      )}
    </NodeBelow>
  )
}

/** 编辑器固定在卡片下方；相机变化时只更新锚点，不翻转或切换成窗口停靠。 */
function NodeBelow({
  engine,
  nodeId,
  title,
  children,
}: {
  engine: Engine
  nodeId: string
  title: string
  children: ReactNode
}) {
  const place = () => {
    const rect = engine.doc.worldRect(nodeId)
    if (!rect) return null
    const tl = engine.worldToClient(rect.x, rect.y)
    const br = engine.worldToClient(rect.x + rect.w, rect.y + rect.h)
    // 编辑器固定在卡片下方、不翻到上方，也不压住自己的卡片：卡片上的输出端口
    // 要能直接拖线。横向让开侧栏、纵向避开底栏，窗口不够大就按可用空间收，
    // 内容在面板里滚动，右边的关闭按钮和底部的生成按钮始终够得着。
    const left = engine.camera.insets.left
    const right = window.innerWidth - engine.camera.insets.right
    const bottom = window.innerHeight - canvasBottomSpace(window.innerWidth, left).generator
    const width = Math.max(MIN_EDITOR_W, Math.min(EDITOR_W, right - left))
    const top = br.y + 12
    // 卡片下方放得下多少就占多少；实在放不下就保持高度、伸到窗口外，
    // 也不能盖住卡片：卡片上的输出端口要能直接拖线。
    const height = Math.min(EDITOR_H, Math.max(bottom - top, MIN_EDITOR_H))
    return {
      left: Math.max(left, Math.min((tl.x + br.x - width) / 2, right - width)),
      top,
      width,
      height,
      maxHeight: height,
    }
  }
  const ref = useFollow<HTMLElement>(engine, place)
  const style = place()
  if (!style) return null
  return (
    <aside
      ref={ref}
      aria-label="节点编辑器"
      data-testid="node-editor"
      data-placement="below"
      className="plein-node-editor pointer-events-auto fixed z-20 flex min-h-0 flex-col overflow-hidden rounded-2xl border border-line bg-surface"
      style={style}
    >
      <button
        type="button"
        className="ui-btn ui-btn-quiet ui-btn-sm ui-icon-btn absolute top-2 right-3 z-10"
        aria-label="关闭节点编辑器"
        title={`关闭${title}编辑器`}
        onClick={() => engine.selection.set([])}
      >
        <Icon name="x" size={14} />
      </button>
      {children}
    </aside>
  )
}

export function GeneratorPanel({
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
  // 生成前的实际输入：所有要跑的节点都要（插件节点可能没有 capability，
  // 但服务端照样能准备输入；不取预览，生成按钮就一直是禁用的）
  const input = useInputPreview(engine, !pure ? canvasId : null, el.id)
  // 调模型的节点必须等这份实际输入；执行器节点（插件节点等）没有模型能力，
  // 服务端可能备不出实际输入，这时照样能生成，不因为等它把按钮卡住。
  const requiresInput = !pure && !!node.capability
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
      focusPrompt()
    }
    window.addEventListener('plein:focus-generator', focus)
    return () => window.removeEventListener('plein:focus-generator', focus)
  }, [el.id])
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

  // 已有结果时，预设、生成视频、宫格切分、下载、全屏放在第一行右侧
  const media = running ? null : mediaOf(el)
  const result = running ? undefined : primaryResult(el)
  const audio = result?.value.type === 'audio' ? result : undefined
  const actions = media ? (
    <>
      <ResultActions
        key={`actions:${media.assetId}`}
        engine={engine}
        el={el}
        media={media}
        catalog={catalog}
        remote={!!canvasId}
        variant="inline"
      />
      {canvasId && <CharacterImageArchiveButton engine={engine} el={el} canvasId={canvasId} />}
    </>
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
    if (canceling || awaitingAcceptance) return false
    if (running) {
      void cancelNode(el.id, el.run?.id)
      return true
    }
    // 带上用户看到的实际输入：提交时输入已经变了就不运行，换成新的预览
    if (problem) return false
    // 实际输入还在准备或已经过期：这时提交会被服务端判成输入已变，
    // 白跑一次还把这次生成丢掉。等新的实际输入备好再提交。
    if (input.loading || input.stale) return false
    // 调模型的节点要有实际输入才能提交；执行器节点没有也照样能生成。
    if (requiresInput && !input.data?.inputHash) return false
    void runNode(
      el.id,
      input.data?.inputHash
        ? { expect: input.data.inputHash, onChanged: input.setData }
        : undefined,
    )
    return true
  }

  // 按钮或快捷键比实际输入备好更早触发：先记下这次生成，备好后照常提交，
  // 不能像以前那样静默丢掉这次生成。
  const pendingRun = useRef(false)
  useEffect(() => {
    if (!pendingRun.current) return
    if (input.loading || input.stale) return
    // 调模型的节点要等实际输入备好；执行器节点没有也照样能生成。
    if (requiresInput && !input.data?.inputHash) return
    pendingRun.current = false
    run()
  })

  /** 输入还在准备时按下：记下来等它备好，不用让用户再点一次 */
  const requestRun = () => {
    // 实际输入还在准备或正在刷新：先记下，等拿到这份输入再提交，
    // 否则会拿着上一版的哈希提交，被服务端判成输入已变。
    if (!running && (input.loading || input.stale || (requiresInput && !input.data?.inputHash)))
      pendingRun.current = true
    // 这一步已经提交过了就别再记着：输入刷新完再补一次会重复生成。
    if (run()) pendingRun.current = false
  }

  return (
    <section
      aria-label={`${node.title} 生成器`}
      data-testid="generator"
      data-compact="false"
      className="plein-generator pointer-events-auto flex min-h-0 flex-1 flex-col overflow-hidden"
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault()
          requestRun()
        }
      }}
    >
      <div className="plein-generator-body ui-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto">
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
          <Inputs
            engine={engine}
            el={el}
            node={node}
            ups={ups}
            prepared={input.data}
            preparing={input.loading}
            trailing={actions}
            toolbar={
              presets.length > 0 ? (
                <RecipeLibrary key={el.id} engine={engine} el={el} node={node} />
              ) : undefined
            }
          />
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
        {pk && pure && (
          <div className="px-4 pt-3 pr-12 text-xs font-medium text-ink-subtle">正文</div>
        )}
        {pk && (
          <PromptBox
            ref={promptRef}
            engine={engine}
            selfId={el.id}
            prepared={input.data}
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
          <div className="plein-generator-inspectors">
            {pk && (
              <ShotPresets engine={engine} el={el} node={node} catalog={catalog} promptKey={pk} />
            )}
            <InputPreview
              engine={engine}
              el={el}
              node={node}
              data={input.data}
              loading={input.loading}
              error={input.error}
              onRetry={input.retry}
            />
          </div>
        )}
      </div>
      {!pure && (
        // 生成工具栏保持一行，独立于正文滚动。
        <footer className="plein-generator-footer flex flex-col gap-1 px-4 py-2">
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
          <div className="plein-generator-toolbar">
            <div className="plein-generator-models">
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
            </div>
            <div className="plein-generator-controls">
              <div className="min-w-0">
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
              </div>
              <div className="flex shrink-0 items-center justify-end gap-2">
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
                  onClick={requestRun}
                  disabled={
                    canceling ||
                    awaitingAcceptance ||
                    (!running && !!problem) ||
                    // 输入还在准备：按下先记下，备好后自动提交
                    (!running && requiresInput && !input.loading && !input.data?.inputHash) ||
                    // 预览已经过期：这份 inputHash 提交上去会被服务端判成输入已变
                    (!running && input.stale)
                  }
                  aria-busy={canceling || awaitingAcceptance}
                  title={problem ?? (running ? runLabel : withShortcut(runLabel, 'mod+enter'))}
                  aria-label={runLabel}
                  className={`ui-btn ui-icon-btn size-8 shrink-0 rounded-lg ${running ? 'ui-btn-secondary' : 'ui-btn-primary'}`}
                >
                  {canceling || awaitingAcceptance ? (
                    <span className="ui-spinner size-3" />
                  ) : (
                    <Icon name={running ? 'stop' : 'arrowUp'} size={running ? 14 : 16} />
                  )}
                </button>
              </div>
            </div>
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
      <div className="flex items-center gap-2 px-4 py-3 pr-12">
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
