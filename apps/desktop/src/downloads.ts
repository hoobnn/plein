import { basename, dirname, join } from 'node:path'
import type { DesktopSaved } from '@plein/protocol'
import { type BrowserWindow, type Session, shell } from 'electron'
import { readPrefs, writePrefs } from './prefs'

/** 本次运行中保存过的文件；“在访达中显示”只接受这些路径 */
const saved = new Set<string>()

/**
 * 页面里的下载（素材原文件、导出的成片）走系统“另存为”对话框：
 * 默认放在上次选的目录，保存结束后告诉页面，页面再提供“在访达中显示”。
 */
export function handleDownloads(session: Session, window: () => BrowserWindow | null) {
  session.on('will-download', (_event, item) => {
    const name = item.getFilename()
    const dir = readPrefs().saveDir
    item.setSaveDialogOptions({
      title: '另存为',
      defaultPath: dir ? join(dir, name) : name,
    })
    item.once('done', (_e, state) => {
      const path = item.getSavePath()
      const result: DesktopSaved = { name, state }
      if (state === 'completed' && path) {
        saved.add(path)
        result.name = basename(path)
        result.savePath = path
        writePrefs({ saveDir: dirname(path) })
      }
      const win = window()
      if (win && !win.isDestroyed()) win.webContents.send('plein:saved', result)
    })
  })
}

export function showSavedFile(path: unknown) {
  if (typeof path === 'string' && saved.has(path)) shell.showItemInFolder(path)
}
