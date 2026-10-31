import { useState } from 'react'
import { parseAspect } from '@plein/doc'
import { aspectLabel, type FieldSchema } from '../../canvas/nodes'
import { Icon } from '../../ui/icons'
import { Popover } from '../../ui/Popover'
import { Presence } from '../../ui/Presence'
import { type ObjectSchema, SchemaForm } from '../../ui/SchemaForm'
import { AspectGlyph, AutoAspectGlyph } from './AspectGlyph'

/** 所选模型自带的参数，和通用参数一起放进「更多参数」 */
export interface ModelOptions {
  title: string
  schema: ObjectSchema
  value: Record<string, unknown>
  onChange(next: Record<string, unknown>): void
  readValue?(): Record<string, unknown>
}

/** 模型、枚举、音频开关和小范围整数放进参数胶囊，其余进“更多参数” */
export function isMainField(key: string, f: FieldSchema) {
  if (f.widget === 'model' || f.widget === 'audio' || f.enum) return true
  return f.type === 'integer' && (key === 'count' || key === 'duration')
}

/** 数量的单位：图片按张，视频按个 */
export const countUnit = (f: FieldSchema) => (f.title?.includes('张') ? '张' : '个')

/** 参数值的简写：画幅原样、张数“1 张”、时长“5s”；音频开关在摘要末尾画成图标 */
function shortValue(key: string, f: FieldSchema, v: unknown) {
  if (f.widget === 'resolution') return v ? String(v) : '默认画质'
  if (f.widget === 'audio') return null
  if (v === undefined || v === '') return null
  if (key === 'count') return `${v} ${countUnit(f)}`
  if (key === 'duration') return `${v}s`
  if (f.enum) return aspectLabel(v)
  return `${f.title ?? key} ${v}`
}

/** 参数胶囊：一行摘要（16:9 · 1 张 · 5s），点开是可视化的参数面板 */
export function ParamsPill({
  fields,
  rest,
  params,
  readParams,
  aspect,
  options,
  fixed = [],
  onChange,
}: {
  fields: Array<[string, FieldSchema]>
  rest: Record<string, FieldSchema>
  params: Record<string, unknown>
  readParams?(): Record<string, unknown>
  aspect?: string
  /** 不可调、但摘要里要写出来的值 */
  fixed?: string[]
  options?: ModelOptions
  onChange(key: string, v: unknown): void
}) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const [more, setMore] = useState(false)
  const summary = [...fields.map(([k, f]) => shortValue(k, f, params[k])), ...fixed]
    .filter(Boolean)
    .join(' · ')
  const hasRest = Object.keys(rest).length > 0
  const audio = fields.find(([, f]) => f.widget === 'audio')
  const audioOn = audio ? (params[audio[0]] ?? audio[1].default) !== false : false
  const ratio = aspect ? parseAspect(params[aspect]) : null
  return (
    <>
      <button
        type="button"
        aria-label="参数"
        aria-expanded={!!anchor}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
        className="plein-generator-params ui-btn ui-btn-menu min-w-0 max-w-full"
      >
        {ratio ? (
          <AspectGlyph ratio={ratio} size={16} />
        ) : aspect && params[aspect] === 'auto' ? (
          <AutoAspectGlyph size={16} />
        ) : (
          <Icon name="sliders" />
        )}
        <span className="min-w-0 text-left text-sm whitespace-nowrap tabular-nums">
          {summary || '参数'}
        </span>
        {audio && (
          <span title={audioOn ? '生成音频' : '不生成音频'} className="flex items-center">
            <Icon name={audioOn ? 'sound' : 'mute'} size={14} />
          </span>
        )}
        <Icon name="chevronDown" size={14} />
      </button>
      <Presence>
        {anchor && (
          <Popover anchor={anchor} onClose={() => setAnchor(null)} label="参数" width={392}>
            <div className="flex flex-col gap-4 p-(--panel-pad)">
              {fields.map(([k, f]) => (
                <ParamControl
                  key={k}
                  name={k}
                  field={f}
                  value={params[k]}
                  aspect={k === aspect}
                  onChange={(v) => onChange(k, v)}
                />
              ))}
              {(hasRest || options) && (
                <div className="border-t border-line pt-3">
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => setMore(!more)}
                      aria-expanded={more}
                      className="flex min-w-0 flex-1 items-center justify-between text-xs text-ink-muted transition-colors hover:text-ink"
                    >
                      更多参数
                      <span className={`transition-transform ${more ? 'rotate-180' : ''}`}>
                        <Icon name="chevronDown" size={14} />
                      </span>
                    </button>
                    {more && options && (
                      <button
                        type="button"
                        className="ui-btn ui-btn-xs ui-btn-secondary flex-none"
                        onClick={() => options.onChange({})}
                      >
                        恢复模型默认参数
                      </button>
                    )}
                  </div>
                  {more && (
                    <div className="flex flex-col gap-3 pt-3">
                      {options && (
                        <SchemaForm
                          dense
                          schema={options.schema}
                          value={options.value}
                          readValue={options.readValue}
                          onChange={options.onChange}
                        />
                      )}
                      {hasRest && (
                        <SchemaForm
                          dense
                          schema={{ properties: rest }}
                          value={params}
                          readValue={readParams}
                          onChange={(next) => {
                            for (const k of Object.keys(rest))
                              if (next[k] !== params[k]) onChange(k, next[k])
                          }}
                        />
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </Popover>
        )}
      </Presence>
    </>
  )
}

/** 等分分段的滑块定位：项数与选中序号交给 CSS 算位置 */
const segSlider = (n: number, i: number) => ({
  style: { '--seg-n': n, '--seg-i': i } as React.CSSProperties,
  'data-seg-empty': i < 0 ? '' : undefined,
})

/** 参数面板里的一个参数：画幅用形状按钮，少量选项用分段按钮，范围用滑块 */
function ParamControl({
  name,
  field,
  value,
  aspect,
  onChange,
}: {
  name: string
  field: FieldSchema
  value: unknown
  aspect: boolean
  onChange(v: unknown): void
}) {
  const label = field.title ?? name
  const segment = (key: string, pressed: boolean, onClick: () => void, body: React.ReactNode) => (
    <button
      key={key}
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className="ui-seg-item"
    >
      {body}
    </button>
  )
  let control: React.ReactNode
  if (field.widget === 'audio') {
    const on = (value ?? field.default) !== false
    control = (
      <fieldset aria-label={label} className="ui-seg ui-seg-block" {...segSlider(2, on ? 0 : 1)}>
        {segment(
          'on',
          on,
          () => onChange(true),
          <>
            <Icon name="sound" size={14} />
            有声
          </>,
        )}
        {segment(
          'off',
          !on,
          () => onChange(false),
          <>
            <Icon name="mute" size={14} />
            无声
          </>,
        )}
      </fieldset>
    )
  } else if (field.enum && aspect) {
    control = (
      <fieldset
        aria-label={label}
        className="ui-seg ui-seg-block ui-seg-tall ui-seg-aspect"
        {...segSlider(
          field.enum.length,
          field.enum.findIndex((o) => String(value) === String(o)),
        )}
      >
        {field.enum.map((o) =>
          segment(
            String(o),
            String(value) === String(o),
            () => onChange(o),
            <>
              {o === 'auto' ? (
                <AutoAspectGlyph size={20} />
              ) : (
                <AspectGlyph ratio={parseAspect(o) ?? 1} size={20} />
              )}
              <span className="tabular-nums">{aspectLabel(o)}</span>
            </>,
          ),
        )}
      </fieldset>
    )
  } else if (field.enum) {
    control = (
      <fieldset
        aria-label={label}
        className="ui-seg ui-seg-block"
        {...segSlider(
          field.enum.length,
          field.enum.findIndex((o) => String(value ?? '') === String(o)),
        )}
      >
        {field.enum.map((o) =>
          segment(
            String(o),
            String(value ?? '') === String(o),
            () => onChange(o),
            String(o) || '默认',
          ),
        )}
      </fieldset>
    )
  } else {
    const min = field.minimum ?? 1
    const max = field.maximum ?? min + 9
    const n = Number(value ?? field.default ?? min)
    control =
      max - min <= 5 ? (
        <fieldset
          aria-label={label}
          className="ui-seg ui-seg-block"
          {...segSlider(max - min + 1, n >= min && n <= max ? n - min : -1)}
        >
          {Array.from({ length: max - min + 1 }, (_, i) => min + i).map((v) =>
            segment(String(v), n === v, () => onChange(v), v),
          )}
        </fieldset>
      ) : (
        <div className="flex items-center gap-3">
          <input
            type="range"
            aria-label={label}
            min={min}
            max={max}
            step={1}
            value={n}
            onChange={(e) => onChange(Number(e.target.value))}
            className="flex-1"
          />
          <span className="ui-chip w-14 justify-center tabular-nums">
            {n}
            {name === 'duration' ? ' 秒' : ''}
          </span>
        </div>
      )
  }
  return (
    <div className="flex flex-col gap-2">
      <span className="ui-section-title">{label.replace(/（.*）/, '')}</span>
      {control}
    </div>
  )
}
