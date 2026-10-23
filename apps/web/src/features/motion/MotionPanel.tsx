import type { Composition } from '@hyperframes/sdk'
import type { Engine } from '@plein/canvas-core'
import {
  adoptResult,
  currentResult,
  setParam,
  setParamEntry,
  setParams,
  type NodeResult,
} from '@plein/doc'
import {
  applyMotionEdit,
  MOTION_TYPE,
  MOTION_TEMPLATE_LABELS,
  MOTION_TEMPLATES,
  MotionParams,
  motionEditable,
  type MotionEditOperation,
  type MotionElementId,
} from '@plein/nodes'
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { assetUrls } from '../../api/client'
import { useEngineVersion } from '../../canvas/hooks'
import { upstreams } from '../../canvas/nodes'
import { useCanvas } from '../../stores/canvas'
import { useCatalog } from '../../stores/catalog'
import { Icon } from '../../ui/icons'
import { Modal, ModalHeader } from '../../ui/Modal'
import { useClosing } from '../../ui/Presence'
import { Select } from '../../ui/Select'
import { cancelNode, runNode } from '../runs/run'
import { runRequestKey, useRunRequests } from '../runs/runRequests'
import { cancelRequestKey, useCancelRequests } from '../runs/cancelRequests'
import { useStale } from '../runs/stale'
import type { MotionInputs } from './api'
import { applyMotionHistory, canMotionHistory, writeMotionEdit } from './history'
import { MotionPreview } from './MotionPreview'
import { editMotionDocument, openMotionDocument } from './sdk'
import { copyMotionSource, loadMotionSource } from './source'
import './motion.css'

const FieldLock = createContext(false)
const FieldHistory = createContext<((direction: 'undo' | 'redo') => void) | null>(null)

interface FrozenSource {
  resultId: string
  params: MotionParams
  inputs: MotionInputs
  manifestAssetId: string
}

// 原生颜色控件只接受六位色值；源参数保留合法的短色值或透明度。
const colorInput = (value: string) =>
  value.length === 4
    ? `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`
    : value.slice(0, 7)

const errorText = (error: unknown) => {
  const value = error as { issues?: Array<{ message: string }>; message?: string }
  return value.issues?.[0]?.message ?? value.message ?? '动态合成编辑失败'
}

function readInputs(engine: Engine, id: string): MotionInputs {
  const values = upstreams(engine, id, useCatalog.getState().catalog)
  const image = values.get('image')?.find((item) => item.value?.type === 'image')?.value
  const video = values.get('video')?.find((item) => item.value?.type === 'video')?.value
  return {
    ...(image?.type === 'image' ? { image: image.assetId } : {}),
    ...(video?.type === 'video' ? { video: video.assetId } : {}),
  }
}

export function MotionPanel({
  engine,
  id,
  onClose,
}: {
  engine: Engine
  id: string
  onClose(): void
}) {
  useEngineVersion(engine)
  // 删除或撤销创建时，引擎状态可能先于外层文档订阅刷新。
  if (engine.doc.get(id)?.nodeType !== MOTION_TYPE) return null
  const parsed = MotionParams.safeParse(engine.doc.get(id)?.params ?? {})
  if (!parsed.success)
    return (
      <Modal label="动态合成参数问题" onClose={onClose} isolateKeys className="max-w-xl">
        <ModalHeader title="动态合成参数需要修复" onClose={onClose} />
        <div className="flex flex-col gap-4 p-5">
          <p>{errorText(parsed.error)}</p>
          <button
            type="button"
            className="ui-btn self-start"
            disabled={engine.doc.readOnly}
            onClick={() => {
              if (engine.doc.readOnly || engine.doc.get(id)?.nodeType !== MOTION_TYPE) return
              writeMotionEdit(engine.doc, id, () =>
                setParams(engine.doc, id, MotionParams.parse({})),
              )
            }}
          >
            恢复默认参数
          </button>
        </div>
      </Modal>
    )
  return <Editor engine={engine} id={id} onClose={onClose} params={parsed.data} />
}

function Editor({
  engine,
  id,
  onClose,
  params,
}: {
  engine: Engine
  id: string
  onClose(): void
  params: MotionParams
}) {
  const closing = useClosing()
  const readOnly = engine.doc.readOnly
  const locked = readOnly || closing
  const target = useRef(engine.doc.elementMaps.get(id))
  const [selected, setSelected] = useState<MotionElementId>('hf-title')
  const [document, setDocument] = useState<Composition | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [frozen, setFrozen] = useState<FrozenSource | null>(null)
  const [sourceLoading, setSourceLoading] = useState(false)
  const sourceRequest = useRef<AbortController | null>(null)
  const mutations = useRef(new Map<string, number>())
  const canvasId = useCanvas((s) => s.canvasId)
  const submitting = useRunRequests((s) => s.pending.has(runRequestKey(canvasId, id)))
  const stale = useStale((s) => s.nodes.get(id))
  const el = engine.doc.get(id)!
  const active = el.run?.status === 'running' || el.run?.status === 'queued'
  const canceling = useCancelRequests((s) =>
    s.pending.has(cancelRequestKey(canvasId, id, el.run?.id)),
  )
  const adopted = currentResult(el)
  const inputs = readInputs(engine, id)
  const results = (el.results ?? []).filter((r) => r.value.type === 'video')
  const canWrite = () => {
    const current = useCanvas.getState()
    return (
      !engine.doc.readOnly &&
      !closing &&
      current.engine === engine &&
      current.motion === id &&
      engine.doc.elementMaps.get(id) === target.current &&
      target.current?.get('nodeType') === MOTION_TYPE
    )
  }
  const read = () => MotionParams.parse(engine.doc.get(id)?.params ?? {})
  const shown = frozen?.params ?? params
  const shownInputs = frozen?.inputs ?? inputs
  const key = JSON.stringify(shown)
  useEffect(() => {
    let gone = false
    let owned: Composition | null = null
    void openMotionDocument(shown).then(
      (opened) => {
        if (gone) return opened.dispose()
        owned = opened
        setDocument(opened)
      },
      (cause: unknown) => {
        if (!gone) setError(errorText(cause))
      },
    )
    return () => {
      gone = true
      owned?.dispose()
    }
    // SDK 会话始终由当前文档重建，history:false；不回放远端更新为本地写入。
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  useEffect(() => () => sourceRequest.current?.abort(), [])
  useEffect(() => {
    if (closing) sourceRequest.current?.abort()
  }, [closing])

  const commit = (field: keyof MotionParams, value: unknown) => {
    if (!canWrite() || frozen) return
    try {
      const latest = read()
      const next = MotionParams.parse({ ...latest, [field]: value })
      if (JSON.stringify(latest[field]) === JSON.stringify(next[field])) return
      writeMotionEdit(
        engine.doc,
        id,
        () => setParam(engine.doc, id, field, next[field]),
        `param:${field}`,
      )
      setError(null)
    } catch (cause) {
      setError(errorText(cause))
    }
  }
  const structured = async (
    scope: string,
    build: (latest: MotionParams) => MotionEditOperation,
    keys: string[],
  ) => {
    if (!canWrite() || frozen) return
    const sequence = (mutations.current.get(scope) ?? 0) + 1
    mutations.current.set(scope, sequence)
    let sdk: Composition | undefined
    try {
      const before = read()
      const operation = build(before)
      applyMotionEdit(before, operation)
      sdk = await openMotionDocument(before)
      editMotionDocument(sdk, operation)
      if (!canWrite() || mutations.current.get(scope) !== sequence) return
      const latest = read()
      if (latest.template !== before.template) throw new Error('模板已更换，请重新编辑这个字段')
      const next = applyMotionEdit(latest, build(latest))
      const changes = keys.filter((entry) => latest.overrides[entry] !== next.overrides[entry])
      if (!changes.length) return
      // 只提交本次明确编辑的字段，SDK 的 JSON patch 和整份 overrides 均不写入 Yjs。
      writeMotionEdit(
        engine.doc,
        id,
        () => {
          for (const entry of changes)
            setParamEntry(engine.doc, id, 'overrides', entry, next.overrides[entry])
        },
        scope,
      )
      setError(null)
    } catch (cause) {
      if (canWrite()) setError(errorText(cause))
    } finally {
      sdk?.dispose()
    }
  }
  const style = (property: string, value: string) => {
    const editable = motionEditable.find((item) => item.id === selected)!
    if (!(editable.styles as readonly string[]).includes(property)) return
    void structured(
      `${selected}.style.${property}`,
      () => ({ op: 'style', id: selected, property, value }) as MotionEditOperation,
      [`${selected}.style.${property}`],
    )
  }
  const timing = (part: 'start' | 'end', value: string) => {
    const at = Number(value)
    if (!Number.isFinite(at)) return setError('请输入有效时间')
    void structured(
      `${selected}.timing.${part}`,
      (latest) => ({
        op: 'timing',
        id: selected,
        start: part === 'start' ? at : Number(latest.overrides[`${selected}.timing.start`] ?? 0),
        end:
          part === 'end'
            ? at
            : Number(latest.overrides[`${selected}.timing.end`] ?? latest.duration),
      }),
      [`${selected}.timing.${part}`],
    )
  }
  const text = (part: 'hf-title' | 'hf-subtitle', value: string) =>
    void structured(`${part}.text`, () => ({ op: 'text', id: part, text: value }), [`${part}.text`])
  const history = (direction: 'undo' | 'redo') => {
    if (!canWrite() || frozen) return
    for (const [scope, sequence] of mutations.current) mutations.current.set(scope, sequence + 1)
    engine.doc.undo.stopCapturing()
    applyMotionHistory(engine.doc, id, direction)
    setError(null)
  }
  const keyboardHistory = useRef(history)
  keyboardHistory.current = history
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.altKey ||
        !(event.metaKey || event.ctrlKey)
      )
        return
      const target = event.target
      if (
        !(target instanceof HTMLElement) ||
        !target.closest('[role="dialog"][aria-label="动态合成"]') ||
        target.closest('input, textarea, [contenteditable="true"]')
      )
        return
      const value = event.key.toLowerCase()
      if (value !== 'z' && value !== 'y') return
      event.preventDefault()
      keyboardHistory.current(value === 'y' || event.shiftKey ? 'redo' : 'undo')
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [])
  const loadSource = async (result: NodeResult) => {
    if (!('compositionSource' in result.value) || !result.value.compositionSource) return
    sourceRequest.current?.abort()
    const abort = new AbortController()
    sourceRequest.current = abort
    setSourceLoading(true)
    try {
      const manifestAssetId = result.value.compositionSource.manifestAssetId
      const source = await loadMotionSource(manifestAssetId, abort.signal)
      if (abort.signal.aborted || !canView()) return
      setFrozen({ resultId: result.id, ...source, manifestAssetId })
      setError(null)
    } catch (cause) {
      if (!abort.signal.aborted && canView()) setError(errorText(cause))
    } finally {
      if (!abort.signal.aborted && canView()) setSourceLoading(false)
    }
  }
  const canView = () => {
    const state = useCanvas.getState()
    return state.engine === engine && state.motion === id && !closing
  }
  const restoreSource = () => {
    if (!canWrite() || !frozen || !canvasId || sourceLoading) return
    try {
      copyMotionSource(engine, id, frozen)
    } catch (cause) {
      setError(errorText(cause))
    }
  }
  const selection = document?.getElement(selected)
  const editable = motionEditable.find((entry) => entry.id === selected)!
  const selectedStyles = selection?.inlineStyles ?? {}
  const controlsLocked = locked || !!frozen
  const missingInput =
    params.template === 'character' && !inputs.image
      ? '角色介绍需要从画布连入图片'
      : params.template === 'video-title' && !inputs.video
        ? '视频标题包装需要从画布连入视频'
        : null
  const shownMissingInput =
    shown.template === 'character' && !shownInputs.image
      ? '角色介绍需要从画布连入图片'
      : shown.template === 'video-title' && !shownInputs.video
        ? '视频标题包装需要从画布连入视频'
        : null
  const status = active
    ? (el.run?.message ?? '渲染中…')
    : el.run?.status === 'failed'
      ? (el.run.error ?? '渲染失败')
      : stale
        ? '修改后需重新渲染，当前采用保留'
        : !results.length
          ? '尚未渲染'
          : !adopted
            ? '候选待采用'
            : '已采用，可接入序列'

  return (
    <Modal label="动态合成" onClose={onClose} isolateKeys className="motion-editor">
      <ModalHeader
        title="动态合成"
        onClose={onClose}
        meta={<span className="motion-status">{status}</span>}
      >
        <button
          type="button"
          className="ui-btn ui-icon-btn"
          aria-label="撤销动态合成编辑"
          disabled={controlsLocked || !canMotionHistory(engine.doc, id, 'undo')}
          onClick={() => history('undo')}
        >
          <Icon name="undo" />
        </button>
        <button
          type="button"
          className="ui-btn ui-icon-btn"
          aria-label="重做动态合成编辑"
          disabled={controlsLocked || !canMotionHistory(engine.doc, id, 'redo')}
          onClick={() => history('redo')}
        >
          <Icon name="redo" />
        </button>
        {active ? (
          <button
            type="button"
            className="ui-btn"
            disabled={locked || canceling}
            onClick={() => void cancelNode(id, el.run?.id)}
          >
            {canceling ? '正在停止…' : '取消渲染'}
          </button>
        ) : (
          <button
            type="button"
            className="ui-btn ui-btn-primary"
            disabled={controlsLocked || submitting || !!missingInput || !canvasId}
            onClick={() => {
              if (canWrite()) void runNode(id)
            }}
          >
            {submitting ? '正在提交…' : '渲染为候选'}
          </button>
        )}
      </ModalHeader>
      {error && (
        <p className="motion-error" role="alert">
          {error}
        </p>
      )}
      {readOnly && (
        <p className="motion-error" role="status">
          当前画布为只读，可预览与回看。
        </p>
      )}
      {frozen && (
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-2 text-xs">
          <span>正在查看候选源版本</span>
          <button type="button" className="ui-btn" onClick={() => setFrozen(null)}>
            返回当前编辑
          </button>
          <button
            type="button"
            className="ui-btn"
            disabled={locked || sourceLoading}
            title="用此版本的参数与原素材创建独立节点"
            onClick={restoreSource}
          >
            从此版继续编辑
          </button>
        </div>
      )}
      <div className="motion-layout">
        <FieldLock.Provider value={controlsLocked}>
          <FieldHistory.Provider value={history}>
            <aside className="motion-properties" aria-label="动态合成属性">
              <fieldset className="motion-section" disabled={controlsLocked}>
                <h3>模板与输出</h3>
                <Label label="模板">
                  <Select
                    aria-label="模板"
                    value={shown.template}
                    options={MOTION_TEMPLATES.map((value) => ({
                      value,
                      label: MOTION_TEMPLATE_LABELS[value],
                    }))}
                    disabled={controlsLocked}
                    onChange={(value) => commit('template', value)}
                  />
                </Label>
                <div className="motion-pair">
                  <Label label="画幅">
                    <Select
                      aria-label="画幅"
                      value={shown.aspectRatio}
                      options={[
                        { value: '9:16', label: '竖屏 9:16' },
                        { value: '16:9', label: '横屏 16:9' },
                      ]}
                      disabled={controlsLocked}
                      onChange={(value) => commit('aspectRatio', value)}
                    />
                  </Label>
                  <Label label="分辨率">
                    <Select
                      aria-label="分辨率"
                      value={shown.resolution}
                      options={[{ value: '720p' }, { value: '1080p' }]}
                      disabled={controlsLocked}
                      onChange={(value) => commit('resolution', value)}
                    />
                  </Label>
                </div>
                <Field
                  label="片段时长（秒）"
                  value={String(shown.duration)}
                  type="number"
                  min={1}
                  max={30}
                  step={1 / 30}
                  onCommit={(value) => commit('duration', Number(value))}
                />
                <div className="motion-pair">
                  <Label label="强调色">
                    <input
                      type="color"
                      aria-label="强调色"
                      value={colorInput(shown.accent)}
                      onChange={(event) => commit('accent', event.target.value)}
                    />
                  </Label>
                  <Label label="背景色">
                    <input
                      type="color"
                      aria-label="背景色"
                      value={colorInput(shown.background)}
                      onChange={(event) => commit('background', event.target.value)}
                    />
                  </Label>
                </div>
              </fieldset>
              <fieldset className="motion-section" disabled={controlsLocked}>
                <h3>文案</h3>
                <Field
                  label="标题文案"
                  multiline
                  value={String(shown.overrides['hf-title.text'] ?? shown.title)}
                  onCommit={(value) => text('hf-title', value)}
                />
                <Field
                  label="副标题文案"
                  multiline
                  value={String(shown.overrides['hf-subtitle.text'] ?? shown.subtitle)}
                  onCommit={(value) => text('hf-subtitle', value)}
                />
              </fieldset>
              <fieldset className="motion-section" disabled={controlsLocked}>
                <h3>图层与时间</h3>
                <Label label="编辑图层">
                  <Select
                    aria-label="编辑图层"
                    value={selected}
                    options={motionEditable.map((entry) => ({
                      value: entry.id,
                      label: entry.label,
                    }))}
                    disabled={controlsLocked}
                    onChange={(value) => setSelected(value as MotionElementId)}
                  />
                </Label>
                <div className="motion-pair">
                  <Field
                    label="出现时间（秒）"
                    value={String(shown.overrides[`${selected}.timing.start`] ?? 0)}
                    type="number"
                    min={0}
                    max={shown.duration}
                    step={1 / 30}
                    onCommit={(value) => timing('start', value)}
                  />
                  <Field
                    label="结束时间（秒）"
                    value={String(shown.overrides[`${selected}.timing.end`] ?? shown.duration)}
                    type="number"
                    min={0}
                    max={shown.duration}
                    step={1 / 30}
                    onCommit={(value) => timing('end', value)}
                  />
                </div>
                {(['color', 'backgroundColor'] as const)
                  .filter((property) => (editable.styles as readonly string[]).includes(property))
                  .map((property) => (
                    <Field
                      key={`${selected}-${property}`}
                      label={property === 'color' ? '文字颜色' : '图层颜色'}
                      value={String(
                        shown.overrides[`${selected}.style.${property}`] ??
                          selectedStyles[property] ??
                          '#ffffff',
                      )}
                      onCommit={(value) => style(property, value)}
                    />
                  ))}
                <div className="motion-pair">
                  {(['left', 'top'] as const).map((property) => (
                    <Field
                      key={`${selected}-${property}`}
                      label={property === 'left' ? '水平位置' : '垂直位置'}
                      value={String(
                        shown.overrides[`${selected}.style.${property}`] ??
                          selectedStyles[property] ??
                          '0%',
                      )}
                      onCommit={(value) => style(property, value)}
                    />
                  ))}
                </div>
                <div className="motion-pair">
                  {(['width', 'height', 'fontSize', 'opacity', 'borderRadius'] as const)
                    .filter((property) => (editable.styles as readonly string[]).includes(property))
                    .map((property) => (
                      <Field
                        key={`${selected}-${property}`}
                        label={
                          {
                            width: '宽度',
                            height: '高度',
                            fontSize: '字号（px）',
                            opacity: '透明度',
                            borderRadius: '圆角',
                          }[property]
                        }
                        value={String(
                          shown.overrides[`${selected}.style.${property}`] ??
                            selectedStyles[property] ??
                            (property === 'opacity' ? '1' : '0px'),
                        )}
                        onCommit={(value) =>
                          style(
                            property,
                            property === 'fontSize' && /^\d+(\.\d+)?$/.test(value)
                              ? `${value}px`
                              : value,
                          )
                        }
                      />
                    ))}
                </div>
                <p className="motion-footnote">
                  位置和尺寸支持 % 或 px。编辑在离开输入框时保存；撤销与画布共用。
                </p>
                <button
                  type="button"
                  className="ui-btn self-start"
                  disabled={controlsLocked || !Object.keys(shown.overrides).length}
                  onClick={() => {
                    if (!canWrite()) return
                    const current = read()
                    writeMotionEdit(engine.doc, id, () => {
                      for (const entry of Object.keys(current.overrides))
                        setParamEntry(engine.doc, id, 'overrides', entry, undefined)
                    })
                    setError(null)
                  }}
                >
                  恢复模板文案与布局
                </button>
              </fieldset>
              {shown.template !== 'title' && (
                <fieldset className="motion-section" disabled={controlsLocked}>
                  <h3>输入素材</h3>
                  <p className="motion-footnote">
                    {shownMissingInput ??
                      (shown.template === 'character'
                        ? `已连接图片 ${shownInputs.image?.slice(0, 12)}`
                        : `已连接视频 ${shownInputs.video?.slice(0, 12)}`)}
                  </p>
                  {shown.template === 'video-title' && (
                    <>
                      <div className="motion-pair">
                        <Field
                          label="素材入点（秒）"
                          value={String(shown.sourceIn)}
                          type="number"
                          min={0}
                          step={1 / 30}
                          onCommit={(value) => commit('sourceIn', Number(value))}
                        />
                        <Field
                          label="素材速度"
                          value={String(shown.speed)}
                          type="number"
                          min={0.25}
                          max={4}
                          step={0.25}
                          onCommit={(value) => commit('speed', Number(value))}
                        />
                      </div>
                      <Label label="声音">
                        <Select
                          aria-label="声音"
                          value={shown.audio}
                          options={[
                            { value: 'mute', label: '静音，由序列配音' },
                            { value: 'source', label: '保留视频原声' },
                          ]}
                          disabled={controlsLocked}
                          onChange={(value) => commit('audio', value)}
                        />
                      </Label>
                    </>
                  )}
                </fieldset>
              )}
            </aside>
          </FieldHistory.Provider>
        </FieldLock.Provider>
        <main className="motion-workspace">
          <MotionPreview
            params={frozen?.params ?? params}
            inputs={frozen?.inputs ?? inputs}
            active={!closing}
          />
          <section className="motion-candidates" aria-label="渲染候选">
            <div className="motion-candidates-header">
              <strong>渲染候选</strong>
              <span>
                {results.length
                  ? `${results.length} 个 · 采用后进入序列`
                  : '渲染后在这里回看并采用'}
              </span>
            </div>
            <div className="motion-candidate-list">
              {results.map(
                (result, index) =>
                  result.value.type === 'video' && (
                    <article
                      className="motion-candidate"
                      key={result.id}
                      data-adopted={adopted?.id === result.id}
                    >
                      <img
                        src={assetUrls.variant(result.value.assetId, 'poster')}
                        alt={`候选 ${results.length - index} 封面`}
                      />
                      <div className="motion-candidate-actions">
                        <span>
                          候选 {results.length - index}
                          {adopted?.id === result.id ? ' · 已采用' : ''}
                        </span>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            className="ui-btn ui-btn-quiet"
                            onClick={() =>
                              useCanvas.getState().view({
                                kind: 'result',
                                nodeId: id,
                                resultId: result.id,
                                name: el.name ?? '动态合成候选',
                              })
                            }
                          >
                            回看
                          </button>
                          <button
                            type="button"
                            className="ui-btn ui-btn-quiet"
                            disabled={locked || adopted?.id === result.id}
                            onClick={() => {
                              if (canWrite())
                                writeMotionEdit(engine.doc, id, () =>
                                  adoptResult(engine.doc, id, result.id),
                                )
                            }}
                          >
                            {adopted?.id === result.id ? '已采用' : '采用'}
                          </button>
                          {result.value.compositionSource && (
                            <button
                              type="button"
                              className="ui-btn ui-btn-quiet"
                              disabled={sourceLoading || closing}
                              onClick={() => void loadSource(result)}
                            >
                              查看源版本
                            </button>
                          )}
                          {result.value.compositionSource && (
                            <a
                              className="ui-btn ui-btn-quiet"
                              href={`${assetUrls.original(result.value.compositionSource.bundleAssetId)}?download=1`}
                              download
                            >
                              下载源工程
                            </a>
                          )}
                        </div>
                      </div>
                    </article>
                  ),
              )}
            </div>
          </section>
        </main>
      </div>
    </Modal>
  )
}

function Label({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="motion-field">
      <span>{label}</span>
      {children}
    </label>
  )
}

/** 草稿不进入 Yjs；离开字段一次提交，重复更新不会提交旧快照中的其他字段。 */
function Field({
  label,
  value,
  onCommit,
  multiline,
  ...input
}: {
  label: string
  value: string
  onCommit(value: string): void
  multiline?: boolean
  type?: 'number' | 'text'
  min?: number
  max?: number
  step?: number
}) {
  const locked = useContext(FieldLock)
  const history = useContext(FieldHistory)
  const [draft, setDraft] = useState(value)
  const focused = useRef(false)
  useEffect(() => {
    if (locked) focused.current = false
    if (!focused.current) setDraft(value)
  }, [value, locked])
  const common = {
    'aria-label': label,
    value: draft,
    onFocus: () => {
      focused.current = true
    },
    onChange: (event: { target: { value: string } }) => {
      focused.current = true
      setDraft(event.target.value)
    },
    onKeyDown: (event: ReactKeyboardEvent) => {
      if (
        event.isDefaultPrevented() ||
        event.nativeEvent.isComposing ||
        event.altKey ||
        !(event.metaKey || event.ctrlKey)
      )
        return
      const key = event.key.toLowerCase()
      if (key !== 'z' && key !== 'y') return
      event.preventDefault()
      event.stopPropagation()
      if (locked) return
      if (draft !== value) {
        setDraft(value)
        return
      }
      focused.current = false
      history?.(key === 'y' || event.shiftKey ? 'redo' : 'undo')
    },
    onBlur: () => {
      focused.current = false
      if (!locked && draft !== value) onCommit(draft)
    },
  }
  return (
    <Label label={label}>
      {multiline ? (
        <textarea {...common} rows={2} maxLength={1000} />
      ) : (
        <input {...input} {...common} />
      )}
    </Label>
  )
}
