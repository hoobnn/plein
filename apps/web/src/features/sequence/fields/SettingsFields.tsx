import type { CSSProperties, ReactNode } from 'react'
import { Switch } from '../../../ui/Switch'

/** 检查器里的一组设置：小标题加若干行 */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="seq-section">
      <h3 className="ui-section-title">{title}</h3>
      {children}
    </section>
  )
}

/** 一行设置：左边固定宽的名字，右边控件铺满 */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="seq-field">
      <span className="seq-field-label">{label}</span>
      <div className="seq-field-control">{children}</div>
    </div>
  )
}

/** 开关行：名字和说明在左，开关在右，整行可点 */
export function SwitchRow(props: {
  label: string
  help?: string
  checked: boolean
  disabled?: boolean
  onChange(v: boolean): void
}) {
  return (
    <div className="seq-switch-row" data-disabled={props.disabled || undefined}>
      <div className="min-w-0">
        <div className="text-sm text-ink">{props.label}</div>
        {props.help && <div className="ui-help">{props.help}</div>}
      </div>
      <Switch
        label={props.label}
        checked={props.checked}
        disabled={props.disabled}
        onChange={props.onChange}
      />
    </div>
  )
}

/** 等分分段：选项少的参数（画幅、分辨率、字幕样式），选中底色滑过去 */
export function SegBlock<T extends string>(props: {
  label: string
  options: ReadonlyArray<{ value: T; label: string }>
  value: T
  onChange(v: T): void
}) {
  const i = props.options.findIndex((o) => o.value === props.value)
  return (
    <fieldset
      aria-label={props.label}
      className="ui-seg ui-seg-block"
      style={{ '--seg-n': props.options.length, '--seg-i': i } as CSSProperties}
    >
      {props.options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === props.value}
          className="ui-seg-item"
          onClick={() => props.onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </fieldset>
  )
}
