import { lookup as dnsLookup } from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
import { Readable } from 'node:stream'
import { isBlockedAddress } from './address'

export class RemoteFetchError extends Error {}

export interface RemoteFile {
  body: Readable
  /** 响应声明的类型（去掉参数）；没有时为空 */
  mime?: string
  /** 响应声明的长度；没有时为空 */
  length?: number
  /** 最终地址（重定向之后） */
  url: URL
}

export interface RemoteOptions {
  maxBytes: number
  timeoutMs?: number
  maxRedirects?: number
  /** 测试用：覆盖地址放行判断。默认拒绝回环、私网、链路本地等地址 */
  allowAddress?: (ip: string) => boolean
  /** 测试用：覆盖域名解析 */
  lookup?: (host: string) => Promise<Array<{ address: string; family: number }>>
}

const defaultLookup = (host: string) =>
  new Promise<Array<{ address: string; family: number }>>((resolve, reject) =>
    dnsLookup(host, { all: true, verbatim: true }, (err, list) =>
      err ? reject(err) : resolve(list),
    ),
  )

/**
 * 下载外部 AI 给的 URL。只允许 http/https；每一跳（含重定向）都检查目标地址：
 * 连接用的就是检查过的那个 IP（在 lookup 回调里校验），所以域名换解析（DNS rebinding）也绕不过去。
 * 超过大小上限或超时都会中止。
 */
export async function fetchRemote(input: string, opts: RemoteOptions): Promise<RemoteFile> {
  const deadline = AbortSignal.timeout(opts.timeoutMs ?? 30_000)
  const allow = opts.allowAddress ?? ((ip: string) => !isBlockedAddress(ip))
  const resolve = opts.lookup ?? defaultLookup
  let url = parse(input)
  for (let hop = 0; hop <= (opts.maxRedirects ?? 5); hop++) {
    const res = await once(url, deadline, allow, resolve)
    const status = res.statusCode ?? 0
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume()
      try {
        url = parse(new URL(res.headers.location, url).toString())
      } catch (err) {
        if (err instanceof RemoteFetchError) throw err
        throw new RemoteFetchError('重定向地址不合法')
      }
      continue
    }
    if (status < 200 || status >= 300) {
      res.resume()
      throw new RemoteFetchError(`下载失败：对方返回 ${status}`)
    }
    const declared = Number(res.headers['content-length'])
    if (Number.isFinite(declared) && declared > opts.maxBytes) {
      res.destroy()
      throw new RemoteFetchError(`文件超过上限 ${Math.round(opts.maxBytes / 1048576)} MB`)
    }
    const mime = String(res.headers['content-type'] ?? '')
      .split(';')[0]!
      .trim()
      .toLowerCase()
    return {
      body: limit(res, opts.maxBytes),
      mime: mime || undefined,
      length: Number.isFinite(declared) ? declared : undefined,
      url,
    }
  }
  throw new RemoteFetchError('重定向次数过多')
}

function parse(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new RemoteFetchError('URL 不合法')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new RemoteFetchError('只支持 http / https 地址')
  if (url.username || url.password) throw new RemoteFetchError('地址里不能带账号密码')
  return url
}

function once(
  url: URL,
  signal: AbortSignal,
  allow: (ip: string) => boolean,
  resolve: NonNullable<RemoteOptions['lookup']>,
) {
  const host = url.hostname.replace(/^\[|\]$/g, '')
  // 直接写 IP 的地址不经过 lookup，这里先查
  if (isIP(host) && !allow(host)) throw new RemoteFetchError('不允许访问内网或本机地址')
  return new Promise<http.IncomingMessage>((ok, fail) => {
    const lib = url.protocol === 'https:' ? https : http
    const req = lib.request(
      url,
      {
        method: 'GET',
        signal,
        headers: { 'user-agent': 'plein-import/1', accept: '*/*' },
        // 连接前才解析并校验：只会连到通过检查的地址
        lookup: (name, options, cb) => {
          void (async () => {
            try {
              const list = (await resolve(name)).filter((a) => a.family === 4 || a.family === 6)
              if (!list.length) throw new RemoteFetchError('域名无法解析')
              if (list.some((a) => !allow(a.address)))
                throw new RemoteFetchError('不允许访问内网或本机地址')
              if ((options as { all?: boolean }).all) {
                ;(cb as unknown as (e: null, a: unknown) => void)(null, list)
              } else cb(null, list[0]!.address, list[0]!.family)
            } catch (err) {
              cb(err as NodeJS.ErrnoException, '', 4)
            }
          })()
        },
      },
      ok,
    )
    req.on('error', (err) =>
      fail(
        err instanceof RemoteFetchError
          ? err
          : new RemoteFetchError(
              signal.aborted ? '下载超时' : `下载失败：${(err as Error).message}`,
            ),
      ),
    )
    req.end()
  })
}

/** 超过上限就中止，防止服务端被无限流灌满 */
function limit(source: Readable, max: number): Readable {
  let size = 0
  const out = new Readable({
    read() {
      source.resume()
    },
    destroy(err, cb) {
      source.destroy()
      cb(err)
    },
  })
  source.on('data', (chunk: Buffer) => {
    size += chunk.length
    if (size > max) {
      out.destroy(new RemoteFetchError(`文件超过上限 ${Math.round(max / 1048576)} MB`))
      return
    }
    if (!out.push(chunk)) source.pause()
  })
  source.on('end', () => out.push(null))
  source.on('error', (e) => out.destroy(new RemoteFetchError(`下载中断：${(e as Error).message}`)))
  return out
}
