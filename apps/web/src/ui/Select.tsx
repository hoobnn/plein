import { Select as Base } from '@base-ui/react/select'
import { useRef } from 'react'
import { flushSync } from 'react-dom'
import { Icon } from './icons'

export interface SelectOption {
  value: string
  label?: string
}

/**
 * 下拉选择（Base UI Select）：替代原生 <select>，弹层与应用里其他菜单一致。
 * 菜单已显示时同步完成触发器到选项的键盘导航；输入首字跳转、选择和 Esc 由 Base UI 处理。
 * 关闭后焦点回到按钮。
 */
export function Select({
  id,
  value,
  options,
  onChange,
  className = '',
  'aria-label': ariaLabel,
}: {
  id?: string
  value: string
  options: SelectOption[]
  onChange(value: string): void
  className?: string
  'aria-label'?: string
}) {
  const items = options.map((o) => ({ value: o.value, label: o.label ?? o.value }))
  const popup = useRef<HTMLDivElement>(null)
  return (
    <Base.Root
      value={value}
      items={items}
      modal={false}
      onValueChange={(v) => {
        if (v !== null) onChange(v)
      }}
    >
      <Base.Trigger
        id={id}
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
        className={`ui-select truncate text-left ${className}`}
      >
        {/* 当前值不在选项里时照原样显示 */}
        <Base.Value>{(v: string) => items.find((o) => o.value === v)?.label ?? v}</Base.Value>
      </Base.Trigger>
      <Base.Portal>
        <Base.Positioner
          alignItemWithTrigger={false}
          side="bottom"
          align="start"
          sideOffset={8}
          collisionPadding={8}
          className="z-70"
        >
          <Base.Popup
            className="ui-menu ui-select-popup ui-scrollbar pointer-events-auto overflow-y-auto outline-none"
            ref={popup}
          >
            <Base.List aria-label={ariaLabel}>
              {items.map((o) => (
                <Base.Item key={o.value} value={o.value} className="ui-menu-item ui-select-item">
                  <Base.ItemText className="min-w-0 flex-1 truncate">{o.label}</Base.ItemText>
                  <Base.ItemIndicator className="text-accent">
                    <Icon name="check" size={14} />
                  </Base.ItemIndicator>
                </Base.Item>
              ))}
            </Base.List>
          </Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  )
}
