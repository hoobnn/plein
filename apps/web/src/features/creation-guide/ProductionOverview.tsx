import type { Engine } from '@plein/canvas-core'
import { currentResult, productionGoalHeads } from '@plein/doc'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../api/client'
import { useCanvas } from '../../stores/canvas'
import { useStale } from '../runs/stale'
import type { GuideFacts } from './facts'
import { ProductionGoalEditor } from './ProductionGoalEditor'
import { goalScopeOf } from './productionGoalScope'
import { ProductionGoalSummary } from './ProductionGoalSummary'
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
  const [expanded, setExpanded] = useState(false)
  const nodeIds = [
    ...overviewNodes(engine.doc, facts).map((el) => el.id),
    ...(facts.sequence ? [facts.sequence.id] : []),
  ].sort()
  const jobs = useQuery({
    queryKey: ['canvases', canvasId, 'production-jobs', nodeIds],
    queryFn: () => api.canvasNodeJobs(canvasId, nodeIds),
    enabled: expanded && nodeIds.length > 0,
    staleTime: 0,
    refetchInterval: expanded ? 5000 : false,
  })
  const overview = productionOverviewFacts(engine.doc, facts, { stale, jobs: jobs.data?.jobs })
  const scope = goalScopeOf(facts, canvasId)
  const heads = scope ? productionGoalHeads(facts.board, scope) : []
  const revision = heads.length === 1 ? heads[0] : undefined
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
      aria-label="制作目标与总览"
      className="flex flex-col gap-2 border-t border-line pt-2 text-2xs"
      data-testid="production-overview"
    >
      <h3 className="font-medium">制作目标与总览</h3>
      <p className="break-words text-ink-subtle">
        范围：{facts.board?.name ?? '分镜'} /{' '}
        {facts.sequence?.name ?? (scope ? '尚未指定成片序列' : '请先明确成片序列')} ·{' '}
        {facts.shots.length} 镜
      </p>
      {revision ? (
        <ProductionGoalSummary revision={revision} />
      ) : (
        <p role="status" className="text-ink-muted">
          {heads.length > 1
            ? '目标存在并发修订，尚未选定当前版本。'
            : scope
              ? '尚未保存这个范围的制作目标。'
              : '交付序列尚未明确，不能将其他序列的目标用于当前范围。'}
        </p>
      )}
      <p className="text-ink-subtle">
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
      {facts.board && facts.trialShot && (
        <button
          type="button"
          className="ui-btn ui-btn-secondary ui-btn-xs"
          onClick={() => {
            const current = readCurrent()
            if (
              current?.board &&
              current.trialShot &&
              current.board.id === facts.board?.id &&
              current.trialShot.id === facts.trialShot?.id
            )
              useCanvas
                .getState()
                .openShotWorkbench({ boardId: current.board.id, shotId: current.trialShot.id })
          }}
        >
          代表镜头工作台
        </button>
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
      {!overview.total && (
        <p className="text-ink-subtle">尚未展开当前分镜的生成节点；零节点不表示制作完成。</p>
      )}
      <p>
        分镜计划时长 {overview.planDuration.toFixed(1)} 秒；当前实际成片
        {overview.delivery
          ? ` ${overview.delivery.duration.toFixed(1)} 秒 · ${overview.delivery.width}×${overview.delivery.height}`
          : ' 未读取到绑定当前版本的交付记录'}
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
            (revision.content.subtitles === 'required' && !overview.sequenceSettings.subtitles) ||
            (revision.content.subtitles === 'none' && overview.sequenceSettings.subtitles))
            ? '；规格或字幕设置与目标不同，请到序列中核对。'
            : '；实际文件与其余制作要求仍需核对。'}
        </p>
      )}
      <details open={expanded} onToggle={(e) => setExpanded(e.currentTarget.open)}>
        <summary className="cursor-pointer font-medium">
          阻塞、待审与任务（{overview.issues.length}）
        </summary>
        <div className="mt-2 flex flex-col gap-2">
          {expanded && nodeIds.length > 0 && jobs.isPending && (
            <p role="status">正在读取最新任务，恢复状态尚未知。</p>
          )}
          {jobs.error && (
            <p role="status">
              任务读取失败：{jobs.error.message}{' '}
              <button type="button" className="underline" onClick={() => void jobs.refetch()}>
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
          {!overview.issues.length && <p>当前未发现待处理事项；尚未检查的要求保持待核对。</p>}
        </div>
      </details>
      <p>
        下一步：
        {facts.steps.find((step) => step.id === facts.next)?.title ?? '核对实际成片及交付要求'}
        。使用下方现有步骤入口继续。
      </p>
      <ProductionCanvasIndex canvasId={canvasId} />
    </section>
  )
}
