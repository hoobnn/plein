import { Select as Base } from '@base-ui/react/select'
import { Icon } from './icons'

export interface SelectOption {
  value: string
  label?: string
}

/**
 * 下拉选择（Base UI Select）：替代原生 <select>，弹层与应用里其他菜单一致。
 * 键盘上下选、回车确认、输入首字跳转、Esc 关闭都由 Base UI 处理，关闭后焦点回到按钮。
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
            aria-label={ariaLabel}
            className="ui-menu ui-select-popup ui-scrollbar pointer-events-auto overflow-y-auto outline-none"
          >
            <Base.List>
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
