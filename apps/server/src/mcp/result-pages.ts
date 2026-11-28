import { randomUUID } from 'node:crypto'
import { RpcError } from '../agent/mcp'

/** 已执行的调用无法安全重放；仅在回复超限时保留原文供同一令牌续读。 */
const TTL = 30 * 60_000
const MAX_RESULT = 4 * 1024 * 1024
const CAPACITY = 16 * 1024 * 1024
const PAGE = 4096
const PREFIX = 'plein://results/'

interface SavedResult {
  tokenId: string
  bytes: Buffer
  expires: number
  timer: NodeJS.Timeout
}

export class ResultPages {
  private entries = new Map<string, SavedResult>()
  private size = 0

  save(tokenId: string, text: string) {
    if (Buffer.byteLength(text) > MAX_RESULT)
      return { reason: 'result_exceeds_retention_limit', max_bytes: MAX_RESULT } as const
    const bytes = Buffer.from(text)
    for (const key of this.entries.keys()) {
      if (this.size + bytes.length <= CAPACITY) break
      this.remove(key)
    }
    const key = randomUUID()
    const expires = Date.now() + TTL
    this.entries.set(key, {
      bytes,
      tokenId,
      expires,
      timer: setTimeout(() => this.remove(key), TTL).unref(),
    })
    this.size += bytes.length
    return { uri: PREFIX + key, expires_at: expires } as const
  }

  read(tokenId: string, uri: string) {
    const match = /^plein:\/\/results\/([a-f0-9-]+)(?:\?offset=(\d+))?$/.exec(uri)
    if (!match) throw new RpcError(-32602, '无效的结果分页地址', { uri })
    const key = match[1]!
    const entry = this.entries.get(key)
    if (!entry || entry.tokenId !== tokenId || entry.expires <= Date.now())
      throw new RpcError(
        -32002,
        '结果已到期、已从短期缓存释放，或不属于当前令牌。请查看原操作的状态。',
        {
          code: 'not_found',
          uri,
        },
      )
    const offset = Number(match[2] ?? 0)
    const bytes = entry.bytes
    if (!Number.isSafeInteger(offset) || offset >= bytes.length || (bytes[offset]! & 0xc0) === 0x80)
      throw new RpcError(-32602, '分页位置无效，请使用上一页的 next_uri', { uri })
    let end = Math.min(bytes.length, offset + PAGE)
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--
    return {
      text: bytes.toString('utf8', offset, end),
      offset,
      total_bytes: bytes.length,
      complete: end === bytes.length,
      ...(end < bytes.length && { next_uri: PREFIX + key + '?offset=' + end }),
    }
  }

  revoke(tokenId?: string) {
    for (const [key, entry] of this.entries)
      if (!tokenId || entry.tokenId === tokenId) this.remove(key)
  }

  private remove(key: string) {
    const entry = this.entries.get(key)
    if (!entry) return
    clearTimeout(entry.timer)
    this.size -= entry.bytes.length
    this.entries.delete(key)
  }
}
