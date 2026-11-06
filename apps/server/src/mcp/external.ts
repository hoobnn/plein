import { join } from 'node:path'
import { CapabilityError } from '@plein/capabilities'
import type { ExternalMcpScope, ExternalMcpStatus } from '@plein/protocol'
import { z } from 'zod'
import { approvalFor } from '../agent/approvals'
import { AgentChanges } from '../agent/changes'
import { classifyError } from '../agent/error-codes'
import {
  type CallContext,
  annotationsOf,
  CodedToolError,
  McpServer,
  type McpTool,
  type RequestContext,
  type ToolResult,
  toToolResult,
} from '../agent/mcp'
import { workspaceToolNames } from '../agent/project-caps'
import {
  capabilitiesOf,
  MAX_WAIT_S,
  serverContext,
  type ServerContext,
  type ToolEnv,
  type UiCall,
  viewOf,
} from '../agent/tools'
import { newId } from '../ids'
import { listCanvases, ownsCanvas } from '../storage/canvases'
import type { DB } from '../storage/db'
import { McpAudit } from './audit'
import { resourceProvider } from './resources'
import { type SavedToken, TokenStore } from './tokens'

/** 外部应用写文档时的事务 origin：只读调用用它，不进任何撤销栈 */
export const EXTERNAL_ORIGIN = { external: true }

type Deps = Omit<ToolEnv, 'canvasId' | 'ownerId'> & { db: DB }

const INSTRUCTIONS = `操作用户本机 Plein（AI 无限画布）里的画布。不传 canvas_id 时操作用户正在看的那块画布（没有打开的就用最近改过的），可以先调用 list_canvases 看有哪些画布。第一次使用先按顺序了解能力：list_canvas_capabilities（有哪些工具，指定 name 看完整参数）→ list_canvas_actions（perform_canvas_action 的扩展操作）→ list_node_types（节点类型、参数与端口）→ list_models（模型目录与约束；换模型用 set_node_model，改名用 rename_element）。先用 get_canvas 看清画布再动手；运行节点会产生费用，视频尤其贵。修改已有镜头或节点时先用 propose_edit 出修改方案，给用户看过、问清批准范围（只改文字 / 只出候选图 / 完整方案）后再用 apply_edit_plan 执行。`

/** 外部调用默认最多等多久：比常见客户端的 60 秒工具超时短得多 */
export const EXTERNAL_WAIT_S = 20

// ── 协议块：外部入口的补充说明（和上面的 INSTRUCTIONS 分开，方便各自修改）─────────

const PROTOCOL_NOTES = `
外部调用的约定：
- 每枚令牌有权限范围（read / edit / run / destructive），超出范围的工具不会出现在列表里，调用会返回 forbidden_scope。
- 会花钱或删东西的操作先返回 status=needs_approval（错误码 needs_user）：把 reason 讲给用户，用户同意后用相同参数加 confirm: true 重试。
- 修改类和运行类工具可带 client_request_id（自己生成的唯一串）：超时重试时同一个 id 返回第一次的结果，不会重复执行。
- 修改类调用的结果里有 undo_token，10 分钟内可用 undo_call 撤销这一次。
- 错误结果带 structuredContent.error.code：not_found / stale / needs_user / input_changed / forbidden_scope / blocked / invalid_params / too_large / rate_limited / internal / failed。
- wait_for_* 和 run_node 默认最多等 ${EXTERNAL_WAIT_S} 秒，仍在运行时返回 running 和续等提示，再调 wait_for_run / wait_for_group 即可。
- 可用 resources（plein://canvas/{id}、plein://capabilities/{name}）读画布和工具契约，prompts 是创作技能的指引。`

/** 带进度通知时每段等多久 */
const WAIT_CHUNK_S = 5
const UNDO_TTL_MS = 10 * 60_000
const IDEMPOTENCY_TTL_MS = 30 * 60_000
const IDEMPOTENCY_MAX = 500

const WAITERS = new Set(['run_node', 'wait_for_run', 'wait_for_group'])

/** 一次变更调用可撤销的记录 */
interface Undoable {
  changes: AgentChanges
  tokenId: string
  timer: NodeJS.Timeout
}

interface Replay {
  fingerprint: string
  at: number
  result: Promise<ToolResult>
}

const textBlock = (text: string) => ({ type: 'text' as const, text })

function asResult(out: ToolResult | string): ToolResult {
  return typeof out === 'string' ? { content: [textBlock(out)] } : out
}

/** 给结果补充结构化字段，并让只看文字的客户端也看得到 */
function decorate(
  out: ToolResult | string,
  extra: Record<string, unknown>,
  note?: string,
): ToolResult {
  const r = asResult(out)
  return {
    ...r,
    content: note ? [...r.content, textBlock(note)] : r.content,
    structuredContent: { ...r.structuredContent, ...extra },
  }
}

/**
 * 对外开放的 MCP：给 Claude Desktop、Claude Code、Cursor 等本机 AI 应用令牌，
 * 让它们用 plein 的能力操作画布。和内置智能体同一套能力注册表，但外部没有会话里的确认面板，
 * 所以这里补上：令牌权限范围、needs_approval + confirm 确认、client_request_id 幂等、
 * undo_token 撤销、审计日志。只在本机免登录模式开放。
 */
export class ExternalMcp {
  private tokens: TokenStore
  private audit: McpAudit
  private server: McpServer | null = null
  private undoable = new Map<string, Undoable>()
  private replays = new Map<string, Replay>()
  private runCounts = new Map<string, { day: string; n: number }>()

  constructor(
    dataDir: string,
    private deps: Deps,
  ) {
    this.tokens = new TokenStore(join(dataDir, 'external-mcp.json'))
    this.audit = new McpAudit(dataDir)
  }

  status(): ExternalMcpStatus {
    const tokens = this.tokens.list()
    return {
      enabled: tokens.length > 0,
      ...(tokens.length ? { createdAt: Math.min(...tokens.map((t) => t.createdAt)) } : {}),
      tokens,
    }
  }

  /** 新增一枚令牌（已有的不受影响），返回明文令牌 */
  issue(
    ownerId: string,
    opts: { name?: string; scopes?: ExternalMcpScope[]; dailyRunLimit?: number } = {},
  ) {
    return this.tokens.issue(ownerId, {
      name: opts.name ?? '默认令牌',
      scopes: opts.scopes ?? ['read', 'edit', 'run', 'destructive'],
      ...(opts.dailyRunLimit ? { dailyRunLimit: opts.dailyRunLimit } : {}),
    })
  }

  /** 撤销一枚令牌，同时让它名下还能撤销的变更失效 */
  revokeOne(id: string) {
    const ok = this.tokens.revokeOne(id)
    if (ok) for (const [key, u] of this.undoable) if (u.tokenId === id) this.forget(key)
    return ok
  }

  /** 撤销全部令牌，关闭外部访问 */
  revoke() {
    this.tokens.revokeAll()
    for (const key of [...this.undoable.keys()]) this.forget(key)
    this.server = null
  }

  recentAudit(limit?: number) {
    return this.audit.recent(limit)
  }

  matches(token: string) {
    return this.tokens.authenticate(token) !== null
  }

  /** 令牌明文 → 令牌记录；路由层认证后把它随请求传给 handle */
  authenticate(token: string): SavedToken | null {
    return this.tokens.authenticate(token)
  }

  handle(body: unknown, auth: SavedToken, rc: Omit<RequestContext, 'auth'> = {}) {
    this.server ??= new McpServer(
      { name: 'plein', version: '0.2.0', instructions: INSTRUCTIONS + PROTOCOL_NOTES },
      this.tools(),
      {
        visible: (tool, a) => this.visible(tool, a as SavedToken),
        ...resourceProvider({
          registry: capabilitiesOf(this.deps.host),
          recentCanvases: () => listCanvases(this.deps.db, this.owner()),
          owns: (id) => ownsCanvas(this.deps.db, this.owner(), id),
          read: (canvasId, name, args) =>
            capabilitiesOf(this.deps.host).invoke(name, serverContext(this.env(canvasId)), args),
          canRead: (a) => (a as SavedToken | undefined)?.scopes.includes('read') === true,
        }),
      },
      true,
    )
    return this.server.handle(body, { ...rc, auth })
  }

  // ── 工具清单 ──────────────────────────────────────────────

  /** tools/list 按令牌权限过滤：只列出令牌能调用的工具（等级随参数变化的能力，有任一权限就列出） */
  private visible(tool: McpTool, token: SavedToken | undefined): boolean {
    if (!token) return false
    if (tool.name === 'undo_call') return token.scopes.includes('edit')
    const cap = capabilitiesOf(this.deps.host).get(tool.name)
    if (!cap) return false
    if (typeof cap.effect === 'function') return token.scopes.length > 0
    return token.scopes.includes(cap.effect)
  }

  /** 全部能力；依赖画布的每个都多一个可选的 canvas_id；外加 undo_call */
  private tools(): McpTool[] {
    const registry = capabilitiesOf(this.deps.host)
    const caps = registry.list().map((cap): McpTool => {
      const mutates = cap.effect !== 'read'
      const extra: z.ZodRawShape = {
        // 不依赖画布的能力（项目、画布管理等）不追加 canvas_id，空工作区里也能用
        ...(workspaceToolNames.has(cap.name)
          ? {}
          : {
              canvas_id: z.string().max(100).optional().describe('画布 id；不填用用户正在看的画布'),
            }),
        ...(mutates
          ? {
              confirm: z
                .boolean()
                .optional()
                .describe('用户已同意 needs_approval 里的操作后，用相同参数加 confirm: true 重试'),
              client_request_id: z
                .string()
                .min(1)
                .max(100)
                .optional()
                .describe('自己生成的唯一串；超时重试时用同一个，返回第一次的结果，不重复执行'),
            }
          : {}),
        ...('wait_seconds' in cap.input.shape
          ? {
              wait_seconds: z
                .number()
                .min(0)
                .max(MAX_WAIT_S)
                .default(EXTERNAL_WAIT_S)
                .describe(
                  `最多等多少秒（默认 ${EXTERNAL_WAIT_S}）；仍在运行会返回 running 和续等提示`,
                ),
            }
          : {}),
      }
      return {
        name: cap.name,
        title: cap.title,
        description: cap.description,
        input: cap.input.extend(extra),
        annotations: annotationsOf(cap as never),
        run: (raw, call) =>
          this.audited(cap.name, call, raw, () => this.invoke(cap.name, raw, call)),
      }
    })
    return [
      {
        name: 'undo_call',
        title: '撤销一次调用',
        description: `撤销一次变更调用：传该调用结果里的 undo_token。只在 ${UNDO_TTL_MS / 60_000} 分钟内有效，只能撤销这枚令牌自己做的修改；之后又有别的改动夹在中间时不能单独撤销。`,
        annotations: {
          title: '撤销一次调用',
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
        input: z.object({ token: z.string().min(1).max(100) }),
        run: (raw, call) =>
          this.audited('undo_call', call, raw, () => {
            const token = this.requireScope(call, 'edit', 'undo_call')
            const { token: key } = raw as { token: string }
            const u = this.undoable.get(key)
            if (!u || u.tokenId !== token.id)
              throw new CodedToolError(
                'not_found',
                '这次操作已经不能撤销了（超过时限、已撤销，或不是这枚令牌做的）',
              )
            const ok = u.changes.undoTurn(key)
            this.forget(key)
            if (!ok) throw new CodedToolError('stale', '之后又有改动，不能单独撤销这一次')
            return '已撤销'
          }),
      },
      ...caps,
    ]
  }

  // ── 一次能力调用 ───────────────────────────────────────────

  private requireScope(call: CallContext | undefined, scope: ExternalMcpScope, what: string) {
    const token = call?.auth as SavedToken | undefined
    if (!token || !this.tokens.alive(token.id))
      throw new CodedToolError('forbidden_scope', '令牌已被撤销，请在 Plein 设置里重新生成')
    if (!token.scopes.includes(scope))
      throw new CodedToolError(
        'forbidden_scope',
        `令牌「${token.name}」没有 ${scope} 权限（现有：${token.scopes.join(' / ')}），不能调用 ${what}。在 Plein 设置 → 对外开放 MCP 里新建带 ${scope} 权限的令牌后换用。`,
      )
    return token
  }

  /** 审计：记录工具名、令牌名、结果，不记参数里的内容 */
  private async audited(
    tool: string,
    call: CallContext | undefined,
    raw: unknown,
    fn: () => ToolResult | string | Promise<ToolResult | string>,
  ): Promise<ToolResult | string> {
    const token = call?.auth as SavedToken | undefined
    const canvasId = (raw as { canvas_id?: string } | undefined)?.canvas_id
    const entry = (ok: boolean, code?: string) =>
      token &&
      this.audit.record({
        at: Date.now(),
        token: token.name,
        tool,
        ok,
        ...(code ? { code } : {}),
        ...(canvasId ? { canvasId } : {}),
      })
    try {
      const out = await fn()
      const r = typeof out === 'string' ? undefined : out
      const err = r?.isError
      const code =
        (r?.structuredContent?.code as string | undefined) ??
        (r?.structuredContent?.error as { code?: string } | undefined)?.code
      entry(!err, code)
      return out
    } catch (e) {
      entry(
        false,
        e instanceof CodedToolError
          ? e.code
          : e instanceof CapabilityError
            ? classifyError(e.message)
            : 'internal',
      )
      throw e
    }
  }

  private async invoke(
    name: string,
    raw: unknown,
    call: CallContext | undefined,
  ): Promise<ToolResult | string> {
    const registry = capabilitiesOf(this.deps.host)
    const cap = registry.get(name)!
    const { confirm, client_request_id, ...rest } = raw as {
      confirm?: boolean
      client_request_id?: string
    } & Record<string, unknown>
    // 工作区工具（rename_canvas、delete_canvas 等）的 canvas_id 是自己的参数，原样交给能力；
    // 其余工具的 canvas_id 是外部入口追加的「操作哪块画布」，从参数里取走
    const workspace = workspaceToolNames.has(name)
    const { canvas_id, ...own } = rest as { canvas_id?: string } & Record<string, unknown>
    let args: Record<string, unknown> = workspace ? rest : own
    // 批量分镜：不带 token 的第一次调用只出清单和费用，审阅后带 token 才提交
    if (name === 'run_storyboard' && !args.token && !args.preview_only)
      args = { ...args, preview_only: true }
    const canvasId = workspace ? (this.watching() ?? '') : this.canvas(canvas_id)
    const parsed = cap.input.safeParse(args)
    if (!parsed.success) throw new CapabilityError(`参数不对：${z.prettifyError(parsed.error)}`)
    const ctxProbe = serverContext(this.env(canvasId))
    const effect = registry.effectOf(cap, parsed.data, ctxProbe)
    const scoped = this.requireScope(call, effect, name)

    const execute = () =>
      this.execute({ name, args, canvasId, effect, confirm: confirm === true, token: scoped, call })

    if (!client_request_id || effect === 'read') return execute()
    const key = `${scoped.id}:${client_request_id}`
    const fingerprint = JSON.stringify([name, canvasId, args])
    const hit = this.replays.get(key)
    if (hit && Date.now() - hit.at < IDEMPOTENCY_TTL_MS) {
      if (hit.fingerprint !== fingerprint)
        throw new CodedToolError(
          'invalid_params',
          'client_request_id 已用于另一次不同的调用；换一个新的 id',
        )
      return decorate(await hit.result, { replayed: true })
    }
    for (const [k, v] of this.replays) {
      if (Date.now() - v.at >= IDEMPOTENCY_TTL_MS || this.replays.size > IDEMPOTENCY_MAX)
        this.replays.delete(k)
    }
    const result = (async () => asResult(await execute()))()
    this.replays.set(key, { fingerprint, at: Date.now(), result })
    try {
      const r = await result
      // 失败和等待确认的结果不记：同一个 id 可以在修正后重试
      if (r.isError || r.structuredContent?.code === 'needs_user') this.replays.delete(key)
      return r
    } catch (err) {
      this.replays.delete(key)
      throw err
    }
  }

  private async execute(p: {
    name: string
    args: Record<string, unknown>
    canvasId: string
    effect: 'read' | 'edit' | 'run' | 'destructive'
    confirm: boolean
    token: SavedToken
    call: CallContext | undefined
  }): Promise<ToolResult | string> {
    const { name, args, canvasId, effect, token, call } = p
    const registry = capabilitiesOf(this.deps.host)
    const cap = registry.get(name)!
    const callId = newId('ext')
    // 项目、画布管理这类工作区操作不落在某块画布上，没有撤销记录
    const mutating = effect !== 'read' && !workspaceToolNames.has(name)
    const changes = mutating
      ? new AgentChanges(callId, canvasId, this.owner(), this.deps.rooms, this.deps.runs)
      : null
    const ctx = serverContext({
      ...this.env(canvasId),
      ...(changes
        ? {
            origin: changes.origin,
            onRun: (n: string, r: string) => changes.recordRun(n, r),
            onGroup: (g: string) => changes.recordGroup(g),
          }
        : {}),
    })

    // 运行类先做预检：阻断项直接返回，不让调用方白白确认
    if (effect === 'run' && cap.prepare) {
      const prepared = await cap.prepare(args as never, ctx, {})
      if (prepared?.answer !== undefined) return prepared.answer as ToolResult | string
    }

    // 需要用户确认的操作：没带 confirm 就不执行（规则与内置智能体的「规则」模式一致）
    if ((effect === 'run' || effect === 'destructive') && !p.confirm) {
      const req = approvalFor('rules', cap, args, ctx, {
        runCount: 0,
        createdThisTurn: () => false,
      } as unknown as AgentChanges)
      if (req)
        return decorate(
          JSON.stringify(
            {
              status: 'needs_approval',
              reason: req.reason,
              ids: req.ids,
              ...(await this.priceOf(name, args, ctx)),
              next: '把 reason（和费用）讲给用户；用户同意后，用相同参数加 confirm: true 重新调用。用户不同意就换个做法。',
            },
            null,
            1,
          ),
          { code: 'needs_user' },
        )
    }

    if (effect === 'run') this.chargeRun(token)

    changes?.begin(callId)
    let out: ToolResult | string
    try {
      out = await this.runCap(name, args, ctx, call)
    } catch (err) {
      if (changes) {
        changes.end()
        changes.undoTurn(callId)
        changes.release()
      }
      if (effect === 'run') this.refundRun(token)
      throw err
    }
    const changed = changes?.end()
    if (!changes) return out
    if (!changed) {
      changes.release()
      return out
    }
    this.undoable.set(callId, {
      changes,
      tokenId: token.id,
      timer: setTimeout(() => this.forget(callId), UNDO_TTL_MS),
    })
    return decorate(
      out,
      { undo_token: callId },
      `undo_token: ${callId}（${UNDO_TTL_MS / 60_000} 分钟内可用 undo_call 撤销这一次）`,
    )
  }

  /** 调用能力；run_node / wait_for_* 在客户端要进度通知时分段等待并推送进度 */
  private async runCap(
    name: string,
    args: Record<string, unknown>,
    ctx: ServerContext,
    call: CallContext | undefined,
  ): Promise<ToolResult | string> {
    const registry = capabilitiesOf(this.deps.host)
    const total = Number(args.wait_seconds ?? EXTERNAL_WAIT_S)
    let out: unknown
    if (call?.progress && WAITERS.has(name) && total > 0) {
      const started = Date.now()
      const elapsed = () => Math.min(total, (Date.now() - started) / 1000)
      let waitName = name
      let waitArgs = args
      let last: Record<string, unknown> | undefined
      if (name === 'run_node') {
        last = (await registry.invoke(name, ctx, { ...args, wait_seconds: 0 })) as Record<
          string,
          unknown
        >
        waitName = 'wait_for_run'
        waitArgs = { id: args.id }
      } else {
        last = undefined
      }
      call.progress(0, total, '已开始，等待结果')
      while (last?.status === undefined || last.status === 'running') {
        const left = total - elapsed()
        if (left <= 0) break
        last = (await registry.invoke(waitName, ctx, {
          ...waitArgs,
          wait_seconds: Math.min(WAIT_CHUNK_S, Math.ceil(left)),
        })) as Record<string, unknown>
        const note =
          typeof last.message === 'string'
            ? last.message
            : typeof last.progress === 'number'
              ? `进度 ${Math.round(last.progress * 100)}%`
              : '仍在运行'
        if (last.status === 'running') call.progress(elapsed(), total, note)
      }
      out = last
    } else out = await registry.invoke(name, ctx, args)
    return toToolResult(withResumeHint(name, args, out))
  }

  private async priceOf(name: string, args: Record<string, unknown>, ctx: ServerContext) {
    if (name !== 'run_node' || typeof args.id !== 'string') return {}
    try {
      const input = await ctx.env.runs.preview(ctx.env.canvasId, args.id, ctx.env.ownerId)
      const price = ctx.env.runs.priceOf(input.model)
      return price ? { price, model: input.model } : { price: null, note: '这个模型没有登记价格' }
    } catch {
      return {}
    }
  }

  // ── 每日运行次数上限 ───────────────────────────────────────

  private chargeRun(token: SavedToken) {
    if (!token.dailyRunLimit) return
    const day = new Date().toDateString()
    const cur = this.runCounts.get(token.id)
    const n = cur?.day === day ? cur.n : 0
    if (n >= token.dailyRunLimit)
      throw new CodedToolError(
        'rate_limited',
        `令牌「${token.name}」今天的运行次数已用完（${token.dailyRunLimit} 次）。明天再试，或在 Plein 设置里换一枚上限更高的令牌。`,
      )
    this.runCounts.set(token.id, { day, n: n + 1 })
  }

  private refundRun(token: SavedToken) {
    const cur = this.runCounts.get(token.id)
    if (cur && cur.n > 0) cur.n--
  }

  private forget(key: string) {
    const u = this.undoable.get(key)
    if (!u) return
    clearTimeout(u.timer)
    u.changes.release()
    this.undoable.delete(key)
  }

  // ── 画布与环境 ─────────────────────────────────────────────

  private owner() {
    const owner = this.tokens.owner()
    if (!owner) throw new CapabilityError('外部访问已关闭')
    return owner
  }

  private env(canvasId: string): ToolEnv {
    const { db: _, ...rest } = this.deps
    return {
      ...rest,
      canvasId,
      ownerId: this.owner(),
      origin: EXTERNAL_ORIGIN,
      // 外部应用没有会话发送入口：每次工具调用捕获一次，异步插件内的后续读取复用它。
      selection: canvasId ? [...(viewOf(this.deps.rooms, canvasId)?.selection ?? [])] : [],
      ui: (call) => this.pushUi(canvasId, call),
    }
  }

  /**
   * 把界面动作推给浏览器：写进房间 awareness 的本地状态（agentUi.actions，带单调递增的 n），
   * 打开这块画布的标签页监听后执行（见 apps/web/src/canvas/agentUi.ts）。没有标签页打开时返回 false。
   */
  private pushUi(canvasId: string, call: UiCall): boolean {
    if (!viewOf(this.deps.rooms, canvasId)) return false
    const awareness = this.deps.rooms.get(canvasId).awareness
    const state = awareness.getLocalState() ?? {}
    const prev = ((state.agentUi as { actions?: Array<{ n: number }> } | undefined)?.actions ??
      []) as Array<{ n: number }>
    const n = (prev.at(-1)?.n ?? 0) + 1
    awareness.setLocalState({ ...state, agentUi: { actions: [...prev.slice(-7), { n, ...call }] } })
    return true
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

/** 仍在运行时补上续等提示 */
function withResumeHint(name: string, args: Record<string, unknown>, out: unknown): unknown {
  if (typeof out !== 'object' || out === null || (out as { status?: unknown }).status !== 'running')
    return out
  const o = out as Record<string, unknown>
  if (o.next) return out
  const next =
    name === 'wait_for_group'
      ? `还在运行。用 wait_for_group {"group_id":"${String(args.group_id)}"} 继续等待。`
      : `还在运行。用 wait_for_run {"id":"${String(args.id)}"} 继续等待，不要重复调用 ${name}。`
  return { ...o, next }
}
