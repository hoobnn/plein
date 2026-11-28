import { Menu } from '@base-ui/react/menu'
import { AnimatePresence } from '../ui/motion'
import { useEffect, useState } from 'react'
import { useCanvas } from '../stores/canvas'
import { useSession } from '../stores/session'
import { ExternalCanvasDialog } from '../features/external-canvas/ExternalCanvasDialog'
import { ExternalWatcher } from '../features/external-canvas/ExternalWatch'
import { useMediaLibrary } from '../features/media-library/store'
import { useCheckpoints } from '../features/checkpoints/store'
import { useLibrary } from '../features/library/store'
import { useTheme } from '../stores/theme'
import { Icon } from '../ui/icons'
import { minWidth } from '../ui/layout'
import { ThemeToggle, THEME_OPTIONS } from '../ui/ThemeToggle'
import { useDialogMenu } from '../ui/useDialogMenu'

/** 手机工作流的底部视图工具条已收起，菜单直接调用相同的引擎命令。 */
function PhoneViewActions() {
  const engine = useCanvas((s) => (s.mode === 'flow' ? s.engine : null))
  const canUndo = useCanvas((s) => s.canUndo)
  const canRedo = useCanvas((s) => s.canRedo)
  if (!engine) return null
  return (
    <>
      <Menu.Item disabled={!canUndo} onClick={() => engine.undo()} className="ui-menu-item">
        <Icon name="undo" />
        撤销
      </Menu.Item>
      <Menu.Item disabled={!canRedo} onClick={() => engine.redo()} className="ui-menu-item">
        <Icon name="redo" />
        重做
      </Menu.Item>
      <Menu.Item onClick={() => engine.zoomToFit()} className="ui-menu-item">
        <Icon name="fit" />
        适应画布
      </Menu.Item>
      <Menu.Separator className="ui-sep" />
    </>
  )
}

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
  const [phone, setPhone] = useState(() => !window.matchMedia(minWidth('sm')).matches)
  useEffect(() => {
    const wide = window.matchMedia(minWidth('xl'))
    const viewToolbar = window.matchMedia(minWidth('sm'))
    const changed = () => {
      setPhone(!viewToolbar.matches)
      if (wide.matches) close()
    }
    changed()
    wide.addEventListener('change', changed)
    viewToolbar.addEventListener('change', changed)
    return () => {
      wide.removeEventListener('change', changed)
      viewToolbar.removeEventListener('change', changed)
    }
  }, [close])
  const pref = useTheme((s) => s.pref)
  const setPref = useTheme((s) => s.setPref)
  const externalEnabled = useSession((s) => s.info?.externalCanvas === true)
  const [syncCanvas, setSyncCanvas] = useState<string | null>(null)
  const actions = remote
    ? [
        {
          label: '素材',
          icon: 'image' as const,
          run: () => useMediaLibrary.getState().show({ projectId }),
        },
        ...(externalEnabled && canvasId
          ? [
              {
                label: '即梦同步',
                icon: 'plug' as const,
                run: () => setSyncCanvas(canvasId),
              },
            ]
          : []),
        {
          label: '检查点',
          icon: 'history' as const,
          disabled: !projectId,
          // 禁用时说明原因，而不是只变灰
          disabledHint: '项目信息还在读取，稍后即可打开检查点',
          run: () => {
            if (projectId && canvasId) useCheckpoints.getState().show({ projectId, canvasId })
          },
        },
        {
          label: '资产库',
          icon: 'library' as const,
          hint: '资产库：角色、场景、道具、风格、特效、音色',
          run: () => useLibrary.getState().show('character'),
        },
      ]
    : []
  return (
    <>
      {externalEnabled && remote && canvasId && (
        <ExternalWatcher key={canvasId} canvasId={canvasId} />
      )}
      <AnimatePresence>
        {externalEnabled && remote && canvasId && canvasId === syncCanvas && (
          <ExternalCanvasDialog
            key={canvasId}
            canvasId={canvasId}
            onClose={() => setSyncCanvas(null)}
          />
        )}
      </AnimatePresence>
      <div className="app-actions ui-bar pointer-events-auto hidden flex-none xl:flex">
        {actions.map((action) => (
          <button
            key={action.label}
            type="button"
            onClick={action.run}
            title={action.disabled ? action.disabledHint : action.hint}
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
            if (next && window.matchMedia(minWidth('xl')).matches) {
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
              <Menu.Popup
                aria-label="画布工具"
                className="ui-menu ui-scrollbar max-h-(--available-height) w-56 overflow-y-auto outline-none"
              >
                {phone && <PhoneViewActions />}
                {actions.map((action) => (
                  <Menu.Item
                    key={action.label}
                    onClick={action.run}
                    disabled={action.disabled}
                    title={action.disabled ? action.disabledHint : action.hint}
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
