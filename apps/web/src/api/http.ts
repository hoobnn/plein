import { API } from '@plein/protocol'

/**
 * 前端统一的 HTTP 传输层：所有请求都从这里走，保证鉴权失效、网络中断、
 * 错误响应体的处理只有一份。`api/client.ts` 在此之上提供按领域组织的接口。
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** 错误响应的完整内容（如 input_changed 带回的新实际输入） */
    readonly body?: unknown,
  ) {
    super(message)
  }
}

/** 401 时通知外壳回到登录页 */
let onUnauthorized: (() => void) | null = null
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn
}
export function reportUnauthorized() {
  onUnauthorized?.()
}

/** 网络中断的提示：离线和连不上本地服务是两回事，分开说。 */
export function networkErrorMessage(): string {
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false
  return offline ? '当前离线，请恢复网络连接。' : '无法连接服务，请检查网络或本地服务状态。'
}

/**
 * 发请求并把非 2xx 统一转成 ApiError。
 * 网络中断（fetch 抛 TypeError）转成可读提示；主动取消原样抛出，让调用方能区分。
 */
export async function send(path: string, init: RequestInit = {}): Promise<Response> {
  let res: Response
  try {
    res = await fetch(path, { credentials: 'same-origin', ...init })
  } catch (reason) {
    if (reason instanceof TypeError && !init.signal?.aborted)
      throw new TypeError(networkErrorMessage(), { cause: reason })
    throw reason
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string
      message?: string
      code?: string
    } | null
    // 会话读取自身失败由调用方处理，否则会再次读取会话、形成递归刷新。
    if (res.status === 401 && path !== API.session && !path.startsWith(API.auth))
      reportUnauthorized()
    // 服务端没给可读文案时也要说清发生了什么，不能只留一个空提示。
    const message = body?.message?.trim() || res.statusText?.trim() || `请求失败（${res.status}）`
    throw new ApiError(
      res.status,
      body?.error ?? body?.code ?? 'http_error',
      message,
      body ?? undefined,
    )
  }
  return res
}

/** 发请求并解析 JSON；没有正文（204 / 202）时返回 undefined。 */
export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await send(path, init)
  const body = await res.text()
  return (body ? JSON.parse(body) : undefined) as T
}

/** 组一个 JSON 请求体。 */
export const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
})
