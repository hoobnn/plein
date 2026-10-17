import { EventEmitter } from 'node:events'
import type { BrowserWindow, Session } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { handleDownloads, showSavedFile } from './downloads'

const desktop = vi.hoisted(() => ({
  showItemInFolder: vi.fn(),
  readPrefs: vi.fn(() => ({ saveDir: '/tmp/作品' })),
  writePrefs: vi.fn(),
}))
vi.mock('electron', () => ({ shell: { showItemInFolder: desktop.showItemInFolder } }))
vi.mock('./prefs', () => ({ readPrefs: desktop.readPrefs, writePrefs: desktop.writePrefs }))

beforeEach(() => vi.clearAllMocks())

function download(path: string, destroyed = false) {
  const session = new EventEmitter()
  const send = vi.fn()
  const win = { isDestroyed: () => destroyed, webContents: { send } }
  handleDownloads(session as unknown as Session, () => win as unknown as BrowserWindow)
  const item = Object.assign(new EventEmitter(), {
    getFilename: () => '原名.mp4',
    getSavePath: () => path,
    setSaveDialogOptions: vi.fn(),
  })
  session.emit('will-download', {}, item)
  return { item, send }
}

describe('原生下载', () => {
  it('使用上次目录，成功后保存实际文件名并允许定位该文件', () => {
    const { item, send } = download('/tmp/新目录/改名.mp4')
    expect(item.setSaveDialogOptions).toHaveBeenCalledExactlyOnceWith({
      title: '另存为',
      defaultPath: '/tmp/作品/原名.mp4',
    })
    item.emit('done', {}, 'completed')
    expect(send).toHaveBeenCalledExactlyOnceWith('plein:saved', {
      name: '改名.mp4',
      state: 'completed',
      savePath: '/tmp/新目录/改名.mp4',
    })
    expect(desktop.writePrefs).toHaveBeenCalledExactlyOnceWith({ saveDir: '/tmp/新目录' })
    showSavedFile('/tmp/新目录/改名.mp4')
    expect(desktop.showItemInFolder).toHaveBeenCalledExactlyOnceWith('/tmp/新目录/改名.mp4')
  })

  it.each(['cancelled', 'interrupted'])('下载 %s 不记录文件或改写目录', (state) => {
    const path = `/tmp/${state}.mp4`
    const { item, send } = download(path)
    item.emit('done', {}, state)
    expect(send).toHaveBeenCalledWith('plein:saved', { name: '原名.mp4', state })
    expect(desktop.writePrefs).not.toHaveBeenCalled()
    showSavedFile(path)
    expect(desktop.showItemInFolder).not.toHaveBeenCalled()
  })

  it('窗口关闭后不发送结果，任意未保存路径和非字符串均不允许定位', () => {
    const { item, send } = download('/tmp/closed.mp4', true)
    item.emit('done', {}, 'completed')
    expect(send).not.toHaveBeenCalled()
    showSavedFile('/tmp/arbitrary-file')
    showSavedFile(null)
    expect(desktop.showItemInFolder).not.toHaveBeenCalled()
  })
})
