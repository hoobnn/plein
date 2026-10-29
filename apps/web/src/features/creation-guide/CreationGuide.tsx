import { selectProductionTarget } from '@plein/doc'
import type { Engine } from '@plein/canvas-core'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDocVersion } from '../../canvas/hooks'
import { useCanvas } from '../../stores/canvas'
import { Icon } from '../../ui/icons'
import { Select } from '../../ui/Select'
import { Modal } from '../../ui/Modal'
import { Presence } from '../../ui/Presence'
import { useStale } from '../runs/stale'
import { openAnimatic } from '../sequence/animatic'
import {
  creationGuideFacts,
  type GuideFacts,
  type GuideState,
  type GuideStepId,
  type GuideTarget,
  type TrialSubstepId,
} from './facts'
import { ProductionDetails } from './ProductionDetails'
import { ProductionOverview } from './ProductionOverview'
import { useSession } from '../../stores/session'
import { readGuidePreferences, writeGuidePreferences, type GuidePreferences } from './preferences'

const states: Record<GuideState, string> = {
  todo: '未开始',
  ready: '可开始',
  working: '进行中',
  done: '已完成',
  attention: '待检查',
  skipped: '可跳过',
}

type GuideAction =
  | { kind: 'step' | 'primary'; stepId: GuideStepId; target: GuideTarget }
  | { kind: 'substep'; stepId: GuideStepId; substepId: TrialSubstepId; target: GuideTarget }

const targetOptions = (items: Array<{ id: string; name: string }>) =>
  items.map((item) => {
    let suffix = 6
    while (
      items.some(
        (other) => other.id !== item.id && other.id.slice(-suffix) === item.id.slice(-suffix),
      )
    )
      suffix++
    return {
      value: item.id,
      label: items.some((other) => other.id !== item.id && other.name === item.name)
        ? `${item.name} · ${item.id.slice(-suffix)}`
        : item.name,
    }
  })

export function CreationGuide({
  canvasId,
  onOpenText,
  presentation,
  onWidthChange,
}: {
  canvasId: string
  onOpenText(id: string): void
  presentation: 'floating' | 'modal'
  onWidthChange?(width: number): void
}) {
  const engine = useCanvas((s) => s.engine)
  const attachedCanvasId = useCanvas((s) => s.canvasId)
  if (!engine || attachedCanvasId !== canvasId) return null
  return (
    <Guide
      key={canvasId}
      engine={engine}
      canvasId={canvasId}
      onOpenText={onOpenText}
      presentation={presentation}
      onWidthChange={onWidthChange}
    />
  )
}

function Guide({
  engine,
  canvasId,
  onOpenText,
  presentation,
  onWidthChange,
}: {
  engine: Engine
  canvasId: string
  onOpenText(id: string): void
  presentation: 'floating' | 'modal'
  onWidthChange?(width: number): void
}) {
  useDocVersion(engine.doc)
  const sync = useCanvas((s) => s.sync)
  const principal = useSession((s) => s.info?.principal)
  const writable = !engine.doc.readOnly && !!principal && principal.role !== 'viewer'
  const canWrite = () => {
    const current = useSession.getState().info?.principal
    return !engine.doc.readOnly && !!current && current.role !== 'viewer'
  }
  const stale = useStale((s) => s.nodes)
  const [preferences, setPreferences] = useState(() => readGuidePreferences(canvasId))
  const [entryHost, setEntryHost] = useState<HTMLElement | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  useEffect(() => {
    setEntryHost(document.getElementById('plein-creation-guide-entry'))
  }, [])
  useEffect(() => {
    if (presentation === 'floating') setModalOpen(false)
  }, [presentation])
  const preferencesRef = useRef(preferences)
  preferencesRef.current = preferences
  const [error, setError] = useState('')
  const update = (patch: Partial<GuidePreferences>) => {
    const next = { ...preferencesRef.current, ...patch }
    preferencesRef.current = next
    writeGuidePreferences(canvasId, next)
    setPreferences(next)
    setError('')
  }
  const facts = creationGuideFacts(engine.doc, {
    ...preferences,
    canvasId,
    staleIds: new Set([...stale].filter(([, kind]) => kind !== 'kept').map(([id]) => id)),
  })
  const floating = presentation === 'floating' && !preferences.collapsed && facts.boards.length > 0
  useEffect(() => {
    onWidthChange?.(floating ? 360 : 0)
    return () => onWidthChange?.(0)
  }, [floating, onWidthChange])
  useEffect(() => {
    if (!facts.boards.length) setModalOpen(false)
  }, [facts.boards.length])
  // 自由画布不出现剧本任务，也不自动创建结构或运行任何节点。
  if (!facts.boards.length) return null
  const next = facts.steps.find((step) => step.id === facts.next)
  const boardListKey = JSON.stringify(facts.boards.map((board) => board.id))
  const sequenceListKey = JSON.stringify([facts.board?.id, facts.sequences.map((item) => item.id)])
  const shotListKey = JSON.stringify(facts.shots.map((shot) => shot.id))
  const online = sync === 'connected'
  const readCurrent = (plan = false) => {
    const state = useCanvas.getState()
    if (state.engine !== engine || state.canvasId !== canvasId) {
      setError('画布已切换，本次操作未执行')
      return null
    }
    const current = creationGuideFacts(engine.doc, {
      ...preferencesRef.current,
      canvasId,
      staleIds: new Set(
        [...useStale.getState().nodes].filter(([, kind]) => kind !== 'kept').map(([id]) => id),
      ),
    })
    if (!current.board || current.board.id !== facts.board?.id) {
      setError('分镜选择已变化，请重新选择后继续')
      return null
    }
    if (plan && current.planSignature !== facts.planSignature) {
      setError('分镜计划已变化，请核对新计划后重试')
      return null
    }
    return current
  }
  const actionTarget = (current: GuideFacts, action: GuideAction) => {
    const step = current.steps.find((entry) => entry.id === action.stepId)
    if (action.kind === 'primary') return step?.primary?.target
    if (action.kind === 'substep')
      return step?.substeps?.find((entry) => entry.id === action.substepId)?.target
    return step?.target
  }
  const focusSelect = (suffix: 'shot' | 'sequence') => {
    const trigger = document.getElementById(`${canvasId}-guide-${suffix}`)
    trigger?.scrollIntoView({ block: 'nearest' })
    trigger?.focus()
  }
  const runAction = (action: GuideAction) => {
    const current = readCurrent()
    if (!current) return
    if (JSON.stringify(actionTarget(current, action)) !== JSON.stringify(action.target)) {
      setError('定位目标已变化，请核对当前步骤后重试')
      return
    }
    setError('')
    const target = action.target
    // 选择控件在本面板里，定位到它而不是关闭面板。
    if (target.kind === 'shot-select' || target.kind === 'sequence-select') {
      focusSelect(target.kind === 'shot-select' ? 'shot' : 'sequence')
      return
    }
    // 样片可能因只读或素材问题打不开；失败时保留面板显示原因。
    if (target.kind === 'animatic') {
      if (!openAnimatic(engine, target.nodeId)) {
        setError(
          engine.doc.readOnly
            ? '画布为只读，不能创建新样片；已有样片仍可打开查看'
            : '样片未打开，请根据通知检查后重试',
        )
        return
      }
      setModalOpen(false)
      engine.selection.set([target.nodeId])
      engine.zoomToFit([target.nodeId])
      return
    }
    setModalOpen(false)
    const state = useCanvas.getState()
    state.setMode('flow')
    state.openStoryboard(null)
    state.openSequence(null)
    state.openShotWorkbench(null)
    state.openStage(null)
    state.view(null)
    engine.selection.set([target.nodeId])
    engine.zoomToFit([target.nodeId])
    if (target.kind === 'text') onOpenText(target.nodeId)
    else if (target.kind === 'storyboard') state.openStoryboard(target.nodeId)
    else if (target.kind === 'sequence') state.openSequence(target.nodeId, target.clipInstanceId)
    else if (target.kind === 'workbench' && target.shotId)
      state.openShotWorkbench({ boardId: target.nodeId, shotId: target.shotId })
    else if (target.kind === 'review' && target.resultId)
      state.view({
        kind: 'result',
        name: engine.doc.get(target.nodeId)?.name ?? '候选审片',
        nodeId: target.nodeId,
        resultId: target.resultId,
      })
    else
      requestAnimationFrame(() => {
        const latest = readCurrent()
        if (latest && JSON.stringify(actionTarget(latest, action)) === JSON.stringify(target))
          window.dispatchEvent(new CustomEvent('plein:focus-generator', { detail: target.nodeId }))
      })
  }
  const panel = (
    <aside
      aria-label="创作下一步"
      className={
        presentation === 'modal'
          ? 'flex min-h-0 w-full flex-1 flex-col overflow-hidden'
          : 'ui-float pointer-events-auto absolute top-16 right-3 z-25 flex max-h-[calc(100%_-_150px)] w-84 max-w-[calc(100%_-_24px)] flex-col overflow-hidden rounded-xl'
      }
      data-testid="creation-guide"
    >
      <div className="flex items-center gap-2 px-3 py-2.5">
        <Icon name="story" size={16} />
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">创作下一步</h2>
        <button
          type="button"
          className="ui-btn ui-btn-ghost ui-btn-sm ui-icon-btn"
          aria-label="收起创作引导"
          aria-expanded
          onClick={() =>
            presentation === 'modal' ? setModalOpen(false) : update({ collapsed: true })
          }
        >
          <Icon name={presentation === 'modal' ? 'x' : 'arrowUp'} size={14} />
        </button>
      </div>
      {error && (
        <p role="alert" className="px-3 pb-2 text-xs text-danger">
          {error}
        </p>
      )}
      <div className="ui-scrollbar flex min-h-0 flex-col gap-3 overflow-y-auto px-3 pb-3 [&>*]:shrink-0">
        {(facts.boards.length > 1 || !facts.board) && (
          <label className="ui-field" htmlFor={`${canvasId}-guide-board`}>
            <span className="ui-label">继续哪份分镜</span>
            <Select
              key={boardListKey}
              id={`${canvasId}-guide-board`}
              aria-label="创作引导分镜"
              value={facts.board?.id ?? ''}
              options={[{ value: '', label: '请选择分镜' }, ...targetOptions(facts.boards)]}
              onChange={(boardId) => {
                const state = useCanvas.getState()
                if (state.engine !== engine || state.canvasId !== canvasId) return
                const latest = creationGuideFacts(engine.doc, {
                  ...preferencesRef.current,
                  canvasId,
                })
                if (JSON.stringify(latest.boards.map((board) => board.id)) !== boardListKey) return
                // 列表变更时保留失效身份，不接受旧实例恢复初始值或清空选择。
                if (!boardId || boardId === facts.board?.id) return
                update({ boardId, trialShotId: undefined, sequenceId: undefined })
              }}
            />
            <span className="ui-help">画布上有多份分镜，先选定要继续的那份。</span>
          </label>
        )}
        {!facts.board ? (
          <p className="text-xs text-ink-subtle">
            {preferences.boardId
              ? '原分镜选择已失效，请重新选择后继续。'
              : '画布有多份分镜，选定后再显示对应进度。'}
          </p>
        ) : (
          <>
            {facts.boards.length === 1 && (
              <p className="truncate text-xs text-ink-subtle">{facts.board.name ?? '分镜'}</p>
            )}
            {(facts.shots.length > 1 ||
              ((facts.board.production?.selection?.trialShotId ?? preferences.trialShotId) &&
                !facts.trialShot)) && (
              <label className="ui-field" htmlFor={`${canvasId}-guide-shot`}>
                <span className="ui-label">先试哪一镜</span>
                <Select
                  key={shotListKey}
                  id={`${canvasId}-guide-shot`}
                  aria-label="创作引导试做镜头"
                  disabled={!facts.shots.length || !writable}
                  value={facts.trialShot?.id ?? ''}
                  options={[
                    { value: '', label: '请选择试做镜头' },
                    ...facts.shots.map((shot) => ({
                      value: shot.id,
                      label: `镜头 ${shot.no} · ${shot.description.slice(0, 24) || '未填写画面'}`,
                    })),
                  ]}
                  onChange={(trialShotId) => {
                    // 控件记住挂载时的初始值；列表变更后重建，并拒绝旧列表的迟到回调。
                    const state = useCanvas.getState()
                    if (state.engine !== engine || state.canvasId !== canvasId) return
                    const latest = creationGuideFacts(engine.doc, {
                      ...preferencesRef.current,
                      canvasId,
                    })
                    if (
                      latest.board?.id !== facts.board?.id ||
                      JSON.stringify(latest.shots.map((shot) => shot.id)) !== shotListKey
                    )
                      return
                    if (
                      canWrite() &&
                      trialShotId &&
                      trialShotId !== facts.trialShot?.id &&
                      latest.board
                    )
                      selectProductionTarget(engine.doc, latest.board.id, { trialShotId })
                  }}
                />
                <span className="ui-help">试做只针对这一镜，先定它再看进度。</span>
              </label>
            )}
            {(facts.sequences.length > 1 ||
              ((facts.board.production?.selection?.sequenceId ?? preferences.sequenceId) &&
                !facts.sequence &&
                facts.sequences.length > 0)) && (
              <label className="ui-field" htmlFor={`${canvasId}-guide-sequence`}>
                <span className="ui-label">成片交付序列</span>
                <Select
                  key={sequenceListKey}
                  id={`${canvasId}-guide-sequence`}
                  aria-label="创作引导交付序列"
                  disabled={!writable}
                  value={facts.sequence?.id ?? ''}
                  options={[
                    { value: '', label: '请选择成片序列' },
                    ...targetOptions(facts.sequences),
                  ]}
                  onChange={(sequenceId) => {
                    const state = useCanvas.getState()
                    if (state.engine !== engine || state.canvasId !== canvasId) return
                    const latest = creationGuideFacts(engine.doc, {
                      ...preferencesRef.current,
                      canvasId,
                    })
                    if (
                      JSON.stringify([
                        latest.board?.id,
                        latest.sequences.map((item) => item.id),
                      ]) !== sequenceListKey
                    )
                      return
                    if (
                      canWrite() &&
                      sequenceId &&
                      sequenceId !== facts.sequence?.id &&
                      latest.board
                    )
                      selectProductionTarget(engine.doc, latest.board.id, { sequenceId })
                  }}
                />
                <span className="ui-help">有多条成片序列时，先选定这次交付到哪条。</span>
              </label>
            )}
            {!online && (
              <p
                role="status"
                className="rounded-md bg-surface-2 px-2 py-1.5 text-xs text-ink-muted"
              >
                {sync === 'cached' || sync === 'connecting' || sync === 'syncing'
                  ? '等待服务端同步，执行暂不可用'
                  : '离线：可以查看和修改，生成与导出执行不可用'}
              </p>
            )}
            <ol className="flex flex-col gap-1">
              {facts.steps.map((step, i) => {
                const current = facts.next === step.id
                const marker = (
                  <span
                    className={`flex size-5 shrink-0 items-center justify-center rounded-full text-2xs ${step.state === 'done' ? 'bg-accent text-white' : 'bg-surface-2 text-ink-muted'}`}
                  >
                    {step.state === 'done' ? <Icon name="check" size={12} /> : i + 1}
                  </span>
                )
                const body = (
                  <>
                    {marker}
                    <span className="min-w-0 flex-1">
                      <span className="flex justify-between gap-2 text-xs">
                        <span className="font-medium">{step.title}</span>
                        <span
                          className={
                            step.state === 'attention' ? 'text-warning' : 'text-ink-subtle'
                          }
                        >
                          {states[step.state]}
                        </span>
                      </span>
                      <span className="mt-1 block text-2xs leading-relaxed text-ink-subtle">
                        {step.detail}
                      </span>
                    </span>
                  </>
                )
                return (
                  <li key={step.id} data-guide-step={step.id} data-guide-state={step.state}>
                    <div
                      className={`rounded-lg p-2 ${current ? 'bg-accent-soft' : ''}`}
                      aria-current={current ? 'step' : undefined}
                    >
                      {current ? (
                        <div className="flex gap-2">{body}</div>
                      ) : (
                        <button
                          type="button"
                          className="flex w-full gap-2 rounded text-left hover:bg-hover disabled:opacity-60"
                          title={`定位到${step.title}`}
                          disabled={!step.target}
                          onClick={() =>
                            step.target &&
                            runAction({ kind: 'step', stepId: step.id, target: step.target })
                          }
                        >
                          {body}
                        </button>
                      )}
                      {current && step.primary && (
                        <button
                          type="button"
                          className="ui-btn ui-btn-primary ui-btn-sm mt-2 w-full"
                          onClick={() =>
                            runAction({
                              kind: 'primary',
                              stepId: step.id,
                              target: step.primary!.target,
                            })
                          }
                        >
                          {step.primary.label}
                        </button>
                      )}
                      {step.id === 'trial' && step.substeps && (
                        <ol className="mt-2 flex flex-col gap-1 border-l border-line pl-2">
                          {step.substeps.map((sub) => (
                            <li
                              key={sub.id}
                              data-guide-substep={sub.id}
                              data-guide-state={sub.state}
                            >
                              <button
                                type="button"
                                className="flex w-full gap-1.5 rounded px-1 py-0.5 text-left text-2xs hover:bg-hover disabled:opacity-50"
                                disabled={!sub.target}
                                onClick={() =>
                                  sub.target &&
                                  runAction({
                                    kind: 'substep',
                                    stepId: step.id,
                                    substepId: sub.id,
                                    target: sub.target,
                                  })
                                }
                              >
                                <span
                                  className={`mt-0.5 flex size-3 shrink-0 items-center justify-center rounded-full ${sub.state === 'done' ? 'bg-accent text-white' : 'bg-surface-2 text-ink-muted'}`}
                                >
                                  {sub.state === 'done' && <Icon name="check" size={12} />}
                                </span>
                                <span className="min-w-0 flex-1">
                                  <span className="flex justify-between gap-2">
                                    <span>{sub.title}</span>
                                    <span className="shrink-0 text-ink-subtle">
                                      {states[sub.state]}
                                    </span>
                                  </span>
                                  <span className="block text-ink-subtle">{sub.detail}</span>
                                </span>
                              </button>
                            </li>
                          ))}
                        </ol>
                      )}
                    </div>
                  </li>
                )
              })}
            </ol>
            <ProductionOverview
              engine={engine}
              canvasId={canvasId}
              facts={facts}
              writable={writable}
              readCurrent={() => readCurrent()}
              onError={setError}
            />
            <ProductionDetails
              key={facts.board.id}
              doc={engine.doc}
              canvasId={canvasId}
              board={facts.board}
              writable={writable}
              readCurrent={() => readCurrent(true)}
              onError={setError}
            />
          </>
        )}
      </div>
    </aside>
  )
  const open = presentation === 'modal' ? modalOpen : !preferences.collapsed
  const entry =
    entryHost &&
    createPortal(
      <button
        type="button"
        className="ui-bar-btn"
        aria-label={open ? '收起创作引导' : '展开创作引导'}
        aria-expanded={open}
        title={next ? `创作下一步：${next.title}` : '创作下一步'}
        onClick={() =>
          presentation === 'modal'
            ? setModalOpen(!modalOpen)
            : update({ collapsed: !preferences.collapsed })
        }
      >
        <Icon name="story" size={16} />
      </button>,
      entryHost,
    )
  if (presentation === 'modal')
    return (
      <>
        {entry}
        <Presence>
          {modalOpen && (
            <Modal
              label="创作下一步"
              onClose={() => setModalOpen(false)}
              isolateKeys
              className="h-full max-w-sm"
            >
              {panel}
            </Modal>
          )}
        </Presence>
      </>
    )
  return (
    <>
      {entry}
      {!preferences.collapsed && panel}
    </>
  )
}
