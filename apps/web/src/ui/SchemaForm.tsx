/**
 * 由 JSON Schema（zod.toJSONSchema 生成，含 meta 提示）自动生成的表单。
 * 插件不写 UI：平台设置、以后的节点参数都用它渲染。
 */

import { useId, useRef, useState } from 'react'
import { voiceOf } from '@plein/nodes'
import { clampNumber, type NumberDraft, resolveNumberDraft } from './numberDraft'
import { Select } from './Select'
import { enumField } from './enumField'
import { VoicePicker } from './VoicePicker'

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
  onNumberEdit,
  readValue,
  dense = false,
}: {
  schema: ObjectSchema
  value: Record<string, unknown>
  onChange(next: Record<string, unknown>): void
  /** 数字草稿开始编辑；正式值仍在失焦或回车时提交。 */
  onNumberEdit?(): void
  readValue?(): Record<string, unknown>
  /** 弹层里用 32 高的控件；默认是设置页的 36 高 */
  dense?: boolean
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
        const current = value[key] === undefined ? f.default : value[key]
        const label = f.title ?? key
        const help = f.description ?? rangeOf(f)
        let control: React.ReactNode
        // 没有默认值的选项和开关多一个「默认」：不传，用平台自己的默认
        const optional = f.default === undefined
        if (f.enum || (f.type === 'boolean' && optional)) {
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
              placeholder={f.placeholder}
              value={String(current ?? '')}
              onChange={(e) => set(key, e.target.value)}
            />
          )
        }
        return (
          <div key={key} className="ui-field">
            <label htmlFor={id} className="ui-label">
              {label}
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

/** 取值范围的说明，如“1–4 之间的整数” */
function rangeOf(f: FieldSchema) {
  if (f.minimum === undefined && f.maximum === undefined) return undefined
  const kind = f.type === 'integer' ? '的整数' : ''
  if (f.minimum !== undefined && f.maximum !== undefined)
    return `${f.minimum}–${f.maximum} 之间${kind}`
  return f.minimum !== undefined ? `不小于 ${f.minimum}` : `不大于 ${f.maximum}`
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
  onEdit,
  readValue,
  describedBy,
}: {
  id: string
  field: FieldSchema
  className: string
  value: number | undefined
  onChange(v: number | undefined): void
  onEdit?(): void
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
    if (result.kind === 'invalid') return setInvalid(true)
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
      placeholder={f.placeholder ?? (f.default === undefined ? '随机' : String(f.default))}
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
    <div id={`${id}-conflict`} className="flex flex-col gap-2 rounded-lg bg-fill p-2">
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
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-3">
        <input
          type="range"
          aria-label={f.title}
          aria-describedby={describedBy}
          className="min-w-0 flex-1"
          min={f.minimum}
          max={f.maximum}
          step="any"
          value={shown ?? f.minimum}
          onChange={(e) => choose(Number(e.target.value))}
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
