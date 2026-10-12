import type { DesktopBridge } from '@plein/protocol'
import { contextBridge, ipcRenderer } from 'electron'

const bridge: DesktopBridge = {
  platform: process.platform,
  openDataDir: () => ipcRenderer.invoke('plein:open-data-dir'),
}

contextBridge.exposeInMainWorld('pleinDesktop', bridge)
