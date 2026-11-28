import { EXTERNAL_IMPORT_LIMIT, type ExternalRow, type ExternalState } from '@plein/protocol'
import { useId, useMemo, useState, type ReactNode } from 'react'
import { Select } from '../../ui/Select'
import { states, type ReviewScope } from './NodeComparison'

export function reviewRows(rows: ExternalRow[], scope: ReviewScope, search: string) {
  const needle = search.trim().toLowerCase()
  return rows.filter((r) => {
    if (scope === 'changed' && r.state === 'synced') return false
    if (scope !== 'all' && scope !== 'changed' && r.state !== scope) return false
    return (
      !needle ||
      [r.local?.title, r.remote?.title, r.localId, r.remoteId, r.local?.text, r.remote?.text].some(
        (value) => value?.toLowerCase().includes(needle),
      )
    )
  })
}

const canImport = (row: ExternalRow) => row.state === 'remote-only' && row.actions.includes('pull')
const title = (row: ExternalRow) => row.local?.title || row.remote?.title || '无标题'

export function ReviewList({
  rows,
  visible,
  row,
  filter,
  scope,
  onFilter,
  onScope,
  onSelect,
  onImport,
  busy,
  children,
}: {
  rows: ExternalRow[]
  visible: ExternalRow[]
  row?: ExternalRow
  filter: string
  scope: ReviewScope
  onFilter(value: string): void
  onScope(value: ReviewScope): void
  onSelect(id: string): void
  onImport(rows: ExternalRow[]): void
  busy: boolean
  children: ReactNode
}) {
  const [picked, setPicked] = useState<Set<string>>(() => new Set())
  const id = useId()
  const scopes = useMemo(() => {
    const counts = new Map<ExternalState, number>()
    for (const r of rows) counts.set(r.state, (counts.get(r.state) ?? 0) + 1)
    return [
      { value: 'all', label: `全部状态（${rows.length}）` },
      { value: 'changed', label: `有差异（${rows.length - (counts.get('synced') ?? 0)}）` },
      ...Object.entries(states)
        .filter(([state]) => counts.has(state as ExternalState) || state === scope)
        .map(([value, name]) => ({
          value,
          label: `${name}（${counts.get(value as ExternalState) ?? 0}）`,
        })),
    ]
  }, [rows, scope])
  const importable = visible.filter(canImport)
  const available = importable.filter((r) => !picked.has(r.rowId))
  const next = available.slice(0, EXTERNAL_IMPORT_LIMIT - picked.size)
  const allChecked = importable.length > 0 && !available.length
  const hiddenCount = picked.size - (importable.length - available.length)
  function toggle(id: string) {
    setPicked((old) => {
      const result = new Set(old)
      if (result.has(id)) result.delete(id)
      else if (result.size < EXTERNAL_IMPORT_LIMIT) result.add(id)
      return result
    })
  }
  return (
    <section aria-label="同步结果" className="border-t border-line">
      {(rows.length > 1 || filter || scope !== 'all') && (
        <search
          aria-label="筛选同步节点"
          className="flex flex-wrap items-end gap-2 px-4 py-2 sm:px-5"
        >
          <label
            htmlFor={id}
            className="flex min-w-40 flex-1 flex-col gap-1 text-xs text-ink-muted"
          >
            查找同步节点
            <input
              id={id}
              type="search"
              className="ui-input w-full text-ink"
              value={filter}
              placeholder="搜索标题、正文或节点 ID"
              onChange={(e) => onFilter(e.target.value)}
            />
          </label>
          <Select
            aria-label="同步状态"
            className="max-w-full"
            value={scope}
            options={scopes}
            onChange={(value) => onScope(value as ReviewScope)}
          />
        </search>
      )}
      {(importable.length > 0 || picked.size > 0) && (
        <div className="flex flex-wrap items-center gap-2 px-4 py-2 sm:px-5">
          {importable.length > 0 && (
            <button
              type="button"
              disabled={busy || (!allChecked && !next.length)}
              className="ui-btn ui-btn-quiet ui-btn-sm"
              onClick={() => {
                const updated = new Set(picked)
                if (allChecked) {
                  for (const r of importable) updated.delete(r.rowId)
                } else {
                  for (const r of next) updated.add(r.rowId)
                }
                setPicked(updated)
              }}
            >
              {allChecked
                ? '取消选择当前结果'
                : next.length > 0 && next.length < available.length
                  ? `选中前 ${next.length} 项`
                  : '选择当前可导入项'}
            </button>
          )}
          <button
            type="button"
            className="ui-btn ui-btn-secondary ui-btn-sm"
            disabled={busy || !picked.size}
            onClick={() => onImport(rows.filter((r) => picked.has(r.rowId) && canImport(r)))}
          >
            导入所选（{picked.size}）
          </button>
          {picked.size > 0 && (
            <button
              type="button"
              className="ui-btn ui-btn-quiet ui-btn-sm"
              onClick={() => setPicked(new Set())}
            >
              清除选择
            </button>
          )}
          {hiddenCount > 0 && (
            <span className="text-xs text-ink-muted">含当前筛选外的 {hiddenCount} 项</span>
          )}
          {(picked.size === EXTERNAL_IMPORT_LIMIT || importable.length > EXTERNAL_IMPORT_LIMIT) && (
            <span className="text-xs text-ink-muted">每批最多 {EXTERNAL_IMPORT_LIMIT} 项</span>
          )}
        </div>
      )}
      <div className="grid md:grid-cols-[minmax(12rem,0.35fr)_minmax(0,1fr)]">
        <nav
          aria-label="同步节点"
          className="ui-scrollbar min-w-0 max-h-48 space-y-1 overflow-auto border-b border-line p-2 md:max-h-96 md:border-r md:border-b-0"
        >
          {visible.map((item) => (
            <div key={item.rowId} className="flex items-center">
              {canImport(item) && (
                <label className="grid min-h-12 min-w-11 cursor-pointer place-items-center">
                  <span className="sr-only">选择导入「{title(item)}」</span>
                  <input
                    type="checkbox"
                    className="accent-accent"
                    checked={picked.has(item.rowId)}
                    disabled={
                      busy || (!picked.has(item.rowId) && picked.size >= EXTERNAL_IMPORT_LIMIT)
                    }
                    onChange={() => toggle(item.rowId)}
                  />
                </label>
              )}
              <button
                type="button"
                aria-current={item.rowId === row?.rowId ? 'true' : undefined}
                onClick={() => onSelect(item.rowId)}
                className="min-w-0 flex-1 rounded-md px-3 py-2 text-left hover:bg-hover aria-current:bg-accent-soft"
              >
                <span className="block truncate text-sm">{title(item)}</span>
                <span className="block text-xs text-ink-muted">{states[item.state]}</span>
              </button>
            </div>
          ))}
        </nav>
        {row ? (
          children
        ) : (
          <div className="p-4 text-sm text-ink-muted">
            <p role="status">没有匹配的节点</p>
            <button
              type="button"
              className="ui-btn ui-btn-quiet ui-btn-sm mt-2"
              onClick={() => {
                onFilter('')
                onScope('all')
              }}
            >
              清除筛选
            </button>
          </div>
        )}
      </div>
    </section>
  )
}
