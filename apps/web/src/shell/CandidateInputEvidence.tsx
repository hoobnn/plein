import type { Engine } from '@plein/canvas-core'
import type { NodeResult } from '@plein/doc'
import type { Catalog } from '@plein/protocol'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useInputPreview } from '../features/generator/InputPreview'
import { referenceModeOf } from '../features/generator/previewKey'
import { findNode } from '../canvas/nodes'
import { InputDetails } from '../features/storyboard/InputDetails'
import { useCanvas } from '../stores/canvas'
import { readCandidateJob } from './candidateInput'

type View = NonNullable<ReturnType<typeof useCanvas.getState>['viewer']>

/**
 * 审片里的输入对照：按候选精确 runId 读当次冻结输入，再与当前节点输入并排显示。
 * 生成记录缺失、读不到或没有冻结输入时如实说明，不拿当前参数顶替；迟到响应不覆盖新候选。
 */
export function CandidateInputEvidence({
  engine,
  canvasId,
  viewer,
  result,
  catalog,
}: {
  engine: Engine
  canvasId: string | null
  viewer: View
  result: NodeResult
  /** 与生成器共用同一套参考模式判断（含插件节点的能力） */
  catalog: Catalog | null
}) {
  const [open, setOpen] = useState(false)
  const sync = useCanvas((s) => s.sync)
  const nodeId = viewer.nodeId
  const element = nodeId ? engine.doc.get(nodeId) : undefined
  const referenceMode = referenceModeOf(
    element ? findNode(catalog, element.nodeType)?.capability : undefined,
    element?.params,
  )
  // 当前输入复用生成器的公共预览：内部按实际输入语义摘要换代，移动节点、无关节点和任务进度
  // 不重取；关闭时停用，重开按当前文档重新读取，关闭期间改过的输入不会沿用旧缓存。
  // 服务端还没收到本机改动时由它标记等同步并在追平后自动重读。
  const preview = useInputPreview(
    engine,
    open && canvasId && nodeId ? canvasId : null,
    nodeId ?? '',
    referenceMode,
  )

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
  const retryButton = (onClick: () => void, disabled = false) => (
    <button
      type="button"
      className="ui-btn ui-btn-secondary ui-btn-sm"
      disabled={disabled}
      onClick={onClick}
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
              {retryButton(() => void old.refetch(), old.isFetching)}
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
          {!open ? null : preview.syncPending ? (
            <p className="text-xs">本机改动还没同步到服务端，同步后会自动重读当前输入。</p>
          ) : preview.loading && !preview.data ? (
            <p className="text-xs">读取当前输入…</p>
          ) : preview.error ? (
            <div className="space-y-1">
              <p className="text-xs">当前输入暂不可读取。</p>
              {retryButton(preview.retry, preview.loading)}
            </div>
          ) : preview.stale ? (
            <p className="text-xs">输入刚有变化，正在按最新内容重新读取…</p>
          ) : preview.data ? (
            <InputDetails input={preview.data} />
          ) : (
            <p className="text-xs">当前输入还不可读取。</p>
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
