import WebSocket from 'ws'
import { domainAllowed, type PluginManifest, ProviderError } from '@plein/plugin-sdk'
import { PermissionError } from './sandbox'

/** 不跟随重定向；和 fetch 一样按插件声明裁剪目标主机。 */
export async function scopedSocket(
  manifest: PluginManifest,
  address: string,
  headers: Record<string, string>,
  signal: AbortSignal,
) {
  const url = new URL(address)
  if (
    url.protocol !== 'wss:' ||
    url.username ||
    url.password ||
    !domainAllowed(manifest.permissions.network, url.hostname)
  )
    throw new PermissionError(`插件 ${manifest.id} 没有声明访问此 WebSocket 的权限`)
  signal.throwIfAborted()
  const ws = new WebSocket(url, {
    headers,
    followRedirects: false,
    maxPayload: 8 * 1024 * 1024,
    handshakeTimeout: 15000,
  })
  let logId: string | undefined
  ws.on('upgrade', (response) => {
    const value = response.headers['x-tt-logid']
    if (typeof value === 'string') logId = value.replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 160)
  })
  const queue: Uint8Array[] = []
  let queuedBytes = 0
  let pending: { resolve(value: Uint8Array): void; reject(error: Error): void } | undefined
  let failure: Error | undefined
  const fail = (error: Error) => {
    failure ??= error
    pending?.reject(failure)
    pending = undefined
  }
  const abort = () => {
    fail(new ProviderError('cancelled', '语音识别已取消', { outcome: 'unknown', retryable: false }))
    ws.terminate()
  }
  signal.addEventListener('abort', abort, { once: true })
  ws.on('error', () =>
    fail(
      new ProviderError('unavailable', '语音识别连接失败，结果未知', {
        outcome: 'unknown',
        retryable: false,
      }),
    ),
  )
  ws.on('close', () => {
    signal.removeEventListener('abort', abort)
    fail(
      new ProviderError('unavailable', '语音识别连接已关闭，未收到完整结果', {
        outcome: 'unknown',
        retryable: false,
      }),
    )
  })
  ws.on('message', (data, binary) => {
    if (!binary) {
      fail(new ProviderError('unknown', '语音识别返回了非二进制消息'))
      ws.close()
      return
    }
    const bytes = new Uint8Array(Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[]))
    if (pending) {
      pending.resolve(bytes)
      pending = undefined
    } else if (queue.length < 128 && queuedBytes + bytes.length <= 16 * 1024 * 1024) {
      queue.push(bytes)
      queuedBytes += bytes.length
    } else {
      fail(new ProviderError('unknown', '语音识别响应队列超限'))
      ws.close()
    }
  })
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', () => reject(failure ?? new Error('WebSocket 连接失败')))
    ws.once('close', () => reject(failure ?? new Error('WebSocket 连接已关闭')))
  })
  return {
    ...(logId ? { logId } : {}),
    send(data: Uint8Array) {
      if (failure) throw failure
      ws.send(data)
    },
    receive(): Promise<Uint8Array> {
      const data = queue.shift()
      if (data) {
        queuedBytes -= data.length
        return Promise.resolve(data)
      }
      if (failure) return Promise.reject(failure)
      return new Promise((resolve, reject) => {
        pending = { resolve, reject }
      })
    },
    close() {
      ws.close()
      signal.removeEventListener('abort', abort)
    },
  }
}
