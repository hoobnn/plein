// 隐藏窗口合同仅提供页面需要的桥接形状；不替代正式 preload / IPC 的安全合同。
const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('pleinDesktop', {
  platform: process.platform,
  nativeEdit: (action) => ipcRenderer.invoke('plein:native-edit', action),
  onMenuCommand(listener) {
    const handler = (_event, action) => listener(action)
    ipcRenderer.on('plein:menu-command', handler)
    return () => ipcRenderer.off('plein:menu-command', handler)
  },
  openDataDir: async () => {},
  onOpenNode: () => () => {},
  onSaved: () => () => {},
  showSavedFile: async () => {},
  getUpdateState: async () => ({
    phase: 'unavailable',
    currentVersion: 'contract',
    reason: '原生编辑合同不检查更新',
  }),
  checkForUpdates: async () => {},
  downloadUpdate: async () => {},
  installUpdate: async () => {},
  onUpdateState: () => () => {},
})
