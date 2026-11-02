import { cva } from 'class-variance-authority'
import type { ReactNode } from 'react'
import { cn } from './cn'
import { Icon, type IconName } from './icons'
import { SlidePill } from './Slide'

export interface SegmentedOption<T extends string> {
  value: T
  label: string
  icon?: IconName
  /** 跟在文字后面的弱色补充（如数量） */
  extra?: ReactNode
}

const itemVariants = cva(
  'ui-seg-item inline-flex shrink-0 items-center justify-center gap-1 rounded-lg text-sm font-medium whitespace-nowrap transition-colors hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-40',
  {
    variants: {
      size: {
        md: 'h-md min-w-8 px-2.5',
        lg: 'h-lg min-w-9 px-2.5',
      },
      iconOnly: {
        true: 'px-0',
        false: '',
      },
    },
    compoundVariants: [
      { size: 'md', iconOnly: true, class: 'w-8' },
      { size: 'lg', iconOnly: true, class: 'w-9' },
    ],
    defaultVariants: { size: 'md', iconOnly: false },
  },
)

/**
 * Nova toggle-group 风格的分段控件：保留 fieldset/button、aria-pressed 和选中底色滑动。
 * iconOnly 时只显示图标，文字作为无障碍名称和悬停提示；size="lg" 是 36 高，放在面板标题旁。
 */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  iconOnly = false,
  size = 'md',
  disabled = false,
}: {
  /** 无障碍名称 */
  label: string
  options: ReadonlyArray<SegmentedOption<NoInfer<T>>>
  value: T
  onChange(value: NoInfer<T>): void
  iconOnly?: boolean
  size?: 'md' | 'lg'
  disabled?: boolean
}) {
  return (
    <fieldset
      aria-label={label}
      disabled={disabled}
      data-slot="toggle-group"
      data-size={size}
      className={cn(
        'ui-seg ui-slide group/toggle-group m-0 flex w-fit items-center gap-2 rounded-lg bg-transparent p-0 shadow-none disabled:cursor-not-allowed disabled:opacity-40',
        size === 'lg' && 'ui-seg-lg',
        iconOnly && 'ui-seg-icon',
      )}
    >
      <SlidePill variant="toggle" />
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          aria-label={iconOnly ? o.label : undefined}
          title={iconOnly ? o.label : undefined}
          onClick={() => onChange(o.value)}
          data-slot="toggle-group-item"
          className={itemVariants({ size, iconOnly })}
        >
          {o.icon && <Icon name={o.icon} size={14} />}
          {!iconOnly && o.label}
          {o.extra !== undefined && <span className="text-ink-subtle tabular-nums">{o.extra}</span>}
        </button>
      ))}
    </fieldset>
  )
}
