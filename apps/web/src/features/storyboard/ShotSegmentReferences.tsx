import type { Engine } from '@plein/canvas-core'
import { segmentUsers, shotSegmentMapping } from '@plein/capabilities'
import { useState } from 'react'
import { useCanvas } from '../../stores/canvas'

const soundLabels = {
  legacy: '旧版自动声音',
  native: '原生声音',
  voice: '独立配音',
  mix: '原生声音与配音混合',
}

/** Read the sequence's actual instances; no separate shot-to-file state or media loader. */
export function ShotSegmentReferences({
  engine,
  canvasId,
  boardId,
  shotId,
  sequenceId,
  onSelectSequence,
  isCurrent,
}: {
  engine: Engine
  canvasId: string
  boardId: string
  shotId: string
  sequenceId?: string
  onSelectSequence?(id: string): void
  isCurrent(): boolean
}) {
  const [error, setError] = useState('')
  const scope = { canvasId, boardId, shotId, sequenceId }
  const mapping = shotSegmentMapping(engine.doc, scope)
  return (
    <section aria-label="本镜序列映射" className="space-y-2 text-xs">
      <h3 className="font-medium">本镜序列映射</h3>
      {onSelectSequence && mapping.sequenceIds.length > 0 && (
        <label className="block">
          本镜序列范围{' '}
          <select
            className="ui-input max-w-full"
            aria-label="本镜序列范围"
            value={sequenceId ?? ''}
            onChange={(event) => {
              if (isCurrent()) {
                onSelectSequence(event.target.value)
                setError('')
              }
            }}
          >
            <option value="">唯一关联时确定；多个序列需选择</option>
            {[...new Set([...mapping.sequenceIds, ...(sequenceId ? [sequenceId] : [])])].map(
              (id) => (
                <option key={id} value={id}>
                  {engine.doc.get(id)?.name ?? id} · {id}
                </option>
              ),
            )}
          </select>
        </label>
      )}
      {mapping.problem && <p role="status">{mapping.problem}</p>}
      {!mapping.problem && !mapping.instances.length && <p>选定范围内尚无本镜的剪辑映射。</p>}
      {mapping.instances.map((row) => (
        <div key={row.clipInstanceId} className="space-y-1 rounded border border-line p-2">
          <p className="break-all">
            {row.segment ? '固定段' : '跟随来源'} · 实例 {row.clipInstanceId} · 源区间 [{row.in},{' '}
            {row.out ?? row.segment?.duration ?? '文件结尾'}) · {row.speed ?? 1} 倍速 ·{' '}
            {soundLabels[row.sound]}
          </p>
          {row.segment && (
            <>
              <p className="break-all">
                文件 {row.segment.asset.assetId} · 同段使用位置{' '}
                {segmentUsers(engine.doc, row.segment.segmentId).length} 处
              </p>
              <details>
                <summary>原始生成出处</summary>
                <p className="break-all">
                  {row.segment.origin
                    ? `${row.segment.origin.canvasId} / ${row.segment.origin.nodeId} / ${row.segment.origin.port} / ${row.segment.origin.resultId} / ${row.segment.origin.runId}`
                    : '原始生成出处未知；不以当前画布或节点推断'}
                </p>
              </details>
              {row.segment.selection && (
                <details>
                  <summary>固定时选定的本地候选</summary>
                  <p className="break-all">
                    {row.segment.selection.canvasId} / {row.segment.selection.nodeId} /{' '}
                    {row.segment.selection.port} / {row.segment.selection.resultId} /{' '}
                    {row.segment.selection.runId}
                  </p>
                  <p>这是选定时的位置与关联 ID，原始生成出处单独记录。</p>
                </details>
              )}
            </>
          )}
          <button
            type="button"
            className="ui-btn ui-btn-secondary ui-btn-xs"
            disabled={!!mapping.problem}
            onClick={() => {
              const state = useCanvas.getState()
              if (!isCurrent() || state.engine !== engine || state.canvasId !== canvasId) return
              const latest = shotSegmentMapping(engine.doc, scope)
              const current = latest.instances.find(
                (next) => next.clipInstanceId === row.clipInstanceId,
              )
              if (
                latest.problem ||
                !latest.sequenceId ||
                JSON.stringify(current) !== JSON.stringify(row)
              )
                return setError('剪辑映射已变化，请重新核对')
              engine.selection.set([latest.sequenceId])
              engine.zoomToFit([latest.sequenceId])
              state.openSequence(latest.sequenceId, row.clipInstanceId)
            }}
          >
            定位此剪辑实例
          </button>
        </div>
      ))}
      {!!mapping.instances.length && (
        <p className="text-ink-subtle">
          此处显示结构映射；实际文件在生成清单与导出时核验。当前叙事仍需审看，不继承原出处的人工可用结论。
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  )
}
