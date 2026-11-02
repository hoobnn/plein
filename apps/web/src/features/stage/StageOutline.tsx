import { STAGE_BLOCKS, type StageBlockKind } from '@plein/nodes'
import { Menu } from '@base-ui/react/menu'
import { Icon } from '../../ui/icons'
import { useDialogMenu } from '../../ui/useDialogMenu'

/** 添加场景件：加号弹出种类菜单 */
export function AddBlock({
  onPick,
  disabled,
}: {
  onPick(kind: StageBlockKind): void
  disabled: boolean
}) {
  const menu = useDialogMenu()
  return (
    <Menu.Root modal={false} open={menu.open} onOpenChange={menu.onOpenChange}>
      <Menu.Trigger
        {...menu.triggerProps}
        aria-label="添加场景件"
        title="添加场景件"
        disabled={disabled}
        className="ui-btn ui-btn-xs ui-btn-quiet ui-icon-btn"
      >
        <Icon name="plus" size={14} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner
          side="bottom"
          align="end"
          sideOffset={6}
          collisionPadding={8}
          className="z-70"
        >
          <Menu.Popup
            aria-label="添加场景件"
            className="ui-menu pointer-events-auto w-32 outline-none"
          >
            {STAGE_BLOCKS.map((b) => (
              <Menu.Item key={b.id} className="ui-menu-item" onClick={() => onPick(b.id)}>
                {b.label}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}

export function OutlineGroup({
  title,
  action,
  children,
}: {
  title: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="stage-group">
      <header className="stage-group-head">
        <h3 className="ui-section-title">{title}</h3>
        {action}
      </header>
      <div className="flex flex-col gap-0.5">{children}</div>
    </section>
  )
}

export function OutlineItem(props: {
  active: boolean
  onClick(): void
  label: string
  extra?: string
  swatch?: string
  icon?: 'cube' | 'video'
}) {
  return (
    <button
      type="button"
      className="stage-item"
      data-active={props.active || undefined}
      aria-pressed={props.active}
      onClick={props.onClick}
    >
      {props.swatch ? (
        <span className="stage-swatch" style={{ background: props.swatch }} />
      ) : (
        <Icon name={props.icon ?? 'cube'} size={14} />
      )}
      <span className="min-w-0 flex-1 truncate">{props.label}</span>
      {props.extra && <span className="text-ink-subtle">{props.extra}</span>}
    </button>
  )
}
