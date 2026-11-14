import * as Y from 'yjs'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { canvasSyncCredential, watchDocSync, type DocSync } from './syncBarrier'

const trackers: DocSync[] = []
afterEach(() => {
  for (const tracker of trackers.splice(0)) tracker.dispose()
  vi.useRealTimers()
})

const remote = { kind: 'remote' }

function setup(probe: (credential: string) => Promise<boolean>) {
  vi.useFakeTimers()
  const ydoc = new Y.Doc()
  const remoteDoc = new Y.Doc()
  const states: boolean[] = []
  const tracker = watchDocSync({
    canvasId: 'canvas',
    ydoc,
    remote,
    connected: () => true,
    probe,
    change: (dirty) => states.push(dirty),
  })
  trackers.push(tracker)
  const local = () => {
    ydoc.getMap('elements').set(`el-${ydoc.getMap('elements').size}`, 1)
  }
  const fromServer = () => {
    remoteDoc.getMap('elements').set(`remote-${remoteDoc.getMap('elements').size}`, 1)
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(remoteDoc), remote)
  }
  return { ydoc, tracker, states, local, fromServer }
}

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms)

it('只有本机改动才算未保存，服务端推来的更新不会打断确认', async () => {
  const probe = vi.fn(async () => true)
  const { tracker, states, local, fromServer } = setup(probe)
  expect(tracker.dirty()).toBe(false)

  fromServer()
  expect(tracker.dirty()).toBe(false)
  await advance(400)
  expect(probe).not.toHaveBeenCalled()

  local()
  expect(tracker.dirty()).toBe(true)
  // 确认前收到远端更新：本机这一版没变，仍然可以确认
  fromServer()
  await advance(300)
  expect(probe).toHaveBeenCalledTimes(1)
  expect(tracker.dirty()).toBe(false)
  expect(states).toEqual([true, false])
})

it('确认期间又改了本机内容，旧回执不能解除保护', async () => {
  let release!: (value: boolean) => void
  const probe = vi.fn(() => new Promise<boolean>((resolve) => (release = resolve)))
  const { tracker, local } = setup(probe)
  local()
  await advance(300)
  expect(probe).toHaveBeenCalledTimes(1)

  // 请求在途时又改了一处：这次回执只对应上一版
  local()
  release(true)
  await advance(0)
  expect(tracker.dirty()).toBe(true)

  await advance(300)
  expect(probe).toHaveBeenCalledTimes(2)
  release(true)
  await advance(0)
  expect(tracker.dirty()).toBe(false)
})

it('确认失败会在之后重试，同步恢复后自动解除未保存状态', async () => {
  let ok = false
  const probe = vi.fn(async () => ok)
  const { tracker, local } = setup(probe)
  local()
  await advance(300)
  expect(probe).toHaveBeenCalledTimes(1)
  expect(tracker.dirty()).toBe(true)

  await advance(1000)
  expect(probe).toHaveBeenCalledTimes(2)
  expect(tracker.dirty()).toBe(true)

  ok = true
  await advance(1000)
  expect(probe).toHaveBeenCalledTimes(3)
  expect(tracker.dirty()).toBe(false)
})

it('本机缓存落盘也算安全，凭据只给当前画布', async () => {
  const probe = vi.fn(async () => false)
  const { tracker, local } = setup(probe)
  local()
  expect(tracker.dirty()).toBe(true)
  tracker.cacheSaved()
  expect(tracker.dirty()).toBe(false)
  expect(canvasSyncCredential('canvas')).toEqual(expect.any(String))
  expect(canvasSyncCredential('other')).toBeUndefined()
})
