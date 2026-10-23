import type { DesktopBridge, DesktopMenuCommand } from '@plein/protocol'
import { contextBridge, ipcRenderer } from 'electron'

const menuListeners = new Set<(command: DesktopMenuCommand) => void>()
let pendingPanel: 'settings' | 'updates' | null = null
// 页面加载完成不等于 React 已挂载；保留这期间最后一次面板打开意图。
ipcRenderer.on('plein:menu-command', (_event, command: DesktopMenuCommand) => {
  if ((command === 'settings' || command === 'updates') && !menuListeners.size)
    pendingPanel = command
  for (const listener of menuListeners) listener(command)
})

const bridge: DesktopBridge = {
  platform: process.platform,
  onMenuCommand: (listener) => {
    menuListeners.add(listener)
    if (pendingPanel) {
      const command = pendingPanel
      pendingPanel = null
      listener(command)
    }
    return () => {
      menuListeners.delete(listener)
    }
  },
  nativeEdit: (command) => ipcRenderer.invoke('plein:native-edit', command),
  openDataDir: () => ipcRenderer.invoke('plein:open-data-dir'),
  onOpenNode(listener) {
    const off = on('plein:open-node', listener)
    ipcRenderer.send('plein:open-node-ready')
    return off
  },
  onSaved: (listener) => on('plein:saved', listener),
  showSavedFile: (path) => ipcRenderer.invoke('plein:show-saved-file', path),
  getUpdateState: () => ipcRenderer.invoke('plein:update-state'),
  checkForUpdates: () => ipcRenderer.invoke('plein:update-check'),
  downloadUpdate: () => ipcRenderer.invoke('plein:update-download'),
  installUpdate: () => ipcRenderer.invoke('plein:update-install'),
  onUpdateState: (listener) => on('plein:update-state', listener),
}

function on<T>(channel: string, listener: (value: T) => void) {
  const handler = (_event: Electron.IpcRendererEvent, value: T) => listener(value)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

contextBridge.exposeInMainWorld('pleinDesktop', bridge)
