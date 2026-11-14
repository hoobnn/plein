import type { Engine } from '@plein/canvas-core'
import type { NodeResult, PleinDoc } from '@plein/doc'
import type { PreparedInput } from '@plein/protocol'
import { useQuery } from '@tanstack/react-query'
import { useCallback, useRef, useState, useSyncExternalStore } from 'react'
import { InputDetails } from '../features/storyboard/InputDetails'
import { api } from '../api/client'
import { useCanvas } from '../stores/canvas'
import { readCandidateJob } from './candidateInput'

type View = NonNullable<ReturnType<typeof useCanvas.getState>['viewer']>

/** 文档变化就换查询版本，当前输入不能停在旧快照。 */
function useDocRevision(doc: PleinDoc | undefined) {
  const ref = useRef(0)
  const subscribe = useCallback(
    (notify: () => void) =>
      doc
        ? doc.subscribe(() => {
            ref.current++
            notify()
          })
        : () => {},
    [doc],
  )
  return useSyncExternalStore(subscribe, () => ref.current)
}

/**
 * 审片里的输入对照：按候选精确 runId 读当次冻结输入，再与当前节点输入并排显示。
 * 生成记录缺失、读不到或没有冻结输入时如实说明，不拿当前参数顶替；迟到响应不覆盖新候选。
 */
export function CandidateInputEvidence({
  engine,
  doc,
  canvasId,
  viewer,
  result,
}: {
  engine: Engine | null
  doc: PleinDoc | undefined
  canvasId: string | null
  viewer: View
  result: NodeResult
}) {
  const [open, setOpen] = useState(false)
  const sync = useCanvas((s) => s.sync)
  const version = useDocRevision(doc)
  const nodeId = viewer.nodeId

  const stillViewing = () => {
    const state = useCanvas.getState()
    return state.engine === engine && state.canvasId === canvasId && state.viewer === viewer
  }
  // 同一 result id 的内容也可能在等待期间被换掉，只有 runId / 端口 / 值都没变才算同一候选。
  const stillCurrent = () => {
    if (!stillViewing() || !nodeId) return false
    const now = engine?.doc.get(nodeId)?.results?.find((row) => row.id === result.id)
    return (
      !!now &&
      JSON.stringify([now.runId, now.port, now.value]) ===
        JSON.stringify([result.runId, result.port, result.value])
    )
  }

  const old = useQuery({
    queryKey: [
      'viewer-candidate-input',
      canvasId,
      nodeId,
      result.id,
      result.runId,
      result.port,
      result.value,
      result.generationOrigin,
    ],
    enabled: open && !!(engine && canvasId && nodeId && result.runId),
    retry: false,
    queryFn: async () => {
      if (!engine || !canvasId || !nodeId) throw new Error('没有可核对的候选')
      const evidence = await readCandidateJob(canvasId, nodeId, result)
      if (!stillCurrent()) throw new Error('审片上下文已变化')
      return evidence
    },
  })
  const current = useQuery({
    queryKey: ['viewer-current-input', canvasId, nodeId, version],
    enabled: open && !!(engine && canvasId && nodeId),
    retry: false,
    queryFn: async (): Promise<PreparedInput> => {
      if (!canvasId || !nodeId) throw new Error('没有可核对的节点')
      const input = await api.nodeInput(canvasId, nodeId)
      if (input.nodeId !== nodeId || !stillViewing() || !engine?.doc.has(nodeId))
        throw new Error('节点身份已变化')
      return input
    },
  })

  const retry = (query: { isFetching: boolean; refetch(): unknown }) => (
    <button
      type="button"
      className="ui-btn ui-btn-secondary ui-btn-sm"
      disabled={query.isFetching}
      onClick={() => void query.refetch()}
    >
      重试读取
    </button>
  )

  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="shrink-0 border-b border-line px-4 py-2"
    >
      <summary className="cursor-pointer text-xs text-ink-muted">
        此候选生成时输入与当前输入对照
      </summary>
      <div
        className="mt-2 grid gap-2 compact:grid-cols-2"
        aria-label="候选生成时输入与当前输入对照"
      >
        <section className="max-h-48 min-w-0 space-y-1 overflow-auto">
          <h4 className="text-sm font-medium">此候选生成时实际输入</h4>
          {!result.runId ? (
            <p className="text-xs">未记录生成任务，不能用当前参数补填。</p>
          ) : !open ? null : old.isPending ? (
            <p className="text-xs">读取生成时输入…</p>
          ) : old.isError || !old.data ? (
            <div className="space-y-1">
              <p className="text-xs">生成时的输入记录读不到；不以当前参数代替。</p>
              {retry(old)}
            </div>
          ) : !old.data.job.input ? (
            <p className="text-xs">这条生成记录没有冻结输入，不能用当前参数补填。</p>
          ) : (
            <>
              {old.data.scope === 'origin' && (
                <p className="text-xs text-ink-subtle">
                  这份候选是复制或迁移来的，显示的是最初生成位置的记录。
                </p>
              )}
              <InputDetails input={old.data.job.input} />
            </>
          )}
        </section>
        <section className="max-h-48 min-w-0 space-y-1 overflow-auto">
          <h4 className="text-sm font-medium">当前节点实际输入</h4>
          {!open ? null : current.isPending ? (
            <p className="text-xs">读取当前输入…</p>
          ) : current.isError ? (
            <div className="space-y-1">
              <p className="text-xs">当前输入暂不可读取。</p>
              {retry(current)}
            </div>
          ) : (
            current.data && <InputDetails input={current.data} />
          )}
          {sync !== 'connected' && (
            <p className="text-xs text-ink-subtle">
              画布还没与服务端对齐，这里的当前输入可能落后于本地改动。
            </p>
          )}
        </section>
      </div>
    </details>
  )
}
