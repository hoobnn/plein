import { CapabilityError } from '@plein/capabilities'
import type { ServerContext } from './tools'

/** 对进程内服务端路由发一次请求。能力只能经已登记的 method + 路径形状访问，不开放任意 HTTP。 */
export interface InternalCall {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  /** 解析后的 pathname 必须匹配：参数里的 ../ 或 ? 会被 URL 折成别的路由，这里复核 */
  pathname: RegExp
  body?: unknown
}

export async function callInternal<T = unknown>(
  ctx: ServerContext,
  call: InternalCall,
  notFoundHint?: string,
): Promise<T> {
  if (!ctx.env.canvasApi) throw new CapabilityError('服务端路由不可用')
  const url = new URL(`http://plein.internal${call.path}`)
  if (!call.pathname.test(url.pathname)) throw new CapabilityError('操作路径不合法')
  const response = await ctx.env.canvasApi(
    ctx.env.ownerId,
    new Request(url, {
      method: call.method,
      ...(call.body === undefined
        ? {}
        : { body: JSON.stringify(call.body), headers: { 'content-type': 'application/json' } }),
      signal: ctx.env.execution?.abort.signal,
    }),
  )
  if (response.status === 204) return { success: true } as T
  const result = (await response.json().catch(() => ({}))) as Record<string, unknown>
  if (!response.ok) {
    const message = String(result.message ?? result.error ?? `操作失败 ${response.status}`)
    throw new CapabilityError(
      response.status === 404 && notFoundHint ? `${message}。${notFoundHint}` : message,
    )
  }
  return result as T
}

/** 内部路径参数一律编码，避免 id 里的 / ? # 改变路由 */
export const seg = (value: string) => encodeURIComponent(value)
