import type { ReactNode } from 'react'
import { Icon, type IconName } from './icons'
import { SlidePill } from './Slide'

export interface SegmentedOption<T extends string> {
  value: T
  label: string
  icon?: IconName
  /** 跟在文字后面的弱色补充（如数量） */
  extra?: ReactNode
}

/**
 * 分段控件：选中底色在项之间滑动。筛选、范围、主题切换都用它。
 * iconOnly 时只显示图标，文字作为无障碍名称和悬停提示；size="lg" 是 32 高、13 号字，放在面板标题旁。
 */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  iconOnly = false,
  size = 'md',
}: {
  /** 无障碍名称 */
  label: string
  options: ReadonlyArray<SegmentedOption<NoInfer<T>>>
  value: T
  onChange(value: NoInfer<T>): void
  iconOnly?: boolean
  size?: 'md' | 'lg'
}) {
  return (
    <fieldset aria-label={label} className={`ui-seg ui-slide ${size === 'lg' ? 'ui-seg-lg' : ''}`}>
      <SlidePill variant="seg" />
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          aria-label={iconOnly ? o.label : undefined}
          title={iconOnly ? o.label : undefined}
          onClick={() => onChange(o.value)}
          className="ui-seg-item"
        >
          {o.icon && <Icon name={o.icon} size={14} />}
          {!iconOnly && o.label}
          {o.extra !== undefined && <span className="text-ink-subtle tabular-nums">{o.extra}</span>}
        </button>
      ))}
    </fieldset>
  )
}
