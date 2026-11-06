/**
 * 由 JSON Schema（zod.toJSONSchema 生成，含 meta 提示）自动生成的表单。
 * 插件不写 UI：平台设置、以后的节点参数都用它渲染。
 */

import { useId, useRef, useState } from 'react'
import { voiceOf } from '@plein/nodes'
import { clampNumber, type NumberDraft, resolveNumberDraft } from './numberDraft'
import { Select } from './Select'
import { Slider } from './Slider'
import { enumField } from './enumField'
import { VoicePicker } from './VoicePicker'

interface FieldSchema {
  type?: string
  title?: string
  description?: string
  placeholder?: string
  widget?: string
  /** datalist 的元素 id：输入框接候选列表（值由插件声明，元素由设置页渲染） */
  list?: string
  enum?: unknown[]
  minimum?: number
  maximum?: number
  /** 开区间边界：值必须严格大于 / 小于它 */
  exclusiveMinimum?: number
  exclusiveMaximum?: number
  default?: unknown
  /** 嵌套对象：递归渲染成子表单 */
  properties?: Record<string, FieldSchema>
  required?: string[]
  /** 数组元素：枚举字符串渲染成多选 */
  items?: FieldSchema
  /** 声明里的扩展：实际尺寸由画幅换算，字段本身没有固定默认值 */
  'x-aspectRatioSizes'?: Record<string, string>
  /** 枚举值的显示名 */
  labels?: Record<string, string>
}

export interface ObjectSchema {
  properties?: Record<string, FieldSchema>
  required?: string[]
}

export function SchemaForm({
  schema,
  value,
  onChange,
  onNumberEdit,
  onNumberEditEnd,
  readValue,
  dense = false,
  nested = false,
}: {
  schema: ObjectSchema
  value: Record<string, unknown>
  onChange(next: Record<string, unknown>): void
  /** 数字草稿开始编辑；正式值仍在失焦或回车时提交。 */
  onNumberEdit?(): void
  /** 数字草稿作废（输入不合法，已退回原值）；调用方据此结束「正在编辑」。 */
  onNumberEditEnd?(): void
  readValue?(): Record<string, unknown>
  /** 弹层里用 32 高的控件；默认是设置页的 36 高 */
  dense?: boolean
  /** 嵌套子表单：清空的文本按未设置处理，整个对象清空时随之撤销 */
  nested?: boolean
}) {
  const formId = useId()
  const field = dense ? 'ui-input w-full' : 'ui-input ui-input-lg w-full'
  const props = Object.entries(schema.properties ?? {})
  if (props.length === 0) return null
  // 设为 undefined 即删掉这个键：没有默认值的字段表示“交给平台默认”
  const set = (key: string, v: unknown) => {
    const next = { ...(readValue ? readValue() : value), [key]: v }
    if (v === undefined) delete next[key]
    onChange(next)
  }
  return (
    <div className="flex flex-col gap-3">
      {props.map(([key, f]) => {
        const id = `${formId}-field-${key}`
        // 实际值由别的字段推导时（如按画幅换算尺寸）没有固定默认值，不拿声明里的占位值冒充
        const current =
          value[key] === undefined ? (f['x-aspectRatioSizes'] ? undefined : f.default) : value[key]
        const label = f.title ?? key
        const help =
          f.description ??
          rangeOf(f) ??
          (f['x-aspectRatioSizes'] ? '留空时按所选画幅换算' : undefined)
        let control: React.ReactNode
        const derived = f['x-aspectRatioSizes'] !== undefined
        // 没有默认值的选项和开关多一个「默认」：不传，用平台自己的默认
        const optional = f.default === undefined
        if (f.type === 'object' && f.properties) {
          return (
            <ObjectGroup
              key={key}
              label={label}
              help={f.description}
              required={schema.required?.includes(key)}
              schema={f}
              value={isRecord(value[key]) ? value[key] : {}}
              enabled={isRecord(value[key])}
              onToggle={(on) => set(key, on ? {} : undefined)}
              readValue={() => {
                const latest = (readValue ? readValue() : value)[key]
                return isRecord(latest) ? latest : {}
              }}
              onChange={(next) => set(key, next)}
              onNumberEdit={onNumberEdit}
              onNumberEditEnd={onNumberEditEnd}
              dense={dense}
            />
          )
        } else if (f.type === 'array' && f.items?.enum && f.items.type === 'string') {
          const picked = Array.isArray(current) ? (current as unknown[]) : []
          control = (
            <div role="group" aria-label={label} className="flex flex-wrap gap-x-4 gap-y-1">
              {f.items.enum.map((option) => (
                <label key={String(option)} className="flex items-center gap-1 text-sm">
                  <input
                    type="checkbox"
                    checked={picked.includes(option)}
                    onChange={(e) => {
                      const next = e.target.checked
                        ? [...picked, option]
                        : picked.filter((item) => item !== option)
                      set(key, next.length ? next : undefined)
                    }}
                  />
                  {f.items?.labels?.[String(option)] ?? String(option)}
                </label>
              ))}
            </div>
          )
        } else if (f.type === 'array' || f.type === 'object') {
          // 没有对应控件的结构：说明清楚，别渲染成文本框存成字符串
          control = <span className="ui-help">该参数暂不支持在界面中编辑</span>
        } else if (f.enum || (f.type === 'boolean' && optional)) {
          const enumeration = enumField(
            f.enum ?? [true, false],
            current,
            f.enum ? f.labels : { true: '开', false: '关' },
          )
          control = (
            <Select
              id={id}
              aria-label={label}
              className={field}
              value={enumeration.value}
              options={[
                ...(optional ? [{ value: 'default', label: '默认' }] : []),
                ...enumeration.options,
              ]}
              onChange={(v) => set(key, enumeration.read(v))}
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
              describedBy={help ? `${id}-help` : undefined}
              className={field}
              value={value[key] as number | undefined}
              readValue={readValue ? () => readValue()[key] as number | undefined : undefined}
              onChange={(v) => set(key, v)}
              onEdit={onNumberEdit}
              onEditEnd={onNumberEditEnd}
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
        } else if (f.widget === 'voice') {
          // 旧画布里存的是裸字符串，voiceOf 照样读得出
          control = (
            <VoicePicker
              id={id}
              value={voiceOf(value)}
              onChange={(v) => set(key, v)}
              inputClassName={field}
            />
          )
        } else {
          control = (
            <input
              id={id}
              className={field}
              aria-label={label}
              placeholder={f.placeholder ?? (derived ? '跟随画幅' : undefined)}
              list={f.list}
              value={String(current ?? '')}
              onChange={(e) =>
                set(key, (derived || nested) && e.target.value === '' ? undefined : e.target.value)
              }
            />
          )
        }
        return (
          <div key={key} className="ui-field">
            <label htmlFor={id} className="ui-label">
              {label}
              {schema.required?.includes(key) && ' *'}
            </label>
            {control}
            {help && (
              <span id={`${id}-help`} className="ui-help">
                {help}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * 嵌套对象：先勾选「启用」才会写入参数（空对象也是有效值，如「联网搜索」传空对象即用默认设置），
 * 启用后展开子表单，里面按同样的规则渲染。
 */
function ObjectGroup({
  label,
  help,
  required,
  schema,
  value,
  enabled,
  readValue,
  onChange,
  onToggle,
  onNumberEdit,
  onNumberEditEnd,
  dense,
}: {
  label: string
  help?: string
  required?: boolean
  schema: FieldSchema
  value: Record<string, unknown>
  enabled: boolean
  readValue(): Record<string, unknown>
  onChange(next: Record<string, unknown>): void
  onToggle(on: boolean): void
  onNumberEdit?(): void
  onNumberEditEnd?(): void
  dense: boolean
}) {
  const missing = (schema.required ?? []).filter((k) => value[k] === undefined || value[k] === '')
  return (
    <div className="ui-field rounded-lg border border-line p-2">
      <label className="ui-label flex items-center gap-2">
        <input type="checkbox" checked={enabled} onChange={(e) => onToggle(e.target.checked)} />
        {label}
        {required && ' *'}
      </label>
      {help && <span className="ui-help">{help}</span>}
      {enabled && (
        <div className="mt-2">
          <SchemaForm
            schema={schema}
            value={value}
            readValue={readValue}
            onChange={onChange}
            onNumberEdit={onNumberEdit}
            onNumberEditEnd={onNumberEditEnd}
            dense={dense}
            nested
          />
          {missing.length > 0 && (
            <span className="ui-help text-danger">缺少必填项：{missing.join('、')}</span>
          )}
        </div>
      )}
    </div>
  )
}

/** 取值范围的说明，如“1–4 之间的整数” */
function rangeOf(f: FieldSchema) {
  const kind = f.type === 'integer' ? '的整数' : ''
  const low =
    f.minimum !== undefined
      ? `不小于 ${f.minimum}`
      : f.exclusiveMinimum !== undefined
        ? `大于 ${f.exclusiveMinimum}`
        : undefined
  const high =
    f.maximum !== undefined
      ? `不大于 ${f.maximum}`
      : f.exclusiveMaximum !== undefined
        ? `小于 ${f.exclusiveMaximum}`
        : undefined
  if (!low && !high) return undefined
  if (f.minimum !== undefined && f.maximum !== undefined)
    return `${f.minimum}–${f.maximum} 之间${kind}`
  return [low, high].filter(Boolean).join('，') + kind
}

/**
 * 数值输入：输入时只改草稿，失焦或回车时夹到范围内再写入；清空表示用平台默认值。
 * 有上下限的小数（温度、音量）配一个滑块。
 */
function NumberControl({
  id,
  field: f,
  className,
  value,
  onChange,
  onEdit,
  onEditEnd,
  readValue,
  describedBy,
}: {
  id: string
  field: FieldSchema
  className: string
  value: number | undefined
  onChange(v: number | undefined): void
  onEdit?(): void
  onEditEnd?(): void
  readValue?(): number | undefined
  describedBy?: string
}) {
  const [draft, setDraft] = useState<NumberDraft | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const current = readValue ? readValue() : value
  const conflict = draft !== null && !Object.is(draft.base, current)
  const [invalid, setInvalid] = useState(false)
  const errorId = `${id}-error`
  const choose = (v: number | undefined) => {
    setDraft(null)
    setInvalid(false)
    onChange(v)
  }
  const shown = value ?? (f.default as number | undefined)
  const commit = (input: HTMLInputElement, force = false) => {
    if (draft === null) return
    const result = resolveNumberDraft(
      draft,
      readValue ? readValue() : value,
      f,
      input.validity.badInput,
      force,
    )
    if (result.kind === 'conflict') return setDraft({ ...draft })
    setDraft(null)
    if (result.kind === 'invalid') {
      // 输入不合法：草稿作废，值退回原样。
      // 这里必须把「正在编辑」收尾，否则调用方会一直以为还有未保存的草稿，
      // 把检查按钮永久禁用，用户再也不知道自己到底改没改。
      setInvalid(true)
      onEditEnd?.()
      return
    }
    choose(result.value)
  }
  const input = (
    <input
      id={id}
      ref={inputRef}
      aria-describedby={
        [describedBy, invalid ? errorId : undefined, conflict ? `${id}-conflict` : undefined]
          .filter(Boolean)
          .join(' ') || undefined
      }
      aria-invalid={invalid || undefined}
      type="number"
      className={className}
      min={f.minimum}
      max={f.maximum}
      step={f.type === 'integer' ? 1 : 'any'}
      placeholder={f.placeholder ?? (f.default === undefined ? '默认' : String(f.default))}
      value={draft?.text ?? (value === undefined ? '' : String(value))}
      onChange={(e) => {
        setInvalid(false)
        const text = e.target.value
        setDraft((previous) => ({
          text,
          base: previous ? previous.base : readValue ? readValue() : value,
        }))
        onEdit?.()
      }}
      onBlur={(e) => commit(e.currentTarget)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
      }}
    />
  )
  const error = invalid && (
    <span id={errorId} role="alert" className="ui-help text-danger">
      请输入有效数字，已保留原值
    </span>
  )
  const resolution = conflict && (
    <div id={`${id}-conflict`} className="flex flex-col gap-2 rounded-lg bg-surface-2 p-2">
      <p role="status" className="ui-help">
        参数已更新为 {String(current ?? f.default ?? '默认')}，当前草稿尚未保存。
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="ui-btn ui-btn-secondary ui-btn-sm"
          onClick={() => {
            inputRef.current?.focus()
            setDraft(null)
            setInvalid(false)
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
      </div>
    </div>
  )
  const slider =
    f.type === 'number' &&
    f.exclusiveMinimum === undefined &&
    f.exclusiveMaximum === undefined &&
    f.minimum !== undefined &&
    f.maximum !== undefined &&
    f.maximum - f.minimum <= 10
  if (!slider)
    return (
      <>
        {input}
        {error}
        {resolution}
      </>
    )
  return (
    <div className="flex flex-col gap-(--field-gap)">
      <div className="flex items-center gap-3">
        <Slider
          aria-label={f.title}
          aria-describedby={describedBy}
          className="min-w-0 flex-1"
          min={f.minimum}
          max={f.maximum}
          step="any"
          value={shown ?? f.minimum!}
          onValueChange={choose}
          onKeyDown={(e) => {
            const direction = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key]
            if (!direction) return
            e.preventDefault()
            const next = (shown ?? f.minimum!) + (direction * (f.maximum! - f.minimum!)) / 100
            choose(clampNumber(f, Number(next.toPrecision(12))))
          }}
        />
        <div className="w-20 flex-none">{input}</div>
      </div>
      {error}
      {resolution}
    </div>
  )
}
