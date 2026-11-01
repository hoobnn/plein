import type { DesktopMenuCommand } from '@plein/protocol'
import { app, type BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'
import { isDev } from './paths'

/** checkUpdates 为空时（开发模式、非 macOS）不显示「检查更新…」 */
export function installMenu(
  showWindow: () => BrowserWindow | null,
  checkUpdates: (() => void) | null = null,
  applicationName = 'Plein',
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
            label: applicationName,
            submenu: [
              { role: 'about', label: `关于 ${applicationName}` },
              ...(checkUpdates
                ? [{ label: '检查更新…', click: checkUpdates } satisfies MenuItemConstructorOptions]
                : []),
              { type: 'separator' },
              settings,
              { type: 'separator' },
              { role: 'services', label: '服务' },
              { type: 'separator' },
              { role: 'hide', label: `隐藏 ${applicationName}` },
              { role: 'hideOthers', label: '隐藏其他应用' },
              { role: 'unhide', label: '显示全部' },
              { type: 'separator' },
              { role: 'quit', label: `退出 ${applicationName}` },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    {
      label: mac ? '文件' : '文件(&F)',
      submenu: mac
        ? [{ role: 'close', label: '关闭窗口' }]
        : [
            settings,
            { type: 'separator' },
            { role: 'close', label: '关闭窗口' },
            { role: 'quit', label: `退出 ${applicationName}` },
          ],
    },
    {
      label: mac ? '编辑' : '编辑(&E)',
      submenu: [
        { label: '撤销', accelerator: 'CmdOrCtrl+Z', click: command('undo') },
        { label: '重做', accelerator: mac ? 'Cmd+Shift+Z' : 'Ctrl+Y', click: command('redo') },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '拷贝' },
        { role: 'paste', label: '粘贴' },
        { type: 'separator' },
        { label: '全选', accelerator: 'CmdOrCtrl+A', click: command('selectAll') },
        ...(mac
          ? ([
              { type: 'separator' },
              {
                label: '语音',
                submenu: [
                  { role: 'startSpeaking', label: '开始朗读' },
                  { role: 'stopSpeaking', label: '停止朗读' },
                ],
              },
            ] satisfies MenuItemConstructorOptions[])
          : []),
      ],
    },
    {
      label: mac ? '显示' : '查看(&V)',
      submenu: [
        { role: 'togglefullscreen', label: '切换全屏' },
        ...(isDev
          ? ([
              { type: 'separator' },
              { role: 'reload', label: '重新加载' },
              { role: 'forceReload', label: '强制重新加载' },
              { role: 'toggleDevTools', label: '切换开发者工具' },
            ] as MenuItemConstructorOptions[])
          : []),
      ],
    },
    {
      role: 'windowMenu',
      label: mac ? '窗口' : '窗口(&W)',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        ...(mac
          ? ([
              { type: 'separator' },
              { role: 'front', label: '前置全部窗口' },
            ] satisfies MenuItemConstructorOptions[])
          : []),
      ],
    },
    ...(!mac
      ? [
          {
            role: 'help',
            label: '帮助(&H)',
            submenu: [{ role: 'about', label: `关于 ${applicationName}` }],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  if (mac)
    app.dock?.setMenu(
      Menu.buildFromTemplate([
        {
          label: `打开 ${applicationName}`,
          click: () => {
            showWindow()
          },
        },
      ]),
    )
}
