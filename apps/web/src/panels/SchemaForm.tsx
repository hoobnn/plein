/**
 * 由 JSON Schema（zod.toJSONSchema 生成，含 meta 提示）自动生成的表单。
 * 插件不写 UI：平台设置、以后的节点参数都用它渲染。
 */

import { useState } from 'react'
import { Select } from '../ui/Select'

interface FieldSchema {
  type?: string
  title?: string
  description?: string
  placeholder?: string
  widget?: string
  enum?: unknown[]
  minimum?: number
  maximum?: number
  default?: unknown
  /** 枚举值的显示名 */
  labels?: Record<string, string>
}

export interface ObjectSchema {
  properties?: Record<string, FieldSchema>
}

export function SchemaForm({
  schema,
  value,
  onChange,
  dense = false,
}: {
  schema: ObjectSchema
  value: Record<string, unknown>
  onChange(next: Record<string, unknown>): void
  /** 弹层里用 32 高的控件；默认是设置页的 36 高 */
  dense?: boolean
}) {
  const field = dense ? 'ui-input w-full' : 'ui-input ui-input-lg w-full'
  const props = Object.entries(schema.properties ?? {})
  if (props.length === 0) return null
  // 设为 undefined 即删掉这个键：没有默认值的字段表示“交给平台默认”
  const set = (key: string, v: unknown) => {
    const next = { ...value, [key]: v }
    if (v === undefined) delete next[key]
    onChange(next)
  }
  const DEFAULT = '__default'
  return (
    <div className="flex flex-col gap-3">
      {props.map(([key, f]) => {
        const id = `field-${key}`
        const current = value[key] ?? f.default
        const label = f.title ?? key
        let control: React.ReactNode
        // 没有默认值的选项和开关多一个「默认」：不传，用平台自己的默认
        const optional = f.default === undefined
        if (f.enum) {
          control = (
            <Select
              id={id}
              className={field}
              value={current === undefined ? DEFAULT : String(current)}
              options={[
                ...(optional ? [{ value: DEFAULT, label: '默认' }] : []),
                ...f.enum.map((o) => ({ value: String(o), label: f.labels?.[String(o)] })),
              ]}
              onChange={(v) => set(key, v === DEFAULT ? undefined : v)}
            />
          )
        } else if (f.type === 'boolean' && optional) {
          control = (
            <Select
              id={id}
              className={field}
              value={current === undefined ? DEFAULT : String(current)}
              options={[
                { value: DEFAULT, label: '默认' },
                { value: 'true', label: '开' },
                { value: 'false', label: '关' },
              ]}
              onChange={(v) => set(key, v === DEFAULT ? undefined : v === 'true')}
            />
          )
        } else if (f.type === 'boolean') {
          control = (
            <input
              id={id}
              type="checkbox"
              checked={Boolean(current)}
              onChange={(e) => set(key, e.target.checked)}
            />
          )
        } else if (f.type === 'number' || f.type === 'integer') {
          control = (
            <NumberControl
              id={id}
              field={f}
              className={field}
              value={value[key] as number | undefined}
              onChange={(v) => set(key, v)}
            />
          )
        } else if (f.widget === 'textarea') {
          control = (
            <textarea
              id={id}
              className={`${field} h-24 py-2`}
              placeholder={f.placeholder}
              value={String(current ?? '')}
              onChange={(e) =>
                set(key, optional && e.target.value === '' ? undefined : e.target.value)
              }
            />
          )
        } else {
          control = (
            <input
              id={id}
              className={field}
              placeholder={f.placeholder}
              value={String(current ?? '')}
              onChange={(e) => set(key, e.target.value)}
            />
          )
        }
        return (
          <label key={key} htmlFor={id} className="ui-field">
            <span className="ui-label">{label}</span>
            {control}
            {(f.description || rangeOf(f)) && (
              <span className="ui-help">{f.description ?? rangeOf(f)}</span>
            )}
          </label>
        )
      })}
    </div>
  )
}

/** 取值范围的说明，如“1–4 之间的整数” */
export function rangeOf(f: FieldSchema) {
  if (f.minimum === undefined && f.maximum === undefined) return undefined
  const kind = f.type === 'integer' ? '的整数' : ''
  if (f.minimum !== undefined && f.maximum !== undefined)
    return `${f.minimum}–${f.maximum} 之间${kind}`
  return f.minimum !== undefined ? `不小于 ${f.minimum}` : `不大于 ${f.maximum}`
}

/** 按 schema 收拢数值：超出范围的夹到边界，整数取整 */
export function clampNumber(f: FieldSchema, n: number) {
  let v = f.type === 'integer' ? Math.round(n) : n
  if (f.minimum !== undefined) v = Math.max(f.minimum, v)
  if (f.maximum !== undefined) v = Math.min(f.maximum, v)
  return v
}

/**
 * 数值输入：输入时只改草稿，失焦或回车时夹到范围内再写入；清空表示用默认值（没有默认值时如种子为“随机”）。
 * 有上下限的小数（温度、音量）配一个滑块。
 */
function NumberControl({
  id,
  field: f,
  className,
  value,
  onChange,
}: {
  id: string
  field: FieldSchema
  className: string
  value: number | undefined
  onChange(v: number | undefined): void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const shown = value ?? (f.default as number | undefined)
  const commit = () => {
    if (draft === null) return
    setDraft(null)
    const t = draft.trim()
    if (t === '') return onChange(undefined)
    const n = Number(t)
    if (Number.isFinite(n)) onChange(clampNumber(f, n))
  }
  const input = (
    <input
      id={id}
      type="number"
      className={className}
      min={f.minimum}
      max={f.maximum}
      step={f.type === 'integer' ? 1 : 'any'}
      placeholder={f.placeholder ?? (f.default === undefined ? '随机' : String(f.default))}
      value={draft ?? (value === undefined ? '' : String(value))}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
      }}
    />
  )
  const slider =
    f.type === 'number' &&
    f.minimum !== undefined &&
    f.maximum !== undefined &&
    f.maximum - f.minimum <= 10
  if (!slider) return input
  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        aria-label={f.title}
        className="min-w-0 flex-1"
        min={f.minimum}
        max={f.maximum}
        step={(f.maximum! - f.minimum!) / 100}
        value={shown ?? f.minimum}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <div className="w-20 flex-none">{input}</div>
    </div>
  )
}
