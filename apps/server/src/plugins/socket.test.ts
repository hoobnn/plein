import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import type { PluginManifest } from '@plein/plugin-sdk'

const fake = vi.hoisted(() => ({ last: undefined as unknown }))
vi.mock('ws', () => ({
  default: class extends EventEmitter {
    send = vi.fn()
    close = vi.fn(() => this.emit('close'))
    terminate = vi.fn(() => this.emit('close'))
    constructor(...args: unknown[]) {
      super()
      fake.last = this
      void args
      queueMicrotask(() => this.emit('open'))
    }
  },
}))
import { scopedSocket } from './socket'
const manifest = {
  id: 'test/socket',
  permissions: { network: ['openspeech.bytedance.com'] },
} as PluginManifest
const current = () =>
  fake.last as EventEmitter & {
    terminate: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
  }
afterEach(() => {
  fake.last = undefined
})
it('WebSocket 域名和 WSS 权限先于连接检查', async () => {
  for (const url of [
    'ws://openspeech.bytedance.com/a',
    'wss://evil.test/a',
    'wss://user:pass@openspeech.bytedance.com/a',
  ])
    await expect(scopedSocket(manifest, url, {}, new AbortController().signal)).rejects.toThrow(
      '没有声明',
    )
  expect(fake.last).toBeUndefined()
})
it('接收二进制，取消时拒绝等待并终止连接', async () => {
  const controller = new AbortController()
  const socket = await scopedSocket(
    manifest,
    'wss://openspeech.bytedance.com/a',
    {},
    controller.signal,
  )
  current().emit('message', Buffer.from([1, 2, 3]), true)
  expect(await socket.receive()).toEqual(new Uint8Array([1, 2, 3]))
  const waiting = socket.receive()
  controller.abort()
  await expect(waiting).rejects.toMatchObject({ code: 'cancelled', outcome: 'unknown' })
  expect(current().terminate).toHaveBeenCalledOnce()
})
it('未收到终包的关闭不能伪装成空结果', async () => {
  const socket = await scopedSocket(
    manifest,
    'wss://openspeech.bytedance.com/a',
    {},
    new AbortController().signal,
  )
  const waiting = socket.receive()
  current().emit('close')
  await expect(waiting).rejects.toMatchObject({ code: 'unavailable', outcome: 'unknown' })
})
