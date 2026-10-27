import { useEffect, useState } from 'react'

export function PoseControl({
  label,
  value,
  min,
  max,
  disabled,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  disabled: boolean
  onChange(value: number): void
}) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  const commit = () => {
    const number = Number(draft)
    const next =
      draft.trim() && Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : value
    setDraft(String(next))
    onChange(next)
  }
  return (
    <label className="ui-field">
      <span className="ui-label">{label}</span>
      <div className="flex items-center gap-3">
        <input
          type="range"
          aria-label={`${label}滑块`}
          min={min}
          max={max}
          value={value}
          disabled={disabled}
          className="min-w-0 flex-1"
          onChange={(event) => onChange(Number(event.target.value))}
        />
        <input
          type="number"
          aria-label={label}
          min={min}
          max={max}
          value={draft}
          disabled={disabled}
          className="ui-input w-20"
          onChange={(event) => {
            const text = event.target.value
            setDraft(text)
            const number = Number(text)
            if (text.trim() && Number.isFinite(number) && number >= min && number <= max)
              onChange(number)
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              commit()
            }
          }}
        />
      </div>
    </label>
  )
}
