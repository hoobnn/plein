import type { Engine } from '@plein/canvas-core'
import {
  readSourceSlice,
  sourceMapOf,
  sourceSnapshotState,
  type SourceSnapshot,
  type SourceUnit,
} from '@plein/doc'
import { useState } from 'react'

export function SourceQuotes({
  engine,
  boardId,
  shotId,
  onLocateSource,
}: {
  engine: Engine
  boardId: string
  shotId: string
  onLocateSource(id: string): void
}) {
  const record = sourceMapOf(engine.doc, boardId),
    links = record.links.filter((l) => l.shotId === shotId)
  return (
    <div className="space-y-2 p-2 text-xs">
      {!links.length && <p>本镜尚无固定原文映射；此处不推断剧情已读或内容已确认。</p>}
      {links.map((link) => {
        const unit = record.units.find((u) => u.id === link.unitId),
          source = unit && record.snapshots.find((s) => s.id === unit.snapshotId)
        const entry = source && record.sources.find((s) => s.id === source.sourceId)
        const status = source && sourceSnapshotState(engine.doc, boardId, source)
        const statusLabels = {
          current: '来源与固定版一致',
          changed: '当前来源已修改，仍显示固定旧版',
          missing: '来源已删除，仅保留历史',
          external: '外部历史来源，未绑定',
          disconnected: '来源已断开，保留历史',
        }
        return (
          <div key={link.id}>
            {source && unit ? (
              <>
                <p>
                  {source.name} · 固定版 {source.id.slice(-8)} · [{unit.start},{unit.end})
                </p>
                <p>
                  {status && statusLabels[status]} ·{' '}
                  {{ retain: '保留', compress: '压缩', merge: '合并' }[link.treatment]}
                </p>
                <details>
                  <summary>捕获时的原出处</summary>
                  <p className="break-all">
                    画布 {source.originAtCapture.canvasId} · 元素 {source.originAtCapture.elementId}{' '}
                    · 端口 {source.originAtCapture.port} · 结果{' '}
                    {source.originAtCapture.resultId ?? '直接文本'}
                  </p>
                </details>
                {entry?.binding && (status === 'current' || status === 'changed') && (
                  <button
                    type="button"
                    className="ui-btn ui-btn-secondary ui-btn-xs"
                    onClick={() => {
                      const now = sourceMapOf(engine.doc, boardId).sources.find(
                        (s) => s.id === entry.id,
                      )
                      const nodeId = now?.binding?.elementId
                      const state = sourceSnapshotState(engine.doc, boardId, source)
                      if (
                        nodeId &&
                        nodeId === entry.binding?.elementId &&
                        now?.binding?.port === entry.binding.port &&
                        (state === 'current' || state === 'changed') &&
                        engine.doc.has(nodeId)
                      )
                        onLocateSource(nodeId)
                    }}
                  >
                    定位当前绑定来源
                  </button>
                )}
                <UnitQuote key={`${source.id}:${unit.id}`} source={source} unit={unit} />
              </>
            ) : (
              <p>历史映射来源缺失，不以当前文字替代。</p>
            )}
          </div>
        )
      })}
    </div>
  )
}

function UnitQuote({ source, unit }: { source: SourceSnapshot; unit: SourceUnit }) {
  const [offset, setOffset] = useState(unit.start)
  const page = readSourceSlice(source, offset, Math.min(8000, unit.end - offset))
  return (
    <div>
      <p className="whitespace-pre-wrap break-words">{page.text}</p>
      <p>
        显示原文 [{page.offset},{Math.min(page.end, unit.end)})，本映射至 {unit.end}
      </p>
      <button
        type="button"
        className="ui-btn ui-btn-secondary ui-btn-xs"
        disabled={offset <= unit.start}
        onClick={() => setOffset(Math.max(unit.start, offset - 8000))}
      >
        上一段原文
      </button>
      <button
        type="button"
        className="ui-btn ui-btn-secondary ui-btn-xs"
        disabled={page.end >= unit.end}
        onClick={() => setOffset(page.end)}
      >
        下一段原文
      </button>
    </div>
  )
}
