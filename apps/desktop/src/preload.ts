import type { DesktopBridge, DesktopMenuCommand, DesktopUpdateProgress } from '@plein/protocol'
import { contextBridge, ipcRenderer } from 'electron'

const bridge: DesktopBridge = {
  platform: process.platform,
  onMenuCommand: (listener) => on<DesktopMenuCommand>('plein:menu-command', listener),
  nativeEdit: (command) => ipcRenderer.invoke('plein:native-edit', command),
  openDataDir: () => ipcRenderer.invoke('plein:open-data-dir'),
  onOpenNode(listener) {
    const off = on('plein:open-node', listener)
    ipcRenderer.send('plein:open-node-ready')
    return off
  },
  onSaved: (listener) => on('plein:saved', listener),
  showSavedFile: (path) => ipcRenderer.invoke('plein:show-saved-file', path),
  onUpdateProgress: (listener) =>
    on<DesktopUpdateProgress | null>('plein:update-progress', listener),
}

function on<T>(channel: string, listener: (value: T) => void) {
  const handler = (_event: Electron.IpcRendererEvent, value: T) => listener(value)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

contextBridge.exposeInMainWorld('pleinDesktop', bridge)
