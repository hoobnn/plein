import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CapabilityError } from '@plein/capabilities'
import type { ExternalMcpStatus } from '@plein/protocol'
import { z } from 'zod'
import { toToolResult, McpServer, type McpTool } from '../agent/mcp'
import { capabilitiesOf, serverContext, type ToolEnv, viewOf } from '../agent/tools'
import { listCanvases, ownsCanvas } from '../storage/canvases'
import type { DB } from '../storage/db'

/** 外部应用写文档时的事务 origin：不进任何会话的撤销栈 */
export const EXTERNAL_ORIGIN = { external: true }

interface Saved {
  /** 令牌的 SHA-256；令牌本身只在生成时给用户看一次 */
  hash: string
  ownerId: string
  createdAt: number
}

type Deps = Omit<ToolEnv, 'canvasId' | 'ownerId'> & { db: DB }

const INSTRUCTIONS = `操作用户本机 Plein（AI 无限画布）里的画布。不传 canvas_id 时操作用户正在看的那块画布（没有打开的就用最近改过的），可以先调用 list_canvases 看有哪些画布。先用 get_canvas 看清画布再动手；运行节点会产生费用，视频尤其贵。修改已有镜头或节点时先用 propose_edit 出修改方案，给用户看过、问清批准范围（只改文字 / 只出候选图 / 完整方案）后再用 apply_edit_plan 执行。`

const hash = (token: string) => createHash('sha256').update(token).digest()

/**
 * 对外开放的 MCP：给 Claude Desktop、Claude Code、Cursor 等本机 AI 应用一个长期令牌，
 * 让它们用 plein 的全部能力操作画布。和内置智能体同一套能力，确认交给外部应用自己的界面。
 * 只在本机免登录模式开放。
 */
export class ExternalMcp {
  private file: string
  private saved: Saved | null
  private server: McpServer | null = null

  constructor(
    dataDir: string,
    private deps: Deps,
  ) {
    this.file = join(dataDir, 'external-mcp.json')
    this.saved = existsSync(this.file)
      ? (JSON.parse(readFileSync(this.file, 'utf8')) as Saved)
      : null
  }

  status(): ExternalMcpStatus {
    return this.saved ? { enabled: true, createdAt: this.saved.createdAt } : { enabled: false }
  }

  /** 生成新令牌（旧的作废），返回明文令牌 */
  issue(ownerId: string) {
    const token = `plein_${randomBytes(32).toString('base64url')}`
    this.saved = { hash: hash(token).toString('hex'), ownerId, createdAt: Date.now() }
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.saved), { mode: 0o600 })
    renameSync(tmp, this.file)
    return { token, createdAt: this.saved.createdAt }
  }

  revoke() {
    this.saved = null
    rmSync(this.file, { force: true })
  }

  matches(token: string) {
    if (!this.saved) return false
    const want = Buffer.from(this.saved.hash, 'hex')
    const got = hash(token)
    return want.length === got.length && timingSafeEqual(want, got)
  }

  handle(body: unknown) {
    this.server ??= new McpServer(
      { name: 'plein', version: '0.1.0', instructions: INSTRUCTIONS },
      this.tools(),
    )
    return this.server.handle(body)
  }

  /** 全部能力，每个都多一个可选的 canvas_id；外加 list_canvases */
  private tools(): McpTool[] {
    const registry = capabilitiesOf(this.deps.host)
    const caps = registry.list().map((cap): McpTool => ({
      name: cap.name,
      description: cap.description,
      input: cap.input.extend({
        canvas_id: z.string().max(100).optional().describe('画布 id；不填用用户正在看的画布'),
      }),
      run: async (raw) => {
        const { canvas_id, ...args } = raw as { canvas_id?: string }
        const ctx = serverContext(this.env(this.canvas(canvas_id)))
        return toToolResult(await registry.invoke(cap.name, ctx, args))
      },
    }))
    return [
      {
        name: 'list_canvases',
        description: '列出用户的画布（最近改过的在前），标出用户现在正在看的那块。',
        input: z.object({}),
        run: () => {
          const watching = this.watching()
          return JSON.stringify(
            listCanvases(this.deps.db, this.owner())
              .slice(0, 50)
              .map((c) => ({
                id: c.id,
                title: c.title,
                updated_at: new Date(c.updatedAt).toISOString(),
                ...(c.id === watching ? { viewing: true } : {}),
              })),
            null,
            1,
          )
        },
      },
      ...caps,
    ]
  }

  private owner() {
    if (!this.saved) throw new CapabilityError('外部访问已关闭')
    return this.saved.ownerId
  }

  private env(canvasId: string): ToolEnv {
    const { db: _, ...rest } = this.deps
    return { ...rest, canvasId, ownerId: this.owner(), origin: EXTERNAL_ORIGIN }
  }

  /** 用户最近在看的画布：浏览器里打开的画布会经 awareness 发布视口 */
  private watching(): string | undefined {
    let best: { id: string; at: number } | undefined
    for (const id of this.deps.rooms.loaded()) {
      const v = viewOf(this.deps.rooms, id)
      if (v && (!best || v.at > best.at)) best = { id, at: v.at }
    }
    return best && ownsCanvas(this.deps.db, this.owner(), best.id) ? best.id : undefined
  }

  private canvas(id?: string): string {
    const owner = this.owner()
    if (id) {
      if (!ownsCanvas(this.deps.db, owner, id)) throw new CapabilityError(`没有画布 ${id}`)
      return id
    }
    const current = this.watching() ?? listCanvases(this.deps.db, owner)[0]?.id
    if (!current) throw new CapabilityError('还没有画布：先在 Plein 里新建一块')
    return current
  }
}
