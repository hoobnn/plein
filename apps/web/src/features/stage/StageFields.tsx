import { useState } from 'react'
import { Slider as SliderControl } from '../../ui/Slider'

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="stage-field">
      <span className="stage-field-label">{label}</span>
      <span className="stage-field-control">{children}</span>
    </label>
  )
}

/** 滑杆加数值：拖动时就写入，松手不用再点确定 */
export function Slider(props: {
  label: string
  value: number
  min: number
  max: number
  step: number
  unit: string
  onChange(v: number): void
}) {
  return (
    <Field label={props.label}>
      <SliderControl
        aria-label={props.label}
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onValueChange={props.onChange}
      />
      <span className="stage-value tabular-nums">
        {props.value}
        {props.unit}
      </span>
    </Field>
  )
}

export function NumberField(props: {
  label: string
  value: number
  step?: number
  onChange(v: number): void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    if (draft === null) return
    setDraft(null)
    if (!draft.trim()) return
    const v = Number(draft)
    if (Number.isFinite(v)) props.onChange(Math.max(-50, Math.min(50, v)))
  }
  return (
    <Field label={props.label}>
      <input
        type="number"
        className="ui-input w-full tabular-nums"
        step={props.step ?? 0.1}
        value={draft ?? props.value}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return
          if (e.key === 'Enter') e.currentTarget.blur()
          else if (e.key === 'Escape') {
            e.stopPropagation()
            setDraft(null)
          }
        }}
      />
    </Field>
  )
}

export function NameField(props: { value: string; onChange(v: string): void }) {
  return (
    <Field label="名字">
      <input
        className="ui-input w-full"
        maxLength={40}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </Field>
  )
}

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="stage-section">
      <h3 className="ui-section-title">{title}</h3>
      {children}
    </section>
  )
}
