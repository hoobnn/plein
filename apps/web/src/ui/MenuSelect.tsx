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
        data-slot="menu-trigger"
        className="ui-btn ui-btn-quiet ui-btn-sm gap-1 rounded-md border border-transparent bg-transparent px-2 font-medium text-ink-muted hover:bg-hover hover:text-ink aria-expanded:bg-hover aria-expanded:text-ink"
      >
        {current?.label}
        <Icon name="chevronDown" size={12} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner
          side="bottom"
          align="start"
          sideOffset={4}
          collisionPadding={8}
          className="isolate z-70"
        >
          <Menu.Popup
            aria-label={label}
            data-slot="menu-content"
            className="ui-menu ui-scrollbar pointer-events-auto w-40 origin-(--transform-origin) overflow-y-auto rounded-lg bg-menu p-1 text-sm text-ink shadow-3 ring-1 ring-line outline-none"
          >
            <Menu.RadioGroup value={value} onValueChange={(v: T) => onChange(v)}>
              {options.map((o) => (
                <Menu.RadioItem
                  key={o.value}
                  value={o.value}
                  closeOnClick
                  data-slot="menu-item"
                  className="relative flex w-full cursor-default items-center gap-1.5 rounded-md py-1 pr-8 pl-1.5 text-sm outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-40 data-highlighted:bg-hover"
                >
                  <span className="flex-1 truncate">{o.label}</span>
                  <Menu.RadioItemIndicator className="pointer-events-none absolute right-2 flex size-4 items-center justify-center">
                    <Icon name="check" />
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
