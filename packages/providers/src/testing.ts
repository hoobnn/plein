/**
 * 适配器测试共用的假宿主上下文（不从包入口导出，只给 *.test.ts 用）。
 */
import type { ProviderContext } from '@plein/plugin-sdk'
import { vi } from 'vite-plus/test'

/**
 * fetch 依次返回的应答：Response 原样返回，Error 直接抛出，其余当 JSON 响应体；
 * 队列用完再请求就报错，避免测试意外多发请求
 */
// oxlint-disable-next-line typescript/no-redundant-type-constituents -- 列出常见的几种，便于阅读
export type Reply = Response | Error | unknown

export interface FakeOptions {
  /** 单个密钥（任何名字都返回它）或按名字查的密钥表；默认 test-secret */
  secret?: string | Record<string, string | undefined>
  /** files.read 返回的 MIME；内容固定为 [1, 2, 3] */
  mime?: string
  width?: number
  height?: number
  duration?: number
}

export function fakeContext<T>(
  provider: { settings: { parse(value: unknown): T } },
  replies: Reply[] = [],
  opts: FakeOptions = {},
) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    if (!replies.length) throw new Error('Unexpected fetch')
    const next = replies.shift()
    if (next instanceof Error) throw next
    return next instanceof Response ? next : Response.json(next)
  })
  const secret = opts.secret ?? 'test-secret'
  const ctx: ProviderContext<T> = {
    settings: provider.settings.parse({}),
    secret: (name) => (typeof secret === 'string' ? secret : secret[name]),
    fetch,
    signal: new AbortController().signal,
    log: vi.fn(),
    files: {
      read: vi.fn(async () => ({
        data: new Uint8Array([1, 2, 3]),
        mime: opts.mime ?? 'image/png',
        width: opts.width ?? 1024,
        height: opts.height ?? 1024,
        duration: opts.duration,
      })),
    },
  }
  return { ctx, fetch, body: (index = 0) => requestBody(fetch, index) }
}

/** 第 index 次请求的 JSON 请求体 */
export function requestBody(fetch: { mock: { calls: unknown[][] } }, index = 0) {
  const init = fetch.mock.calls[index]?.[1] as RequestInit | undefined
  return JSON.parse(String(init?.body))
}

/** text/event-stream 响应 */
export function sse(text: string) {
  return new Response(text, { headers: { 'Content-Type': 'text/event-stream' } })
}

/** 已中止的 signal */
export function aborted(reason?: unknown) {
  const controller = new AbortController()
  controller.abort(reason)
  return controller.signal
}
