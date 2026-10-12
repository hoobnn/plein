/**
 * 由 JSON Schema（zod.toJSONSchema 生成，含 meta 提示）自动生成的表单。
 * 插件不写 UI：平台设置、以后的节点参数都用它渲染。
 */

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

const field =
  'h-9 w-full rounded-lg bg-surface-2 px-3 text-sm text-ink outline-none ring-1 ring-line focus:ring-accent/60'

export function SchemaForm({
  schema,
  value,
  onChange,
}: {
  schema: ObjectSchema
  value: Record<string, unknown>
  onChange(next: Record<string, unknown>): void
}) {
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
            <select
              id={id}
              className={field}
              value={String(current ?? '')}
              onChange={(e) => set(key, e.target.value)}
            >
              {f.enum.map((o) => (
                <option key={String(o)} value={String(o)}>
                  {String(o)}
                </option>
              ))}
            </select>
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
          <label key={key} htmlFor={id} className="flex flex-col gap-1 text-sm">
            <span className="text-ink-muted">{label}</span>
            {control}
            {f.description && <span className="text-xs text-ink-muted">{f.description}</span>}
          </label>
        )
      })}
    </div>
  )
}
