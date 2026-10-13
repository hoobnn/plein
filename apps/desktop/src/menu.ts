import type { DesktopMenuCommand } from '@plein/protocol'
import { app, type BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'
import { isDev } from './paths'

/** checkUpdates 为空时（开发模式、非 macOS）不显示「检查更新…」 */
export function installMenu(
  showWindow: () => BrowserWindow | null,
  checkUpdates: (() => void) | null = null,
) {
  const mac = process.platform === 'darwin'
  const command = (action: DesktopMenuCommand) => () => {
    const win = showWindow()
    if (!win) return
    if (win.webContents.isLoadingMainFrame()) {
      win.webContents.once('did-finish-load', () => {
        if (!win.isDestroyed()) win.webContents.send('plein:menu-command', action)
      })
    } else win.webContents.send('plein:menu-command', action)
  }
  const settings: MenuItemConstructorOptions = {
    label: '设置…',
    accelerator: 'CmdOrCtrl+,',
    click: command('settings'),
  }
  const template: MenuItemConstructorOptions[] = [
    ...(mac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              ...(checkUpdates
                ? [{ label: '检查更新…', click: checkUpdates } satisfies MenuItemConstructorOptions]
                : []),
              { type: 'separator' },
              settings,
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    {
      label: mac ? '文件' : '文件(&F)',
      submenu: mac
        ? [{ role: 'close' }]
        : [settings, { type: 'separator' }, { role: 'close' }, { role: 'quit' }],
    },
    {
      label: mac ? '编辑' : '编辑(&E)',
      submenu: [
        { label: '撤销', accelerator: 'CmdOrCtrl+Z', click: command('undo') },
        { label: '重做', accelerator: mac ? 'Cmd+Shift+Z' : 'Ctrl+Y', click: command('redo') },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { type: 'separator' },
        { label: '全选', accelerator: 'CmdOrCtrl+A', click: command('selectAll') },
        ...(mac
          ? ([
              { type: 'separator' },
              { label: '语音', submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }] },
            ] satisfies MenuItemConstructorOptions[])
          : []),
      ],
    },
    {
      label: mac ? '显示' : '查看(&V)',
      submenu: [
        { role: 'togglefullscreen' },
        ...(isDev
          ? ([
              { type: 'separator' },
              { role: 'reload' },
              { role: 'forceReload' },
              { role: 'toggleDevTools' },
            ] as MenuItemConstructorOptions[])
          : []),
      ],
    },
    { role: 'windowMenu', label: mac ? '窗口' : '窗口(&W)' },
    ...(!mac
      ? [
          {
            role: 'help',
            label: '帮助(&H)',
            submenu: [{ role: 'about' }],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  if (mac)
    app.dock?.setMenu(
      Menu.buildFromTemplate([
        {
          label: '打开 Plein',
          click: () => {
            showWindow()
          },
        },
      ]),
    )
}
