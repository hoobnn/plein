import type { Engine } from '@plein/canvas-core'
import {
  creativeReviewTarget,
  currentResult,
  type CanvasElement,
  type CreativeReviewStatus,
} from '@plein/doc'
import type { Shot, ShotRole } from '@plein/nodes'
import type { JobInfo } from '@plein/protocol'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { api, assetUrls } from '../../api/client'
import { queryKeys } from '../../api/query'
import { upstreams } from '../../canvas/nodes'
import { useDocVersion } from '../../canvas/hooks'
import { describeFailure, openProviderSettings } from '../../canvas/runStatus'
import { useCanvas } from '../../stores/canvas'
import { useCatalog } from '../../stores/catalog'
import { Select } from '../../ui/Select'
import { cancelNode, runNode } from '../runs/run'
import { cancelRequestKey, useCancelRequests } from '../runs/cancelRequests'
import { runRequestKey, useRunRequests } from '../runs/runRequests'
import { describeRecovery } from '../runs/recovery'
import { RecoveryBlock } from '../runs/Tasks'
import { expandedNodes, type ShotSource } from './model'
import { CreativeReviewForm, reviewLabels } from './CreativeReviewForm'
import { nextPendingShot, reviewNodesForShot, shotReviewStatus } from './reviewModel'
import { ShotContinuityReview } from './ShotContinuityReview'
import { useStale } from '../runs/stale'

const roles: Array<{ role: ShotRole; label: string }> = [
  { role: 'image', label: '分镜图' },
  { role: 'video', label: '视频' },
  { role: 'speech', label: '配音' },
  { role: 'sfx', label: '音效' },
]

export function StoryboardReview({
  engine,
  boardId,
  shots,
  picked,
  onPick,
}: {
  engine: Engine
  boardId: string
  shots: Shot[]
  picked: ReadonlySet<string>
  onPick(id: string, on: boolean): void
}) {
  useDocVersion(engine.doc)
  const canvasId = useCanvas((s) => s.canvasId)
  const catalog = useCatalog((s) => s.catalog)
  const stale = useStale((s) => s.nodes)
  const [filter, setFilter] = useState<'all' | CreativeReviewStatus>('all')
  const [focused, setFocused] = useState<string>()
  const [pair, setPair] = useState<{ before: string; after: string }>()
  const rows = useRef(new Map<string, HTMLTableRowElement>())
  const groups = expandedNodes(engine, boardId)
  const shotIndex = new Map(shots.map((shot, index) => [shot.id, index]))
  const shown =
    filter === 'all'
      ? shots
      : shots.filter((shot) => shotReviewStatus(groups.get(shot.id) ?? [], shot) === filter)
  const before = pair && shots.find((shot) => shot.id === pair.before)
  const after = pair && shots.find((shot) => shot.id === pair.after)
  const videoOf = (id: string) =>
    (groups.get(id) ?? []).find((node) => (node.params?.source as ShotSource)?.role === 'video')
  const beforeVideo = before && videoOf(before.id)
  const afterVideo = after && videoOf(after.id)
  const pending = nextPendingShot(shots, groups, focused)
  useEffect(() => {
    if (focused) rows.current.get(focused)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [focused, filter])
  const nodeIds = [...groups.values()].flat().map((node) => node.id)
  const jobs = useQuery({
    queryKey: [...queryKeys.canvasJobs(canvasId ?? ''), 'nodes', [...nodeIds].sort()],
    queryFn: () => api.canvasNodeJobs(canvasId!, nodeIds),
    enabled: !!canvasId && nodeIds.length > 0,
    refetchInterval: (q) =>
      q.state.data?.jobs.some((j) => j.status === 'running' || j.status === 'queued') ? 1000 : 5000,
  })
  const canGenerate = !jobs.isPending && !jobs.isError
  const latestJobs = new Map(jobs.data?.jobs.map((job) => [job.nodeId, job]))
  const locate = (id: string) => {
    engine.selection.set([id])
    engine.zoomToFit([id])
    useCanvas.getState().openStoryboard(null)
  }
  const preview = (node: CanvasElement) => {
    const r = currentResult(node)
    if (r)
      useCanvas
        .getState()
        .view({ kind: 'result', name: node.name ?? '候选审片', nodeId: node.id, resultId: r.id })
  }
  return (
    <>
      <div className="flex flex-none flex-wrap items-center gap-3 border-b border-line px-4 py-2 text-xs">
        <div className="flex items-center gap-2">
          创作验收
          <Select
            aria-label="筛选镜头验收"
            value={filter}
            options={[
              { value: 'all', label: '全部镜头' },
              ...(['pending', 'usable', 'changes'] as const).map((value) => ({
                value: value as string,
                label: reviewLabels[value],
              })),
            ]}
            onChange={(value) => setFilter(value as typeof filter)}
            className="ui-input"
          />
        </div>
        <button
          type="button"
          className="ui-btn ui-btn-secondary ui-btn-xs"
          disabled={!pending}
          onClick={() => {
            setFilter('pending')
            setFocused(pending?.id)
          }}
        >
          下一待审
        </button>
        <span className="text-ink-subtle">
          已确认可用{' '}
          {
            shots.filter((shot) => shotReviewStatus(groups.get(shot.id) ?? [], shot) === 'usable')
              .length
          }{' '}
          / {shots.length} 镜
        </span>
        {canvasId && nodeIds.length > 0 && jobs.isPending && (
          <span role="status" className="text-ink-muted">
            正在读取镜头任务…
          </span>
        )}
        {jobs.isError && (
          <div role="alert" className="flex items-center gap-2 text-danger">
            镜头任务读取失败
            <button
              type="button"
              className="ui-btn ui-btn-secondary ui-btn-xs"
              disabled={jobs.isFetching}
              onClick={() => void jobs.refetch()}
            >
              {jobs.isFetching ? '正在重试…' : '重试'}
            </button>
          </div>
        )}
      </div>
      <div className="storyboard-review-scroll ui-scrollbar min-h-0 overflow-auto">
        <table className="w-full min-w-240 text-left text-sm" aria-label="逐镜审核">
          <thead className="sticky top-0 z-10 bg-surface-2 text-xs text-ink-muted">
            <tr>
              <th className="p-3">选择</th>
              <th className="p-3">镜头与参考</th>
              {roles.map((r) => (
                <th key={r.role} className="p-3">
                  {r.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((shot) => {
              const nodes = reviewNodesForShot(shot, groups.get(shot.id) ?? [])
              const previous = shots[shotIndex.get(shot.id)! - 1]
              const previousVideo = previous && videoOf(previous.id)
              const thisVideo = videoOf(shot.id)
              const canCompare =
                previousVideo &&
                thisVideo &&
                creativeReviewTarget(previousVideo)?.kind === 'video' &&
                creativeReviewTarget(thisVideo)?.kind === 'video'
              const image = nodes.find((n) => (n.params?.source as ShotSource)?.role === 'image')
              const refs = image
                ? [...upstreams(engine, image.id, catalog).values()]
                    .flat()
                    .filter((u) => u.value?.type === 'image')
                : []
              return (
                <tr
                  key={shot.id}
                  ref={(row) => {
                    if (row) rows.current.set(shot.id, row)
                    else rows.current.delete(shot.id)
                  }}
                  className={`border-t border-line align-top ${focused === shot.id ? 'bg-accent/5' : ''}`}
                  data-shot-id={shot.id}
                >
                  <td className="p-3">
                    <input
                      type="checkbox"
                      aria-label={`选择镜头 ${shot.no}`}
                      checked={picked.has(shot.id)}
                      onChange={(e) => onPick(shot.id, e.target.checked)}
                    />
                  </td>
                  <td className="w-64 p-3">
                    <p className="font-medium">
                      镜头 {String(shot.no).padStart(2, '0')} · {shot.duration}s
                    </p>
                    <p className="mt-1 text-xs text-ink-muted">{shot.description}</p>
                    <p className="mt-1 text-xs text-ink-muted">
                      创作验收：{reviewLabels[shotReviewStatus(nodes, shot)]}
                    </p>
                    <button
                      type="button"
                      className="ui-btn ui-btn-secondary ui-btn-xs mt-2"
                      onClick={() =>
                        useCanvas.getState().openShotWorkbench({ boardId, shotId: shot.id })
                      }
                    >
                      打开镜头工作台
                    </button>
                    <button
                      type="button"
                      disabled={!canCompare}
                      title={
                        canCompare
                          ? '比较上一镜尾帧与当前镜首帧，循环回看切点'
                          : '需要相邻两镜都有采用的视频'
                      }
                      className="ui-btn ui-btn-secondary ui-btn-xs mt-2"
                      onClick={() => previous && setPair({ before: previous.id, after: shot.id })}
                    >
                      与上一镜连续性审看
                    </button>
                    <div className="mt-2 flex gap-1">
                      {refs.map((u) => {
                        const v = u.value
                        return v?.type === 'image' ? (
                          <button
                            key={u.edgeId}
                            type="button"
                            title={`参考：${u.source.name ?? '图片'}`}
                            onClick={() =>
                              useCanvas.getState().view({
                                kind: 'image',
                                assetId: v.assetId,
                                name: u.source.name ?? '参考图',
                              })
                            }
                          >
                            <img
                              src={assetUrls.variant(v.assetId, 'thumb-256')}
                              alt={u.source.name ?? '参考图'}
                              className="size-10 rounded object-cover"
                            />
                          </button>
                        ) : null
                      })}
                    </div>
                    {!nodes.length && (
                      <p className="mt-2 text-xs text-ink-subtle">尚未展开为镜头</p>
                    )}
                  </td>
                  {roles.map(({ role }) => (
                    <td key={role} className="w-64 p-3">
                      <div className="flex flex-col gap-3">
                        {nodes
                          .filter((n) => (n.params?.source as ShotSource)?.role === role)
                          .map((node) => {
                            const r = currentResult(node)
                            const v = r?.value
                            const job = latestJobs.get(node.id)
                            const recovery = job && describeRecovery(job)
                            const failure =
                              !recovery && node.run?.status === 'failed'
                                ? describeFailure(node.run)
                                : null
                            return (
                              <div
                                key={node.id}
                                className="flex flex-col gap-2 rounded-lg border border-line p-2"
                              >
                                {v && (v.type === 'image' || v.type === 'video') ? (
                                  <button
                                    type="button"
                                    aria-label={`预览${node.name ?? role}`}
                                    onClick={() => preview(node)}
                                  >
                                    <img
                                      loading="lazy"
                                      src={assetUrls.variant(
                                        v.assetId,
                                        v.type === 'image' ? 'thumb-256' : 'poster',
                                      )}
                                      alt={node.name ?? role}
                                      className="h-28 w-full rounded object-contain bg-surface-2"
                                    />
                                  </button>
                                ) : v?.type === 'audio' ? (
                                  <button
                                    type="button"
                                    className="ui-btn ui-btn-secondary"
                                    onClick={() => preview(node)}
                                  >
                                    {role === 'sfx' ? '试听音效' : '试听配音'}
                                  </button>
                                ) : (
                                  <span className="text-xs text-ink-subtle">尚无采用结果</span>
                                )}
                                <p className="text-xs">
                                  {node.name} ·{' '}
                                  {node.run?.status === 'running'
                                    ? '生成中'
                                    : node.run?.status === 'queued'
                                      ? '排队中'
                                      : node.run?.status === 'failed'
                                        ? '失败'
                                        : node.run?.status === 'canceled' && !r
                                          ? '已取消'
                                          : r
                                            ? '当前采用'
                                            : '未完成'}
                                </p>
                                {failure && (
                                  <div role="alert" className="text-xs text-danger">
                                    <p>{failure.title}</p>
                                    {failure.detail && (
                                      <p className="mt-1 break-words">{failure.detail}</p>
                                    )}
                                    {failure.settings && (
                                      <button
                                        type="button"
                                        className="ui-btn ui-btn-secondary ui-btn-xs mt-2"
                                        onClick={openProviderSettings}
                                      >
                                        打开模型平台设置
                                      </button>
                                    )}
                                  </div>
                                )}
                                <CreativeReviewForm
                                  doc={engine.doc}
                                  node={node}
                                  stale={stale.has(node.id)}
                                />
                                <div className="flex gap-2">
                                  <button
                                    type="button"
                                    className="ui-btn ui-btn-secondary ui-btn-xs"
                                    onClick={() => locate(node.id)}
                                  >
                                    定位
                                  </button>
                                  {!recovery && canvasId && !engine.doc.readOnly && (
                                    <ShotRunButton
                                      canvasId={canvasId}
                                      node={node}
                                      latest={job}
                                      ready={canGenerate}
                                    />
                                  )}
                                </div>
                                {job && recovery && (
                                  <RecoveryBlock
                                    key={job.id}
                                    job={job}
                                    view={recovery}
                                    doc={engine.doc}
                                    latest
                                    onLocate={() => locate(node.id)}
                                  />
                                )}
                              </div>
                            )
                          })}
                      </div>
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
        {!shown.length && (
          <p className="p-6 text-center text-sm text-ink-subtle">没有符合条件的镜头</p>
        )}
      </div>
      {before && after && beforeVideo && afterVideo && canvasId && (
        <ShotContinuityReview
          engine={engine}
          canvasId={canvasId}
          boardId={boardId}
          before={{ shot: before, node: beforeVideo }}
          after={{ shot: after, node: afterVideo }}
          onClose={() => setPair(undefined)}
        />
      )}
    </>
  )
}

function ShotRunButton({
  canvasId,
  node,
  latest,
  ready,
}: {
  canvasId: string
  node: CanvasElement
  latest?: JobInfo
  ready: boolean
}) {
  // 请求受理、文档同步、任务轮询可能以任意顺序抵达，期间保留这次操作的身份。
  const [submission, setSubmission] = useState<{
    previousRun?: string
    previousJob?: string
    id?: string
  }>()
  const local = submission?.previousRun === node.run?.id ? submission : undefined
  const observed =
    latest && (!node.run || (latest.id !== node.run.id && latest.createdAt > node.run.at))
      ? latest
      : node.run
  const run = local?.id
    ? latest && (latest.id === local.id || latest.id !== local.previousJob)
      ? latest
      : { id: local.id, status: 'queued' }
    : observed
  const activeId = run?.status === 'running' || run?.status === 'queued' ? run.id : undefined
  const submitting = useRunRequests((s) => s.pending.has(runRequestKey(canvasId, node.id)))
  const canceling = useCancelRequests((s) =>
    s.pending.has(cancelRequestKey(canvasId, node.id, activeId)),
  )
  if (activeId)
    return (
      <button
        key={`cancel:${activeId}`}
        type="button"
        className="ui-btn ui-btn-secondary ui-btn-xs"
        disabled={canceling}
        onClick={() => {
          if (useCanvas.getState().canvasId === canvasId) void cancelNode(node.id, activeId)
        }}
      >
        {canceling ? '正在取消…' : '取消生成'}
      </button>
    )
  const submit = async () => {
    const state = useCanvas.getState()
    const current = state.engine?.doc.get(node.id)
    if (
      state.canvasId !== canvasId ||
      state.engine?.doc.readOnly ||
      !current ||
      current.run?.id !== node.run?.id ||
      current.run?.status === 'running' ||
      current.run?.status === 'queued'
    )
      return
    const previous = { previousRun: current.run?.id, previousJob: latest?.id }
    setSubmission(previous)
    const id = await runNode(node.id)
    setSubmission(id ? { ...previous, id } : undefined)
  }
  const waiting = submitting || (!!local && !local.id)
  return (
    <button
      key={`generate:${run?.id ?? ''}`}
      type="button"
      className="ui-btn ui-btn-secondary ui-btn-xs"
      disabled={!ready || waiting}
      onClick={() => void submit()}
    >
      {waiting
        ? '正在提交…'
        : currentResult(node)
          ? '生成新候选'
          : node.run?.status === 'failed'
            ? '重试此项'
            : '生成此项'}
    </button>
  )
}
