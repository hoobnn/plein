/**
 * 由 JSON Schema（zod.toJSONSchema 生成，含 meta 提示）自动生成的表单。
 * 插件不写 UI：平台设置、以后的节点参数都用它渲染。
 */

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
  const set = (key: string, v: unknown) => onChange({ ...value, [key]: v })
  return (
    <div className="flex flex-col gap-3">
      {props.map(([key, f]) => {
        const id = `field-${key}`
        const current = value[key] ?? f.default
        const label = f.title ?? key
        let control: React.ReactNode
        if (f.enum) {
          control = (
            <Select
              id={id}
              className={field}
              value={String(current ?? '')}
              options={f.enum.map((o) => ({ value: String(o) }))}
              onChange={(v) => set(key, v)}
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
            <input
              id={id}
              type="number"
              className={field}
              min={f.minimum}
              max={f.maximum}
              step={f.type === 'integer' ? 1 : 'any'}
              value={current === undefined ? '' : String(current)}
              onChange={(e) => set(key, e.target.value === '' ? undefined : Number(e.target.value))}
            />
          )
        } else if (f.widget === 'textarea') {
          control = (
            <textarea
              id={id}
              className={`${field} h-24 py-2`}
              placeholder={f.placeholder}
              value={String(current ?? '')}
              onChange={(e) => set(key, e.target.value)}
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
            {f.description && <span className="ui-help">{f.description}</span>}
          </label>
        )
      })}
    </div>
  )
}
