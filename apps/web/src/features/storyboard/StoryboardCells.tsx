import { useEffect, useId, useRef, useState } from 'react'
import { useCanvas } from '../../stores/canvas'
import { mentionTargets } from '../../canvas/nodes'
import { MentionTextarea } from '../../ui/MentionTextarea'
const cell =
  'resize-none rounded-md bg-transparent px-2 py-1.5 text-sm text-ink outline-none ring-1 ring-transparent transition-shadow hover:ring-line focus:bg-surface-2 focus:ring-accent'

/** 保留清空、负号等输入草稿，文档里的时长始终符合镜头约束。 */
export function DurationCell({
  value,
  onChange,
  compact = false,
}: {
  value: number
  onChange(value: number): void
  compact?: boolean
}) {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <label className="flex shrink-0 items-center gap-2 whitespace-nowrap text-xs text-ink-muted">
      <span className={compact ? 'sr-only' : undefined}>时长</span>
      <input
        type="number"
        min={1}
        max={30}
        step="any"
        aria-label="时长"
        className={`${cell} w-16 bg-surface-2`}
        value={draft ?? value}
        onChange={(event) => {
          setDraft(event.target.value)
          const next = event.currentTarget.valueAsNumber
          if (Number.isFinite(next)) onChange(Math.max(1, Math.min(30, next)))
        }}
        onBlur={() => setDraft(null)}
      />
      秒
    </label>
  )
}

/** 单元格：失焦时写入，避免每个按键都改一次文档并标记手改 */
export function TextCell({
  value,
  readValue,
  label,
  onChange,
  children,
  compact = false,
}: {
  value: string
  readValue(): string
  label: string
  onChange(v: string): void
  children?: React.ReactNode
  compact?: boolean
}) {
  const engine = useCanvas((s) => s.engine)
  const [edit, setEdit] = useState({ base: value, draft: value })
  const conflictId = useId()
  const input = useRef<HTMLTextAreaElement>(null)
  const [locateBlocked, setLocateBlocked] = useState(false)
  useEffect(() => {
    setEdit((prev) =>
      prev.draft === prev.base || prev.draft === value ? { base: value, draft: value } : prev,
    )
  }, [value])
  const { base, draft } = edit
  const dirty = draft !== base
  const conflict = dirty && base !== value && draft !== value
  useEffect(() => {
    if (!locateBlocked) return
    if (conflict) {
      document.getElementById(conflictId)?.parentElement?.scrollIntoView({ block: 'nearest' })
      setLocateBlocked(false)
    } else if (!dirty) setLocateBlocked(false)
  }, [locateBlocked, conflict, conflictId, dirty])
  const reset = () => {
    const latest = readValue()
    setEdit({ base: latest, draft: latest })
  }
  const commit = () => {
    setEdit({ base: draft, draft })
    if (draft !== readValue()) onChange(draft)
  }
  const saveIfSafe = () => {
    const latest = readValue()
    if (!dirty) reset()
    else if (base === latest || draft === latest) commit()
    else return false
    return true
  }
  return (
    <div className="min-w-0" data-storyboard-field={label}>
      <div className={compact ? 'sr-only' : 'mb-1 text-xs font-medium text-ink-muted'}>{label}</div>
      <MentionTextarea
        ref={input}
        targets={engine ? mentionTargets(engine) : []}
        onLocate={(id) => {
          if (!engine?.doc.has(id)) return
          // 组合点击仍在同一文本框内，不会触发 blur，离开前必须主动保存。
          if (!saveIfSafe()) {
            setLocateBlocked(true)
            return
          }
          useCanvas.getState().openStoryboard(null)
          engine.selection.set([id])
          engine.zoomToFit([id])
        }}
        aria-label={label}
        aria-describedby={conflict ? conflictId : undefined}
        rows={1}
        className={`${cell} block w-full field-sizing-content min-h-8 ${compact ? 'max-h-28 bg-transparent' : 'max-h-80 bg-surface-2'} overflow-y-auto leading-relaxed`}
        value={draft}
        onFocus={() => {
          if (!dirty) reset()
        }}
        onChange={(e) => setEdit({ base: dirty ? base : readValue(), draft: e.target.value })}
        onBlur={() => {
          // 文档按帧通知；失焦时读最新值，不能只依赖尚未刷新的 props。
          saveIfSafe()
        }}
      />
      {conflict && (
        <div className="mt-2 space-y-2 rounded-md border border-line bg-surface-2 p-2">
          <p id={conflictId} role="status" className="text-xs text-ink-muted">
            {label}已在其他位置更新。请选择要使用的内容。
          </p>
          <p
            aria-label={`${label}的最新内容`}
            className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-xs text-ink-muted"
          >
            {value || '（空）'}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="ui-btn ui-btn-secondary ui-btn-sm"
              onClick={() => {
                reset()
                input.current?.focus()
              }}
            >
              使用最新内容
            </button>
            <button
              type="button"
              className="ui-btn ui-btn-secondary ui-btn-sm"
              onClick={() => {
                commit()
                input.current?.focus()
              }}
            >
              保留当前输入
            </button>
          </div>
        </div>
      )}
      {children && <div className="mt-2 grid gap-2 sm:grid-cols-2">{children}</div>}
    </div>
  )
}
