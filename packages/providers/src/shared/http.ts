/**
 * 各平台适配器共用的请求底座：只管传输、重试规则、脱敏和素材编码；
 * 端点、参数映射和各家错误码的归类留在适配器里。
 */
import {
  type AssetRef,
  type ChatMessage,
  type ProviderContext,
  ProviderError,
  type ProviderErrorCode,
} from '@plein/plugin-sdk'

export type Json = Record<string, unknown>
export type Method = 'GET' | 'POST' | 'DELETE'

export function isJson(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 不是普通对象时当空对象处理 */
export function asJson(value: unknown): Json {
  return isJson(value) ? value : {}
}

/** 把错误信息里出现的密钥换成占位符；长的先换，避免短密钥是长密钥的一部分时漏掉 */
export function redact(
  text: string,
  secrets: Array<string | undefined>,
  opts: { mask?: string; tokens?: boolean } = {},
): string {
  const mask = opts.mask ?? '[redacted]'
  const list = secrets.filter((s): s is string => Boolean(s)).sort((a, b) => b.length - a.length)
  for (const secret of list) text = text.split(secret).join(mask)
  if (opts.tokens)
    text = text.replace(/Bearer\s+\S+/gi, `Bearer ${mask}`).replace(/sk-[a-zA-Z0-9_-]+/g, mask)
  return text
}

/**
 * 重试规则：提交生成的 POST 一律不可重试（远端可能已受理并计费）；
 * 查询类 GET 遇到限流、不可用和超时可以重试，宿主据此续轮询
 */
export function retryableFor(method: Method, code: ProviderErrorCode): boolean {
  return method === 'GET' && (code === 'rate_limit' || code === 'unavailable' || code === 'timeout')
}

/** 按请求方法重新判定一个平台错误能否重试 */
export function withRetry(error: ProviderError, method: Method): ProviderError {
  return new ProviderError(error.code, error.message, {
    retryable: retryableFor(method, error.code),
    cause: error.cause,
    ...(error.outcome ? { outcome: error.outcome } : {}),
  })
}

export interface TransportMessages {
  cancelled: string
  /** 网络失败；POST 时应说明提交结果未知 */
  network: string
  /** 不填时超时按网络失败处理 */
  timeout?: string
}

function isTimeout(value: unknown) {
  return value instanceof Error && value.name === 'TimeoutError'
}

/**
 * fetch 或读响应体抛错时的归类：中止为 cancelled，其余按方法决定能否重试。
 * POST 断在半路时请求可能已到平台，标为结果未知（outcome），宿主不会当作没提交
 */
export function transportError(
  ctx: Pick<ProviderContext, 'signal'>,
  method: Method,
  cause: unknown,
  messages: TransportMessages,
): ProviderError {
  if (messages.timeout && (isTimeout(cause) || isTimeout(ctx.signal.reason)))
    return new ProviderError('timeout', messages.timeout, {
      retryable: !ctx.signal.aborted && method === 'GET',
      cause,
      ...(method === 'POST' ? { outcome: 'unknown' as const } : {}),
    })
  if (ctx.signal.aborted)
    return new ProviderError('cancelled', messages.cancelled, {
      cause,
      ...(method === 'POST' ? { outcome: 'unknown' as const } : {}),
    })
  return new ProviderError('unavailable', messages.network, {
    retryable: method === 'GET',
    cause,
    ...(method === 'POST' ? { outcome: 'unknown' as const } : {}),
  })
}

/** 发请求；只处理传输层失败，HTTP 状态交给调用方按平台规则解析 */
export async function send(
  ctx: Pick<ProviderContext, 'fetch' | 'signal'>,
  url: string,
  init: { method: Method; headers?: Record<string, string>; body?: string },
  messages: TransportMessages,
): Promise<Response> {
  // 尚未发出请求时可以确定没有提交；发出后再取消则无法判断平台是否已受理。
  if (ctx.signal.aborted)
    throw new ProviderError(
      isTimeout(ctx.signal.reason) ? 'timeout' : 'cancelled',
      messages.cancelled,
      {
        retryable: false,
      },
    )
  try {
    return await ctx.fetch(url, {
      method: init.method,
      headers: init.headers,
      ...(init.body === undefined ? {} : { body: init.body }),
      signal: ctx.signal,
    })
  } catch (cause) {
    throw transportError(ctx, init.method, cause, messages)
  }
}

/** 响应头已收到不代表请求完成：读取响应体中断仍须保留方法、取消与提交未知信息。 */
export async function readText(
  ctx: Pick<ProviderContext, 'signal'>,
  response: Response,
  method: Method,
  messages: TransportMessages,
): Promise<string> {
  try {
    return await response.text()
  } catch (cause) {
    throw transportError(ctx, method, cause, messages)
  }
}

/** 仅把完整读到的非 JSON 当作空值；HTTP / 业务错误仍由平台适配器按官方规则解析。 */
export async function readJson(
  ctx: Pick<ProviderContext, 'signal'>,
  response: Response,
  method: Method,
  messages: TransportMessages,
): Promise<unknown> {
  const text = await readText(ctx, response, method, messages)
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export interface ImageRule {
  /** 资产不是图片时的报错；不填则只看 MIME */
  notImage?: string
  /** 小写后的 MIME 是否接受 */
  accept: (mime: string) => boolean
  badMime: string
  /** 允许的最大字节数（含） */
  maxBytes: number
  /** 超过大小时的报错；不允许空文件时空文件也报它 */
  tooLarge: string
  allowEmpty?: boolean
}

/** 读参考图并编码成 base64 data URL */
export async function imageDataUrl(
  ctx: Pick<ProviderContext, 'files'>,
  ref: AssetRef,
  rule: ImageRule,
): Promise<string> {
  if (rule.notImage && ref.kind !== 'image') throw new ProviderError('invalid_input', rule.notImage)
  const file = await ctx.files.read(ref)
  const mime = file.mime.toLowerCase()
  if (!rule.accept(mime)) throw new ProviderError('invalid_input', rule.badMime)
  if ((!rule.allowEmpty && !file.data.length) || file.data.length > rule.maxBytes)
    throw new ProviderError('invalid_input', rule.tooLarge)
  return `data:${mime};base64,${Buffer.from(file.data).toString('base64')}`
}

export type ChatPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

/** OpenAI 兼容的对话消息：图片换成平台给的 URL（通常是 data URL） */
export function chatMessages(
  messages: ChatMessage[],
  image: (ref: AssetRef) => Promise<string>,
): Promise<Array<{ role: ChatMessage['role']; content: string | ChatPart[] }>> {
  return Promise.all(
    messages.map(async (message) => ({
      role: message.role,
      content:
        typeof message.content === 'string'
          ? message.content
          : await Promise.all(
              message.content.map(async (part): Promise<ChatPart> =>
                part.type === 'text'
                  ? part
                  : { type: 'image_url', image_url: { url: await image(part.image) } },
              ),
            ),
    })),
  )
}
