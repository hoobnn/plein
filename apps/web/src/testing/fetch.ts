import { vi } from 'vite-plus/test'

type FetchHandler = (request: Request) => Response | undefined | Promise<Response | undefined>
const unhandled: string[] = []
interface PendingRequest {
  description: string
  cancel(): void
  settled: Promise<void>
}
const pending = new Set<PendingRequest>()
const abortError = () => new DOMException('请求已取消', 'AbortError')

/** 保留真实 api client 的序列化与错误处理；未声明的请求在用例结束时也会报错。 */
export function mockFetch(handler: FetchHandler = () => undefined) {
  const mock = vi.fn<typeof fetch>((input, init) => {
    const request = new Request(
      typeof input === 'string' ? new URL(input, location.href) : input,
      init,
    )
    if (request.signal.aborted) return Promise.reject(abortError())

    let resolve!: (response: Response) => void
    let reject!: (error: unknown) => void
    let finished = false
    const result = new Promise<Response>((yes, no) => {
      resolve = yes
      reject = no
    })
    const finish = (action: () => void) => {
      if (finished) return
      finished = true
      request.signal.removeEventListener('abort', cancel)
      pending.delete(task)
      action()
    }
    const cancel = () => finish(() => reject(abortError()))
    const task: PendingRequest = {
      description: `${request.method} ${request.url}`,
      cancel,
      settled: result.then(
        () => {},
        () => {},
      ),
    }
    pending.add(task)
    request.signal.addEventListener('abort', cancel, { once: true })
    // handler 可能仍在等待 deferred；取消后只丢弃迟到应答，不让旧请求写回组件或缓存。
    void Promise.resolve()
      .then(() => {
        if (finished) return
        return handler(request)
      })
      .then(
        (response) =>
          finish(() => {
            if (response) return resolve(response)
            const message = `未模拟的请求：${task.description}`
            unhandled.push(message)
            reject(new Error(message))
          }),
        (error: unknown) => finish(() => reject(error)),
      )
    return result
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

export function takeUnhandledRequests() {
  return unhandled.splice(0)
}

/** teardown 中拒绝未结算请求，并报告遗漏；不等待无法终止的 handler 自身。 */
export async function finishPendingRequests(): Promise<string[]> {
  const requests = [...pending]
  for (const request of requests) request.cancel()
  await Promise.all(requests.map((request) => request.settled))
  return requests.map((request) => `未完成的请求：${request.description}`)
}
