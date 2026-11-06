import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import {
  EXTERNAL_MCP_SCOPES,
  type ExternalMcpScope,
  type ExternalMcpTokenInfo,
} from '@plein/protocol'

/** 持久化的一枚令牌；令牌本身只在生成时给用户看一次，这里只存 SHA-256 */
export interface SavedToken {
  id: string
  name: string
  hash: string
  ownerId: string
  scopes: ExternalMcpScope[]
  createdAt: number
  dailyRunLimit?: number
}

interface FileV2 {
  version: 2
  tokens: SavedToken[]
}

/** 旧版文件：单枚全权限令牌 */
interface FileV1 {
  hash: string
  ownerId: string
  createdAt: number
}

const hash = (token: string) => createHash('sha256').update(token).digest()

/** 旧的单令牌迁移成一枚全权限令牌，原配置继续可用 */
function load(file: string): SavedToken[] {
  if (!existsSync(file)) return []
  const raw = JSON.parse(readFileSync(file, 'utf8')) as FileV2 | FileV1
  if ('version' in raw && raw.version === 2) return raw.tokens
  const old = raw as FileV1
  return [
    {
      id: 'mcp_default',
      name: '默认令牌',
      hash: old.hash,
      ownerId: old.ownerId,
      scopes: [...EXTERNAL_MCP_SCOPES],
      createdAt: old.createdAt,
    },
  ]
}

/** 多枚外部令牌：各自带名称与权限范围，可以单独撤销 */
export class TokenStore {
  private tokens: SavedToken[]
  private lastUsed = new Map<string, number>()

  constructor(private file: string) {
    this.tokens = load(file)
  }

  /** 写盘成功后才替换内存状态：写盘失败时旧状态和旧文件都不变 */
  private persist(next: SavedToken[]) {
    if (!next.length) {
      rmSync(this.file, { force: true })
    } else {
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify({ version: 2, tokens: next } satisfies FileV2), {
        mode: 0o600,
      })
      renameSync(tmp, this.file)
    }
    this.tokens = next
  }

  /** 令牌所属用户（本机模式下所有令牌属于同一个用户） */
  owner(): string | undefined {
    return this.tokens[0]?.ownerId
  }

  get enabled() {
    return this.tokens.length > 0
  }

  list(): ExternalMcpTokenInfo[] {
    return this.tokens.map((t) => this.info(t))
  }

  private info(t: SavedToken): ExternalMcpTokenInfo {
    const used = this.lastUsed.get(t.id)
    return {
      id: t.id,
      name: t.name,
      scopes: t.scopes,
      createdAt: t.createdAt,
      ...(used ? { lastUsedAt: used } : {}),
      ...(t.dailyRunLimit ? { dailyRunLimit: t.dailyRunLimit } : {}),
    }
  }

  issue(
    ownerId: string,
    opts: { name: string; scopes: ExternalMcpScope[]; dailyRunLimit?: number },
  ) {
    const token = `plein_${randomBytes(32).toString('base64url')}`
    const saved: SavedToken = {
      id: `mcp_${randomUUID().slice(0, 8)}`,
      name: opts.name,
      hash: hash(token).toString('hex'),
      ownerId,
      scopes: [...new Set(opts.scopes)],
      createdAt: Date.now(),
      ...(opts.dailyRunLimit ? { dailyRunLimit: opts.dailyRunLimit } : {}),
    }
    this.persist([...this.tokens, saved])
    return { token, ...this.info(saved) }
  }

  /** 撤销一枚；没有这枚返回 false */
  revokeOne(id: string) {
    if (!this.tokens.some((t) => t.id === id)) return false
    this.persist(this.tokens.filter((t) => t.id !== id))
    return true
  }

  revokeAll() {
    this.persist([])
  }

  /** 令牌明文 → 令牌记录（认证通过时记录最近使用） */
  authenticate(token: string): SavedToken | null {
    const got = hash(token)
    for (const t of this.tokens) {
      const want = Buffer.from(t.hash, 'hex')
      if (want.length === got.length && timingSafeEqual(want, got)) {
        this.lastUsed.set(t.id, Date.now())
        return t
      }
    }
    return null
  }

  /** 令牌还有效（调用途中被撤销时用来中止后续动作） */
  alive(id: string) {
    return this.tokens.some((t) => t.id === id)
  }
}
