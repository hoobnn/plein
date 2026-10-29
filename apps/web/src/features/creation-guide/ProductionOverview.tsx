import type { Engine } from '@plein/canvas-core'
import { currentResult, productionGoalHeads } from '@plein/doc'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../api/client'
import { useCanvas } from '../../stores/canvas'
import { useStale } from '../runs/stale'
import type { GuideFacts } from './facts'
import { ProductionGoalEditor } from './ProductionGoalEditor'
import { goalDurationState, goalScopeOf } from './productionGoalScope'
import { ProductionGoalSummary, requirementLabels } from './ProductionGoalSummary'
import { ProductionCanvasIndex } from './ProductionCanvasIndex'
import { overviewNodes, productionOverviewFacts, type OverviewIssue } from './overviewFacts'
import { ShotSegmentReferences } from '../storyboard/ShotSegmentReferences'

export function ProductionOverview({
  engine,
  canvasId,
  facts,
  writable,
  readCurrent,
  onError,
}: {
  engine: Engine
  canvasId: string
  facts: GuideFacts
  writable: boolean
  readCurrent(): GuideFacts | null
  onError(message: string): void
}) {
  const stale = useStale((s) => s.nodes)
  const [tasksChecked, setTasksChecked] = useState(false)
  const [manualCheck, setManualCheck] = useState(false)
  const nodeIds = [
    ...overviewNodes(engine.doc, facts).map((el) => el.id),
    ...(facts.sequence ? [facts.sequence.id] : []),
  ].sort()
  const jobs = useQuery({
    queryKey: ['canvases', canvasId, 'production-jobs', nodeIds],
    queryFn: () => api.canvasNodeJobs(canvasId, nodeIds),
    enabled: tasksChecked && nodeIds.length > 0,
    staleTime: 0,
    refetchInterval: tasksChecked && nodeIds.length ? 5000 : false,
  })
  const overview = productionOverviewFacts(engine.doc, facts, { stale, jobs: jobs.data?.jobs })
  const scope = goalScopeOf(facts, canvasId)
  const heads = scope ? productionGoalHeads(facts.board, scope) : []
  const revision = heads.length === 1 ? heads[0] : undefined
  const duration = scope
    ? goalDurationState(heads, overview.planDuration)
    : ({ state: 'unscoped' } as const)
  // 只有首次读取或手动检查才显示读取中；后台定时刷新保持上次结果。
  const tasksKnown = nodeIds.length === 0 || (tasksChecked && jobs.isSuccess && !manualCheck)
  const localIssueCount = overview.issues.filter((issue) => !issue.task).length
  const tasksLoading = manualCheck && nodeIds.length > 0
  const deliveryMeta = overview.delivery
    ? `${overview.delivery.duration.toFixed(1)} 秒 · ${overview.delivery.width}×${overview.delivery.height}`
    : ''
  const checkTasks = () => {
    setManualCheck(true)
    if (!tasksChecked) setTasksChecked(true)
    void jobs.refetch().finally(() => setManualCheck(false))
  }
  const required = revision
    ? Object.entries(requirementLabels)
        .filter(([key]) => revision.content[key as keyof typeof requirementLabels] === 'required')
        .map(([, label]) => label)
    : []
  const goalBrief = revision
    ? `${revision.content.aspectRatio ?? '画幅未约定'} · ${
        revision.content.resolution ?? '分辨率未约定'
      } · ${revision.content.duration ? `${revision.content.duration.min ?? '不限'} 至 ${revision.content.duration.max ?? '不限'} 秒` : '时长未约定'} · ${
        required.length ? `需要${required.join('、')}` : '无必须项'
      }${revision.content.requirements ? ' · 有文字要求' : ''}`
    : heads.length > 1
      ? '目标有并发修订待选定'
      : scope
        ? '尚未保存这个范围的制作目标'
        : '交付序列尚未明确'
  const durationBrief =
    duration.state === 'within' || duration.state === 'short' || duration.state === 'long'
      ? `计划 ${overview.planDuration.toFixed(1)} 秒 / 目标 ${duration.min ?? '不限'}–${duration.max ?? '不限'} 秒（${
          duration.state === 'within' ? '范围内' : duration.state === 'short' ? '偏短' : '偏长'
        }）`
      : duration.state === 'missing'
        ? `计划 ${overview.planDuration.toFixed(1)} 秒 / 未保存目标`
        : duration.state === 'concurrent'
          ? `计划 ${overview.planDuration.toFixed(1)} 秒 / 目标有并发修订`
          : duration.state === 'unbounded'
            ? `计划 ${overview.planDuration.toFixed(1)} 秒 / 目标未限定时长`
            : `计划 ${overview.planDuration.toFixed(1)} 秒 / 交付序列未明确`
  const locate = (issue: OverviewIssue) => {
    const current = readCurrent()
    if (!current) return
    const currentIssues = productionOverviewFacts(engine.doc, current, {
      stale: useStale.getState().nodes,
      jobs: jobs.data?.jobs,
    }).issues
    const target = issue.target
    const state = useCanvas.getState()
    if (
      state.engine !== engine ||
      state.canvasId !== canvasId ||
      !target ||
      !currentIssues.some(
        (next) => next.id === issue.id && JSON.stringify(next.target) === JSON.stringify(target),
      ) ||
      !engine.doc.has(target.nodeId) ||
      (target.kind === 'review' &&
        currentResult(engine.doc.get(target.nodeId)!)?.id !== target.resultId)
    ) {
      onError('总览目标已变化，请核对当前状态后重试')
      return
    }
    onError('')
    engine.selection.set([target.nodeId])
    engine.zoomToFit([target.nodeId])
    if (issue.task) state.toggleTasks(true)
    else if (target.kind === 'review' && target.resultId)
      state.view({
        kind: 'result',
        name: engine.doc.get(target.nodeId)?.name ?? '候选审片',
        nodeId: target.nodeId,
        resultId: target.resultId,
      })
    else if (target.kind === 'storyboard') state.openStoryboard(target.nodeId)
    else if (target.kind === 'sequence') state.openSequence(target.nodeId, target.clipInstanceId)
    else window.dispatchEvent(new CustomEvent('plein:focus-generator', { detail: target.nodeId }))
  }
  return (
    <section
      aria-label="制作总览"
      className="flex flex-col gap-2 border-t border-line pt-2 text-2xs"
      data-testid="production-overview"
    >
      <h3 className="font-medium">制作总览</h3>
      <p className="break-words text-ink-subtle">
        范围：{facts.board?.name ?? '分镜'} / {facts.sequence?.name ?? '未选序列'} ·{' '}
        {facts.shots.length} 镜
      </p>
      <p className="break-words" title={revision?.content.requirements || undefined}>
        目标：{goalBrief}
      </p>
      <p className="break-words">时长：{durationBrief}</p>
      <p className="break-words">
        交付：
        {overview.delivered
          ? `当前成片已确认${deliveryMeta ? ` · ${deliveryMeta}` : ''}`
          : facts.sequence
            ? `当前成片未确认${deliveryMeta ? ` · 实际 ${deliveryMeta}` : ''}`
            : '尚未选择成片序列'}
      </p>
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-2">
          <h4 className="font-medium">
            阻塞、待审与任务（
            {tasksKnown ? overview.issues.length : `本地 ${localIssueCount}`}）
          </h4>
          {!!nodeIds.length && (
            <button
              type="button"
              className="shrink-0 underline"
              disabled={manualCheck}
              onClick={checkTasks}
            >
              {tasksChecked ? '刷新任务' : '检查任务'}
            </button>
          )}
        </div>
        {!!nodeIds.length && !tasksChecked && !manualCheck && <p role="status">任务尚未检查</p>}
        {tasksLoading && <p role="status">正在读取任务</p>}
        {jobs.error && !manualCheck && (
          <p role="status">
            任务读取失败（重试）：{jobs.error.message}{' '}
            <button type="button" className="underline" onClick={checkTasks}>
              重试
            </button>
          </p>
        )}
        <ul aria-label="制作待处理事项" className="flex flex-col gap-1">
          {overview.issues.map((issue) => (
            <li key={issue.id}>
              <button
                type="button"
                className="w-full rounded p-1 text-left hover:bg-hover disabled:opacity-70"
                disabled={!issue.target}
                onClick={() => locate(issue)}
              >
                {issue.message}
                {issue.target ? ' · 定位' : ''}
              </button>
            </li>
          ))}
        </ul>
        {!overview.issues.length && tasksKnown && <p>当前未发现待处理事项。</p>}
      </div>
      <div className="grid grid-cols-2 gap-1" aria-label="制作事实统计">
        <span>
          已有产物 {overview.produced}/{overview.total} 节点
        </span>
        <span>
          已采用 {overview.adopted}/{overview.total} 节点
        </span>
        <span>
          人工可用 {overview.usable}/{overview.total} 节点
        </span>
        <span>已交付 {overview.delivered ? '当前成片已确认' : '未确认当前成片'}</span>
        <span>进行中 {overview.working} 节点</span>
        <span>旧输入／已保留 {overview.stale} 节点</span>
      </div>
      {overview.sequenceWorking && <p role="status">选定成片序列的导出任务进行中。</p>}
      {!overview.total && <p className="text-ink-subtle">尚未展开当前分镜的生成节点。</p>}
      {facts.board && facts.trialShot && (
        <ShotSegmentReferences
          key={`${facts.board.id}/${facts.trialShot.id}/${facts.sequence?.id ?? ''}`}
          engine={engine}
          canvasId={canvasId}
          boardId={facts.board.id}
          shotId={facts.trialShot.id}
          sequenceId={facts.sequence?.id}
          isCurrent={() => {
            const current = readCurrent()
            return (
              !!current &&
              current.board?.id === facts.board?.id &&
              current.trialShot?.id === facts.trialShot?.id &&
              current.sequence?.id === facts.sequence?.id
            )
          }}
        />
      )}
      {scope && (
        <ProductionGoalEditor
          key={JSON.stringify(scope)}
          doc={engine.doc}
          scope={scope}
          heads={heads}
          writable={writable}
          readCurrent={readCurrent}
          onError={onError}
        />
      )}
      {!!facts.board?.production?.goals?.length && (
        <details>
          <summary className="cursor-pointer">
            制作目标历史（{facts.board.production.goals.length}）
          </summary>
          <ul aria-label="制作目标历史" className="mt-2 flex flex-col gap-2">
            {facts.board.production.goals.map((record) => (
              <li key={record.id} className="rounded border border-line p-2">
                <p className="text-ink-subtle">
                  {record.id === revision?.id
                    ? '当前目标'
                    : heads.some((r) => r.id === record.id)
                      ? '并发修订待核对'
                      : '历史目标'}{' '}
                  · {record.actor.userId} · {new Date(record.at).toLocaleString()}
                </p>
                <p className="break-all text-ink-subtle">
                  范围 {record.scope.canvasId} / {record.scope.boardId} /{' '}
                  {record.scope.sequenceId ?? '分镜目标'}
                  {record.historical ? '（历史范围，不作为当前目标）' : ''}
                </p>
                <ProductionGoalSummary revision={record} />
              </li>
            ))}
          </ul>
        </details>
      )}
      <details>
        <summary className="cursor-pointer">说明</summary>
        <div className="mt-2 flex flex-col gap-1 text-ink-subtle">
          {revision && <ProductionGoalSummary revision={revision} />}
          <p>
            目标修订不表示已有候选、分镜核对或交付满足新目标；以下人工可用与交付状态仍对应各自原版本。文字要求需人工审看；技术检查在成片审阅中单独执行。
          </p>
          <p>
            影响范围：当前分镜全部 {facts.shots.length} 镜{facts.sequence ? '及选定成片序列' : ''}
            ；保存目标不自动更新或生成。
          </p>
          <p>
            代表镜头：
            {facts.trialShot
              ? `镜头 ${facts.trialShot.no} · ${facts.trialShot.description}`
              : '原选择已移除，请重新选择'}
          </p>
          {overview.sequenceSettings && (
            <p>
              当前序列设置：{overview.sequenceSettings.aspectRatio} ·{' '}
              {overview.sequenceSettings.resolution} ·{' '}
              {overview.sequenceSettings.subtitles ? '开启字幕' : '关闭字幕'}
              {revision &&
              ((revision.content.aspectRatio &&
                revision.content.aspectRatio !== overview.sequenceSettings.aspectRatio) ||
                (revision.content.resolution &&
                  revision.content.resolution !== overview.sequenceSettings.resolution) ||
                (revision.content.subtitles === 'required' &&
                  !overview.sequenceSettings.subtitles) ||
                (revision.content.subtitles === 'none' && overview.sequenceSettings.subtitles))
                ? '；规格或字幕设置与目标不同，请到序列中核对。'
                : '；实际文件与其余制作要求仍需核对。'}
            </p>
          )}
          <p>这里只打开编辑器；付费生成仍需点击原有生成按钮。</p>
        </div>
      </details>
      <ProductionCanvasIndex canvasId={canvasId} />
    </section>
  )
}
