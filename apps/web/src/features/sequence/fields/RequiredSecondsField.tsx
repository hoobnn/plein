import { useId, useLayoutEffect, useRef, useState } from 'react'
import { useClosing } from '../../../ui/Presence'

/** 必填秒数保留逐字草稿，回车／失焦后校验；不把清空过程当作 0。 */
export function RequiredSecondsField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  onChange(value: number): void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pending = useRef<string | null>(null)
  const errorId = useId()
  const closing = useClosing()
  useLayoutEffect(() => {
    pending.current = null
    setDraft(null)
    setError(null)
    return () => {
      pending.current = null
    }
  }, [value, closing])
  const commit = () => {
    const raw = pending.current
    pending.current = null
    setDraft(null)
    if (raw === null || closing) return
    const next = raw.trim() === '' ? NaN : Number(raw)
    if (!Number.isFinite(next) || next < min || next > max) {
      setError(`请输入 ${min}–${max} 秒，已保留原设置`)
      return
    }
    setError(null)
    if (next !== value) onChange(next)
  }
  return (
    <label className="block space-y-1 text-xs">
      <span>{label}</span>
      <input
        aria-label={label}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className="ui-input w-full"
        type="number"
        required
        min={min}
        max={max}
        step="0.1"
        value={draft ?? value}
        onChange={(e) => {
          pending.current = e.currentTarget.value
          setDraft(pending.current)
          setError(null)
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return
          if (e.key === 'Enter') {
            e.preventDefault()
            e.currentTarget.blur()
          } else if (e.key === 'Escape') {
            pending.current = null
            setDraft(null)
          }
        }}
      />
      {error && (
        <span id={errorId} role="alert" className="block text-danger">
          {error}
        </span>
      )}
    </label>
  )
}
