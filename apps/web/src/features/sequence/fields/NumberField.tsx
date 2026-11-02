import { useId, useRef, useState } from 'react'

/** 秒数输入：失焦或回车时写入，清空表示用默认值 */
export function NumberField(props: {
  label: string
  value: number | undefined
  readValue(): number | undefined
  placeholder?: string
  max?: number
  /** 输入框里靠右的单位 */
  unit?: string
  onChange(v: number | undefined): void
}) {
  const [draft, setDraft] = useState<{
    text: string
    base: number | undefined
    badInput: boolean
  } | null>(null)
  const [error, setError] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const errorId = useId()
  const conflictId = useId()
  const current = props.readValue()
  const conflict = draft !== null && !Object.is(draft.base, current)
  const commit = (input: HTMLInputElement, force = false) => {
    if (draft === null) return
    if (!force && !Object.is(draft.base, props.readValue())) {
      setDraft({ ...draft })
      return
    }
    const n = draft.text.trim() === '' ? undefined : Number(draft.text)
    setDraft(null)
    if (
      draft.badInput ||
      input.validity.badInput ||
      (n !== undefined && (!Number.isFinite(n) || n < 0))
    ) {
      setError(true)
      return
    }
    setError(false)
    props.onChange(n === undefined ? undefined : Math.min(n, props.max ?? n))
  }
  return (
    <span className="block space-y-1">
      <span className="seq-number">
        <input
          ref={inputRef}
          type="number"
          aria-label={props.label}
          aria-invalid={error || undefined}
          aria-describedby={
            [error ? errorId : undefined, conflict ? conflictId : undefined]
              .filter(Boolean)
              .join(' ') || undefined
          }
          min={0}
          step={0.1}
          max={props.max}
          className="ui-input w-full tabular-nums"
          value={draft?.text ?? (props.value === undefined ? '' : String(props.value))}
          placeholder={props.placeholder}
          onChange={(e) => {
            const text = e.target.value
            const badInput = e.currentTarget.validity.badInput
            setDraft((previous) => ({
              text,
              badInput,
              base: previous ? previous.base : props.readValue(),
            }))
            setError(false)
          }}
          onBlur={(e) => commit(e.currentTarget)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
        />
        {props.unit && <span className="seq-number-unit">{props.unit}</span>}
      </span>
      {error && (
        <span id={errorId} role="alert" className="block text-xs text-danger">
          请输入有效的非负数字，已保留原设置
        </span>
      )}
      {conflict && (
        <span className="block space-y-2 rounded-lg bg-surface-2 p-2">
          <span id={conflictId} role="status" className="block text-xs text-ink-muted">
            设置已更新为 {String(current ?? '默认')}，当前草稿尚未保存。
          </span>
          <span className="flex flex-wrap gap-2">
            <button
              type="button"
              className="ui-btn ui-btn-secondary ui-btn-sm"
              onClick={() => {
                setDraft(null)
                setError(false)
                inputRef.current?.focus()
              }}
            >
              使用最新数值
            </button>
            <button
              type="button"
              className="ui-btn ui-btn-secondary ui-btn-sm"
              onClick={() => {
                const input = inputRef.current
                if (input) {
                  input.focus()
                  commit(input, true)
                }
              }}
            >
              保留当前数值
            </button>
          </span>
        </span>
      )}
    </span>
  )
}
