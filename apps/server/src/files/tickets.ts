import { createHash, randomBytes } from 'node:crypto'

/**
 * 文件票据：外部 AI 不带桌面 Cookie，也不能把长期令牌塞进下载链接，
 * 所以文件进出都走短期票据。票据是一段随机串，只存哈希；绑定签发它的用户。
 *
 * - 上传票据：一次性。第一次使用（不管成败）就作废，过期也作废。
 * - 下载票据：只读，过期前可重复使用（Range、重试、HEAD 都要多次请求）。绑定资产或一条登记在册的内部路径。
 */

export type DownloadTarget =
  | { kind: 'asset'; assetId: string; name?: string }
  /** 经进程内接口取一条内部路径（例如剪辑工程导出）；路径必须匹配 PROXY_PATHS */
  | { kind: 'proxy'; path: string; name?: string }

/** proxy 目标允许的内部路径。只放行登记在册的只读下载路由 */
export const PROXY_PATHS: readonly RegExp[] = [
  /^\/api\/media\/sequence-export\/[A-Za-z0-9-]+$/,
  /^\/api\/projects\/[^/?]+\/package(\?history=1)?$/,
]

export interface UploadGrant {
  ownerId: string
  name: string
  mime: string
  /** 允许上传的最大字节数 */
  maxBytes: number
}

export interface DownloadGrant {
  ownerId: string
  target: DownloadTarget
}

interface Entry<T> {
  grant: T
  expires: number
}

export interface TicketOptions {
  /** 当前时间（毫秒）；测试里换成假时钟 */
  now?: () => number
  uploadTtlMs?: number
  downloadTtlMs?: number
  /** 每个用户同时有效的上传票据上限 */
  maxOutstanding?: number
}

const digest = (ticket: string) => createHash('sha256').update(ticket).digest('hex')

export class FileTickets {
  private uploads = new Map<string, Entry<UploadGrant>>()
  private downloads = new Map<string, Entry<DownloadGrant>>()
  private seenOrigin: string | undefined
  private now: () => number
  private uploadTtl: number
  private downloadTtl: number
  private maxOutstanding: number

  constructor(
    private opts: TicketOptions & {
      /** 对外访问地址；不填时用最近一次 MCP 请求的来源 */
      publicUrl?: string
      /** 没有任何请求来源时的兜底 */
      fallbackOrigin?: () => string
    } = {},
  ) {
    this.now = opts.now ?? Date.now
    this.uploadTtl = opts.uploadTtlMs ?? 15 * 60_000
    this.downloadTtl = opts.downloadTtlMs ?? 10 * 60_000
    this.maxOutstanding = opts.maxOutstanding ?? 32
  }

  /** 记下 MCP 请求的来源（协议 + 主机 + 端口），用来拼出外部 AI 能直接访问的绝对地址 */
  noteOrigin(origin: string) {
    this.seenOrigin = origin
  }

  baseUrl() {
    return (
      this.opts.publicUrl?.replace(/\/+$/, '') ??
      this.seenOrigin ??
      this.opts.fallbackOrigin?.() ??
      'http://127.0.0.1:8787'
    )
  }

  uploadUrl(ticket: string) {
    return `${this.baseUrl()}/mcp/upload/${ticket}`
  }

  downloadUrl(ticket: string) {
    return `${this.baseUrl()}/mcp/files/${ticket}`
  }

  private sweep() {
    const t = this.now()
    for (const m of [this.uploads, this.downloads])
      for (const [k, v] of m) if (v.expires <= t) m.delete(k)
  }

  /** 签发上传票据。返回明文票据（只此一次）和过期时间（毫秒时间戳） */
  issueUpload(grant: UploadGrant): { ticket: string; url: string; expires: number } {
    this.sweep()
    let n = 0
    for (const v of this.uploads.values()) if (v.grant.ownerId === grant.ownerId) n++
    if (n >= this.maxOutstanding) throw new TicketError('未使用的上传票据太多，先用掉或等它们过期')
    const ticket = randomBytes(32).toString('base64url')
    const expires = this.now() + this.uploadTtl
    this.uploads.set(digest(ticket), { grant, expires })
    return { ticket, url: this.uploadUrl(ticket), expires }
  }

  /** 取走上传票据：一次性，取走即作废；不存在、过期或已用过返回 null */
  takeUpload(ticket: string): UploadGrant | null {
    const key = digest(ticket)
    const entry = this.uploads.get(key)
    if (!entry) return null
    this.uploads.delete(key)
    return entry.expires > this.now() ? entry.grant : null
  }

  issueDownload(
    ownerId: string,
    target: DownloadTarget,
  ): { ticket: string; url: string; expires: number } {
    this.sweep()
    if (target.kind === 'proxy' && !PROXY_PATHS.some((p) => p.test(target.path)))
      throw new TicketError('这条内部路径不允许签发下载票据')
    let n = 0
    for (const v of this.downloads.values()) if (v.grant.ownerId === ownerId) n++
    if (n >= this.maxOutstanding * 8) throw new TicketError('有效的下载票据太多，稍后再试')
    const ticket = randomBytes(32).toString('base64url')
    const expires = this.now() + this.downloadTtl
    this.downloads.set(digest(ticket), { grant: { ownerId, target }, expires })
    return { ticket, url: this.downloadUrl(ticket), expires }
  }

  /** 读取下载票据：过期前可重复读取；不存在或过期返回 null */
  getDownload(ticket: string): DownloadGrant | null {
    const key = digest(ticket)
    const entry = this.downloads.get(key)
    if (!entry) return null
    if (entry.expires <= this.now()) {
      this.downloads.delete(key)
      return null
    }
    return entry.grant
  }
}

export class TicketError extends Error {}
