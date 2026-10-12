import type { DesktopBridge, DesktopMenuCommand } from '@plein/protocol'
import { contextBridge, ipcRenderer } from 'electron'

const bridge: DesktopBridge = {
  platform: process.platform,
  onMenuCommand(listener) {
    const handler = (_event: Electron.IpcRendererEvent, command: DesktopMenuCommand) =>
      listener(command)
    ipcRenderer.on('plein:menu-command', handler)
    return () => {
      ipcRenderer.removeListener('plein:menu-command', handler)
    }
  },
  nativeEdit: (command) => ipcRenderer.invoke('plein:native-edit', command),
  openDataDir: () => ipcRenderer.invoke('plein:open-data-dir'),
}

contextBridge.exposeInMainWorld('pleinDesktop', bridge)
