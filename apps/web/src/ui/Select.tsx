import { Select as Base } from '@base-ui/react/select'
import { type ReactNode, useRef } from 'react'
import { flushSync } from 'react-dom'
import { cn } from './cn'
import { Icon } from './icons'
import { claimMenuEscape } from './menuEscape'

export interface SelectOption {
  value: string
  label?: string
  disabled?: boolean
  icon?: ReactNode
}

/**
 * 下拉选择（Base UI Select + Nova 样式）：替代原生 <select>，弹层与应用里其他菜单一致。
 * 菜单已显示时同步完成触发器到选项的键盘导航；输入首字跳转、选择和 Esc 由 Base UI 处理。
 * 关闭后焦点回到按钮。
 */
export function Select({
  id,
  value,
  options,
  onChange,
  disabled = false,
  restoreFocusOnSelect = true,
  className = '',
  'aria-label': ariaLabel,
}: {
  id?: string
  value: string
  options: SelectOption[]
  onChange(value: string): void
  disabled?: boolean
  /** 选中后入口会退出时，由调用方安置焦点；取消仍返回原入口。 */
  restoreFocusOnSelect?: boolean
  className?: string
  'aria-label'?: string
}) {
  const items = options.map((o) => ({
    value: o.value,
    label: o.label ?? o.value,
    disabled: o.disabled,
  }))
  const popup = useRef<HTMLDivElement>(null)
  const changed = useRef(false)
  const size = className.includes('ui-input-xs')
    ? 'xs'
    : className.includes('ui-input-lg')
      ? 'lg'
      : 'md'
  const sizeClass = {
    xs: 'h-xs rounded-sm px-2 text-xs',
    md: 'h-md',
    lg: 'h-lg',
  }[size]
  return (
    <Base.Root
      disabled={disabled}
      value={value}
      items={items}
      modal={false}
      onOpenChange={(open, details) => {
        if (open) changed.current = false
        else if (details.reason === 'escape-key') claimMenuEscape(details.event)
      }}
      onValueChange={(v) => {
        if (v !== null) {
          changed.current = v !== value
          if (restoreFocusOnSelect) onChange(v)
          else flushSync(() => onChange(v))
        }
      }}
    >
      <Base.Trigger
        id={id}
        data-slot="select-trigger"
        data-size={size}
        onKeyDownCapture={(e) => {
          const menu = popup.current
          if (
            !menu ||
            menu.hasAttribute('data-closed') ||
            e.nativeEvent.isComposing ||
            e.keyCode === 229 ||
            e.metaKey ||
            e.ctrlKey ||
            e.altKey
          )
            return
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
          const options = [...menu.querySelectorAll<HTMLElement>('[role="option"]')].filter(
            (item) => item.getAttribute('aria-disabled') !== 'true',
          )
          if (!options.length) return
          const selected = Math.max(
            0,
            options.findIndex((item) => item.getAttribute('aria-selected') === 'true'),
          )
          const index =
            e.key === 'Home'
              ? 0
              : e.key === 'End'
                ? options.length - 1
                : Math.min(
                    options.length - 1,
                    Math.max(0, selected + (e.key === 'ArrowDown' ? 1 : -1)),
                  )
          e.preventDefault()
          e.stopPropagation()
          // 菜单已显示、焦点尚在触发器时，导航也必须落到正确选项，再允许确认。
          flushSync(() => options[index]!.focus({ preventScroll: true }))
          options[index]!.scrollIntoView({ block: 'nearest' })
        }}
        aria-label={ariaLabel}
        title={items.find((o) => o.value === value)?.label ?? value}
        className={cn(
          'ui-select group/select flex w-fit min-w-0 items-center justify-between gap-1.5 rounded-lg border border-line bg-transparent bg-none py-1 pr-2 pl-2.5 text-left text-sm whitespace-nowrap shadow-none transition-colors outline-none select-none focus-visible:border-accent focus-visible:ring-3 focus-visible:ring-accent-soft disabled:cursor-not-allowed disabled:opacity-40 aria-invalid:border-danger aria-invalid:ring-3 aria-invalid:ring-danger-soft',
          sizeClass,
          className,
        )}
      >
        {/* 当前值不在选项里时照原样显示 */}
        <Base.Value
          data-slot="select-value"
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          {(v: string) => (
            <>
              {options.find((o) => o.value === v)?.icon}
              <span className="truncate">{items.find((o) => o.value === v)?.label ?? v}</span>
            </>
          )}
        </Base.Value>
        <Base.Icon className="pointer-events-none flex text-ink-muted">
          <Icon name="chevronDown" />
        </Base.Icon>
      </Base.Trigger>
      <Base.Portal>
        <Base.Positioner
          alignItemWithTrigger={false}
          side="bottom"
          align="start"
          sideOffset={4}
          collisionPadding={8}
          className="isolate z-70"
        >
          <Base.Popup
            data-slot="select-content"
            finalFocus={restoreFocusOnSelect ? undefined : () => !changed.current}
            className="ui-menu ui-select-popup ui-scrollbar pointer-events-auto relative isolate origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-lg bg-menu p-1 text-sm text-ink shadow-3 ring-1 ring-line outline-none"
            ref={popup}
          >
            <Base.ScrollUpArrow className="top-0 z-10 flex w-full cursor-default items-center justify-center bg-menu py-1">
              <Icon name="chevronUp" />
            </Base.ScrollUpArrow>
            <Base.List aria-label={ariaLabel}>
              {items.map((o) => (
                <Base.Item
                  key={o.value}
                  value={o.value}
                  disabled={o.disabled}
                  data-slot="select-item"
                  className="relative flex w-full cursor-default items-center gap-1.5 rounded-md py-1 pr-8 pl-1.5 text-sm outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-40 data-highlighted:bg-hover aria-disabled:opacity-40"
                >
                  <Base.ItemText className="flex min-w-0 flex-1 gap-2 whitespace-normal break-words">
                    <span className="flex min-w-0 flex-1 items-center gap-2 whitespace-normal break-words">
                      {options.find((option) => option.value === o.value)?.icon}
                      {o.label}
                    </span>
                  </Base.ItemText>
                  <Base.ItemIndicator className="pointer-events-none absolute right-2 flex size-4 items-center justify-center">
                    <Icon name="check" />
                  </Base.ItemIndicator>
                </Base.Item>
              ))}
            </Base.List>
            <Base.ScrollDownArrow className="bottom-0 z-10 flex w-full cursor-default items-center justify-center bg-menu py-1">
              <Icon name="chevronDown" />
            </Base.ScrollDownArrow>
          </Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  )
}
