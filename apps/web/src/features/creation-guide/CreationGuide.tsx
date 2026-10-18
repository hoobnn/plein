import type { Engine } from '@plein/canvas-core'
import { useRef, useState } from 'react'
import { useDocVersion } from '../../canvas/hooks'
import { useCanvas } from '../../stores/canvas'
import { Icon } from '../../ui/icons'
import { Select } from '../../ui/Select'
import { useStale } from '../runs/stale'
import { openAnimatic } from '../sequence/animatic'
import { creationGuideFacts, type GuideState, type GuideStepId, type GuideTarget } from './facts'
import { readGuidePreferences, writeGuidePreferences, type GuidePreferences } from './preferences'

const states: Record<GuideState, string> = {
  todo: '待完成',
  ready: '待操作',
  working: '进行中',
  done: '已完成',
  attention: '待检查',
  skipped: '可跳过',
}

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
}: {
  canvasId: string
  onOpenText(id: string): void
}) {
  const engine = useCanvas((s) => s.engine)
  const attachedCanvasId = useCanvas((s) => s.canvasId)
  if (!engine || attachedCanvasId !== canvasId) return null
  return <Guide engine={engine} canvasId={canvasId} onOpenText={onOpenText} />
}

function Guide({
  engine,
  canvasId,
  onOpenText,
}: {
  engine: Engine
  canvasId: string
  onOpenText(id: string): void
}) {
  useDocVersion(engine.doc)
  const sync = useCanvas((s) => s.sync)
  const stale = useStale((s) => s.nodes)
  const [preferences, setPreferences] = useState(() => readGuidePreferences(canvasId))
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
    staleIds: new Set([...stale].filter(([, kind]) => kind !== 'kept').map(([id]) => id)),
  })
  // 自由画布不出现剧本任务，也不自动创建结构或运行任何节点。
  if (!facts.boards.length) return null
  const next = facts.steps.find((step) => step.id === facts.next)
  const online = sync === 'connected'
  const readCurrent = (plan = false) => {
    const state = useCanvas.getState()
    if (state.engine !== engine || state.canvasId !== canvasId) {
      setError('画布已切换，本次操作未执行')
      return null
    }
    const current = creationGuideFacts(engine.doc, {
      ...preferencesRef.current,
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
  const locate = (stepId: GuideStepId, target: GuideTarget | undefined) => {
    const current = readCurrent()
    if (!current) return
    if (
      !target ||
      JSON.stringify(current.steps.find((step) => step.id === stepId)?.target) !==
        JSON.stringify(target)
    ) {
      setError('定位目标已变化，请核对当前步骤后重试')
      return
    }
    setError('')
    const state = useCanvas.getState()
    state.setMode('flow')
    state.openStoryboard(null)
    state.openSequence(null)
    state.openStage(null)
    state.view(null)
    engine.selection.set([target.nodeId])
    engine.zoomToFit([target.nodeId])
    if (target.kind === 'text') onOpenText(target.nodeId)
    else if (target.kind === 'storyboard') state.openStoryboard(target.nodeId)
    else if (target.kind === 'sequence') state.openSequence(target.nodeId)
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
        if (
          latest &&
          JSON.stringify(latest.steps.find((step) => step.id === stepId)?.target) ===
            JSON.stringify(target)
        )
          window.dispatchEvent(new CustomEvent('plein:focus-generator', { detail: target.nodeId }))
      })
  }
  return (
    <aside
      aria-label="创作下一步"
      className="ui-float pointer-events-auto absolute top-16 right-3 z-25 flex max-h-[calc(100%_-_150px)] w-84 max-w-[calc(100%_-_24px)] flex-col overflow-hidden rounded-xl max-sm:w-76"
      data-testid="creation-guide"
    >
      <div className="flex items-center gap-2 px-3 py-2.5">
        <Icon name="story" size={16} />
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">创作下一步</h2>
        <button
          type="button"
          className="ui-btn ui-btn-ghost ui-btn-sm ui-icon-btn"
          aria-label={preferences.collapsed ? '展开创作引导' : '收起创作引导'}
          aria-expanded={!preferences.collapsed}
          onClick={() => update({ collapsed: !preferences.collapsed })}
        >
          <Icon name={preferences.collapsed ? 'chevronDown' : 'arrowUp'} size={14} />
        </button>
      </div>
      {error && (
        <p role="alert" className="px-3 pb-2 text-xs text-danger">
          {error}
        </p>
      )}
      {preferences.collapsed ? (
        <button
          type="button"
          className="px-3 pb-3 text-left text-xs text-ink-muted"
          onClick={() => update({ collapsed: false })}
        >
          {next
            ? `下一步：${next.title}`
            : facts.board
              ? '六步均已有记录，展开可随时返回修改'
              : '选择要继续的分镜'}
          {!online ? ' · 离线，执行不可用' : ''}
        </button>
      ) : (
        <div className="ui-scrollbar flex flex-col gap-3 overflow-y-auto px-3 pb-3">
          {(facts.boards.length > 1 || !facts.board) && (
            <label className="ui-field" htmlFor={`${canvasId}-guide-board`}>
              <span className="ui-label">继续哪份分镜</span>
              <Select
                id={`${canvasId}-guide-board`}
                aria-label="创作引导分镜"
                value={facts.board?.id ?? ''}
                options={[{ value: '', label: '请选择分镜' }, ...targetOptions(facts.boards)]}
                onChange={(boardId) => {
                  // 选项移除时控件会回报当前空值；这不是用户改选，不能清掉失效身份。
                  if (boardId === (facts.board?.id ?? '')) return
                  update({ boardId, trialShotId: undefined, sequenceId: undefined })
                }}
              />
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
              {facts.shots.length > 1 && (
                <label className="ui-field" htmlFor={`${canvasId}-guide-shot`}>
                  <span className="ui-label">先试哪一镜</span>
                  <Select
                    id={`${canvasId}-guide-shot`}
                    aria-label="创作引导试做镜头"
                    value={facts.trialShot?.id ?? ''}
                    options={facts.shots.map((shot) => ({
                      value: shot.id,
                      label: `镜头 ${shot.no} · ${shot.description.slice(0, 24) || '未填写画面'}`,
                    }))}
                    onChange={(trialShotId) => update({ trialShotId })}
                  />
                </label>
              )}
              {(facts.sequences.length > 1 ||
                (preferences.sequenceId && !facts.sequence && facts.sequences.length > 0)) && (
                <label className="ui-field" htmlFor={`${canvasId}-guide-sequence`}>
                  <span className="ui-label">成片交付序列</span>
                  <Select
                    id={`${canvasId}-guide-sequence`}
                    aria-label="创作引导交付序列"
                    value={facts.sequence?.id ?? ''}
                    options={[
                      { value: '', label: '请选择成片序列' },
                      ...targetOptions(facts.sequences),
                    ]}
                    onChange={(sequenceId) => {
                      if (sequenceId !== (facts.sequence?.id ?? '')) update({ sequenceId })
                    }}
                  />
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
              {!!facts.shots.length && (
                <button
                  type="button"
                  className="ui-btn ui-btn-secondary ui-btn-sm"
                  onClick={() => {
                    const current = readCurrent(true)
                    if (!current?.board) return
                    const opened = openAnimatic(engine, current.board.id)
                    setError(
                      opened
                        ? ''
                        : engine.doc.readOnly
                          ? '画布为只读，不能创建新样片；已有样片仍可打开查看'
                          : '样片未打开，请根据通知检查后重试',
                    )
                  }}
                >
                  打开低成本分镜样片
                </button>
              )}
              <ol className="flex flex-col gap-1">
                {facts.steps.map((step, i) => (
                  <li key={step.id} data-guide-step={step.id} data-guide-state={step.state}>
                    <button
                      type="button"
                      disabled={!step.target}
                      aria-current={facts.next === step.id ? 'step' : undefined}
                      className={`flex w-full gap-2 rounded-lg p-2 text-left transition-colors hover:bg-hover disabled:opacity-60 ${facts.next === step.id ? 'bg-accent-soft' : ''}`}
                      onClick={() => locate(step.id, step.target)}
                    >
                      <span
                        className={`flex size-5 shrink-0 items-center justify-center rounded-full text-2xs ${step.state === 'done' ? 'bg-accent text-white' : 'bg-surface-2 text-ink-muted'}`}
                      >
                        {step.state === 'done' ? <Icon name="check" size={12} /> : i + 1}
                      </span>
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
                    </button>
                  </li>
                ))}
              </ol>
              {!!facts.shots.length &&
                facts.steps.find((step) => step.id === 'storyboard')?.state !== 'done' && (
                  <button
                    type="button"
                    className="ui-btn ui-btn-secondary ui-btn-sm"
                    onClick={() => {
                      const current = readCurrent(true)
                      if (current?.board && current.planSignature)
                        update({
                          reviewedPlans: {
                            ...preferencesRef.current.reviewedPlans,
                            [current.board.id]: current.planSignature,
                          },
                        })
                    }}
                  >
                    我已人工核对这份分镜（仅本机）
                  </button>
                )}
              <p className="text-2xs text-ink-subtle">
                可以跳步定位。这里只打开编辑器；付费生成仍需点击原有生成按钮。人工审片记录与任务运行状态分别显示。
              </p>
            </>
          )}
        </div>
      )}
    </aside>
  )
}
