import { Menu } from '@base-ui/react/menu'
import { Icon } from './icons'
import { useDialogMenu } from './useDialogMenu'

/**
 * 轻量下拉（Base UI Menu）：文字 + ▾ 的安静按钮，弹出单选菜单。用在侧栏、故事板列头这类工具位。
 * 方向键移动、回车选中、Esc 关闭并把焦点还给按钮。
 */
export function MenuSelect<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T
  options: ReadonlyArray<{ value: T; label: string }>
  onChange(value: T): void
  label: string
}) {
  const current = options.find((o) => o.value === value)
  const menu = useDialogMenu()
  return (
    <Menu.Root modal={false} open={menu.open} onOpenChange={menu.onOpenChange}>
      <Menu.Trigger
        {...menu.triggerProps}
        data-plein-active={menu.open ? '' : undefined}
        onKeyDown={(event) => {
          if (
            menu.open &&
            !event.nativeEvent.isComposing &&
            (event.metaKey || event.ctrlKey) &&
            ['z', 'y'].includes(event.key.toLowerCase())
          ) {
            event.preventDefault()
            event.stopPropagation()
          }
        }}
        aria-label={label}
        className="ui-btn ui-btn-quiet ui-btn-sm gap-1 px-2 text-ink-muted"
      >
        {current?.label}
        <Icon name="chevronDown" size={12} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner
          side="bottom"
          align="start"
          sideOffset={8}
          collisionPadding={8}
          className="z-70"
        >
          <Menu.Popup
            aria-label={label}
            className="ui-menu ui-scrollbar pointer-events-auto w-40 overflow-y-auto outline-none"
          >
            <Menu.RadioGroup value={value} onValueChange={(v: T) => onChange(v)}>
              {options.map((o) => (
                <Menu.RadioItem key={o.value} value={o.value} closeOnClick className="ui-menu-item">
                  <span className="flex-1 truncate">{o.label}</span>
                  <Menu.RadioItemIndicator>
                    <Icon name="check" size={14} />
                  </Menu.RadioItemIndicator>
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}
