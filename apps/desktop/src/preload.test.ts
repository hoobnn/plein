import { EventEmitter } from 'node:events'
import type { DesktopBridge } from '@plein/protocol'
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'

const electron = vi.hoisted(() => ({ expose: vi.fn(), invoke: vi.fn(), send: vi.fn() }))
const events = new EventEmitter()
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.expose },
  ipcRenderer: {
    invoke: electron.invoke,
    send: electron.send,
    on: (channel: string, fn: (...args: unknown[]) => void) => events.on(channel, fn),
    removeListener: (channel: string, fn: (...args: unknown[]) => void) => events.off(channel, fn),
  },
}))

let bridge: DesktopBridge
beforeEach(async () => {
  vi.resetModules()
  vi.resetAllMocks()
  events.removeAllListeners()
  await import('./preload')
  bridge = electron.expose.mock.calls[0]![1] as DesktopBridge
})

describe('桌面页面桥', () => {
  it('暴露限定桥接口，原生操作转发到对应通道', async () => {
    expect(electron.expose).toHaveBeenCalledWith('pleinDesktop', expect.any(Object))
    expect(bridge.platform).toBe(process.platform)
    await bridge.nativeEdit('undo')
    await bridge.openDataDir()
    await bridge.showSavedFile('/tmp/作品.mp4')
    expect(electron.invoke.mock.calls).toEqual([
      ['plein:native-edit', 'undo'],
      ['plein:open-data-dir'],
      ['plein:show-saved-file', '/tmp/作品.mp4'],
    ])
  })

  it('注册节点监听后才通知就绪，解绑后不再收到事件', () => {
    electron.send.mockImplementation(() => {
      events.emit('plein:open-node', { sender: 'private' }, { canvasId: 'c', nodeId: 'n' })
    })
    const listener = vi.fn()
    const off = bridge.onOpenNode(listener)
    expect(listener).toHaveBeenCalledExactlyOnceWith({ canvasId: 'c', nodeId: 'n' })
    off()
    events.emit('plein:open-node', {}, { canvasId: 'other', nodeId: 'other' })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('事件只交付数据；同一通道的多个订阅可独立解绑', () => {
    const menu = vi.fn()
    const saved = vi.fn()
    const progress = vi.fn()
    const second = vi.fn()
    const off = bridge.onMenuCommand(menu)
    bridge.onMenuCommand(second)
    const offSaved = bridge.onSaved(saved)
    const offProgress = bridge.onUpdateProgress(progress)
    events.emit('plein:menu-command', { sender: 'private' }, 'settings')
    events.emit('plein:saved', {}, { name: '作品', state: 'cancelled' })
    events.emit('plein:update-progress', {}, null)
    expect(menu).toHaveBeenCalledExactlyOnceWith('settings')
    expect(saved).toHaveBeenCalledExactlyOnceWith({ name: '作品', state: 'cancelled' })
    expect(progress).toHaveBeenCalledExactlyOnceWith(null)
    off()
    offSaved()
    offProgress()
    events.emit('plein:menu-command', {}, 'redo')
    events.emit('plein:saved', {}, {})
    events.emit('plein:update-progress', {}, {})
    expect(menu).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenLastCalledWith('redo')
    expect(saved).toHaveBeenCalledTimes(1)
    expect(progress).toHaveBeenCalledTimes(1)
  })
})
