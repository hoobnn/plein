import { Menu } from '@base-ui/react/menu'
import { useEffect } from 'react'
import { useMediaLibrary } from '../features/media-library/store'
import { useCheckpoints } from '../features/checkpoints/store'
import { useLibrary } from '../features/library/store'
import { useTheme } from '../stores/theme'
import { Icon } from '../ui/icons'
import { ThemeToggle, THEME_OPTIONS } from '../ui/ThemeToggle'
import { useDialogMenu } from '../ui/useDialogMenu'

export function EditorActions({
  remote,
  projectId,
  canvasId,
  onOpenSettings,
}: {
  remote: boolean
  projectId?: string
  canvasId: string | null
  onOpenSettings(): void
}) {
  const menu = useDialogMenu()
  const { close } = menu
  useEffect(() => {
    const wide = window.matchMedia('(min-width: 1280px)')
    const changed = () => {
      if (wide.matches) close()
    }
    changed()
    wide.addEventListener('change', changed)
    return () => wide.removeEventListener('change', changed)
  }, [close])
  const pref = useTheme((s) => s.pref)
  const setPref = useTheme((s) => s.setPref)
  const actions = remote
    ? [
        {
          label: '素材',
          icon: 'image' as const,
          run: () => useMediaLibrary.getState().show({ projectId }),
        },
        {
          label: '检查点',
          icon: 'history' as const,
          disabled: !projectId,
          run: () => {
            if (projectId && canvasId) useCheckpoints.getState().show({ projectId, canvasId })
          },
        },
        {
          label: '资产库',
          icon: 'library' as const,
          hint: '资产库：角色、场景、道具、风格、特效',
          run: () => useLibrary.getState().show('character'),
        },
      ]
    : []
  return (
    <>
      <div className="app-actions ui-bar pointer-events-auto hidden flex-none xl:flex">
        {actions.map((action) => (
          <button
            key={action.label}
            type="button"
            onClick={action.run}
            title={action.hint}
            disabled={action.disabled}
            className="ui-bar-btn gap-1.5"
          >
            <Icon name={action.icon} />
            {action.label}
          </button>
        ))}
        {remote && <div className="ui-bar-sep" />}
        <ThemeToggle />
        {remote && (
          <>
            <div className="ui-bar-sep" />
            <button
              type="button"
              onClick={onOpenSettings}
              aria-label="设置"
              title="设置"
              className="ui-bar-btn"
            >
              <Icon name="settings" />
            </button>
          </>
        )}
      </div>
      <div className="app-actions ui-bar pointer-events-auto flex-none xl:hidden">
        <Menu.Root
          modal={false}
          open={menu.open}
          onOpenChange={(next, details) => {
            if (next && window.matchMedia('(min-width: 1280px)').matches) {
              details.cancel()
              return
            }
            menu.onOpenChange(next, details)
          }}
        >
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
            aria-label="画布工具"
            title="画布工具"
            className="ui-bar-btn"
          >
            <Icon name="sliders" />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner
              side="bottom"
              align="end"
              sideOffset={8}
              collisionPadding={8}
              className="z-70"
            >
              <Menu.Popup aria-label="画布工具" className="ui-menu w-56 outline-none">
                {actions.map((action) => (
                  <Menu.Item
                    key={action.label}
                    onClick={action.run}
                    disabled={action.disabled}
                    className="ui-menu-item"
                  >
                    <Icon name={action.icon} />
                    {action.label}
                  </Menu.Item>
                ))}
                <div className="ui-menu-label">主题</div>
                <Menu.RadioGroup value={pref} onValueChange={setPref}>
                  {THEME_OPTIONS.map((theme) => (
                    <Menu.RadioItem
                      key={theme.pref}
                      value={theme.pref}
                      closeOnClick
                      className="ui-menu-item"
                    >
                      <Icon name={theme.icon} />
                      <span className="flex-1">{theme.label}</span>
                      <Menu.RadioItemIndicator>
                        <Icon name="check" size={14} />
                      </Menu.RadioItemIndicator>
                    </Menu.RadioItem>
                  ))}
                </Menu.RadioGroup>
                {remote && (
                  <Menu.Item onClick={onOpenSettings} className="ui-menu-item">
                    <Icon name="settings" />
                    设置
                  </Menu.Item>
                )}
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      </div>
    </>
  )
}
