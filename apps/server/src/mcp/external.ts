import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { stableStringify } from '@plein/canonical'
import { CapabilityError } from '@plein/capabilities'
import type { ExternalMcpScope, ExternalMcpStatus } from '@plein/protocol'
import { z } from 'zod'
import { approvalFor } from '../agent/approvals'
import { describeCanvasActions, externalActionInput } from '../agent/action-caps'
import { AgentChanges } from '../agent/changes'
import { classifyError } from '../agent/error-codes'
import {
  type CallContext,
  annotationsOf,
  CodedToolError,
  inputSchema,
  McpServer,
  type McpTool,
  type RequestContext,
  type ToolResult,
  toToolResult,
} from '../agent/mcp'
import { RESULT_BYTES } from '../agent/context-budget'
import { sendViewAction } from '../agent/ui-bridge'
import { workspaceToolNames } from '../agent/project-caps'
import {
  capabilitiesOf,
  MAX_WAIT_S,
  serverContext,
  type ServerContext,
  type ToolEnv,
  viewOf,
} from '../agent/tools'
import { newId } from '../ids'
import { listCanvases, ownsCanvas } from '../storage/canvases'
import type { DB } from '../storage/db'
import { McpAudit } from './audit'
import { resourceProvider } from './resources'
import { ResultPages } from './result-pages'
import { type SavedToken, TokenStore } from './tokens'

/** 外部应用写文档时的事务 origin：只读调用用它，不进任何撤销栈 */
export const EXTERNAL_ORIGIN = { external: true }

type Deps = Omit<ToolEnv, 'canvasId' | 'ownerId'> & { db: DB }

const INSTRUCTIONS = `操作用户本机 Plein（AI 无限画布）里的画布。需画布的工具可传 canvas_id 固定目标。省略时优先使用正在看的画布，其次使用最近改过的画布。tools/list 列出本令牌可以使用的工具和实际参数。有 read 权限时，可从 list_canvas_capabilities 查工具契约，list_canvas_actions 查扩展操作，list_node_types 查节点参数与端口，list_models 查模型约束。读取较大画布用 get_canvas_page。运行模型可能产生费用。修改已有镜头或节点时先用 propose_edit 出修改方案，给用户看过、问清批准范围（只改文字 / 只出候选图 / 完整方案）后再用 apply_edit_plan 执行。`

/** 外部调用默认最多等多久：比常见客户端的 60 秒工具超时短得多 */
export const EXTERNAL_WAIT_S = 20

// ── 协议块：外部入口的补充说明（和上面的 INSTRUCTIONS 分开，方便各自修改）─────────

const PROTOCOL_NOTES = `
外部调用的约定：
- 工具按令牌的 read / edit / run / destructive 范围展示。动态工具有任一可用分支即可发现，调用时按具体参数检查所有需要的权限。比如 rewrite_prompt 的预览需要 run，写回还需要 edit。
- 删除、视频生成、付费改写、需要确认的远程编辑等会返回 status=needs_approval 和 reason。用户同意后才用相同参数及 confirm: true 重试。普通单节点图片、文本、配音生成可能直接运行，按用户明确授权的范围操作。
- 变更或运行可带唯一 client_request_id。用同一枚令牌、同一目标和参数重试会复用在途或已保存的结果。已提交或接收情况未知的失败回执保留 execution_outcome 和本次运行额度，请按返回的恢复信息核对原任务。回执在本进程最多保留 30 分钟，缓存满时会提前释放，失效后先核对任务或文档。
- 带 undo_token 的画布变更，可用有 edit 权限的原令牌在 10 分钟内调用 undo_call。项目、工作区、外部平台及其他独立保存的更改不提供画布撤销。
- 错误结果带 structuredContent.error.code：not_found / stale / needs_user / input_changed / forbidden_scope / blocked / invalid_params / too_large / rate_limited / internal / failed。
- wait_for_* 和 run_node 默认最多等 ${EXTERNAL_WAIT_S} 秒，仍在运行时返回 running 和续等提示，再调 wait_for_run / wait_for_group 即可。
- resources 可读画布和工具契约。超长画布内容按 too_large 提示分页。具名节点、模型、工具和扩展操作的完整契约或操作回执超过上限时，结果带 result_omitted。用原令牌沿 recovery.uri 和 next_uri 续读。prompts 提供创作技能指引。`

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
  canvasId: string
  timer: NodeJS.Timeout
}

interface Replay {
  fingerprint: string
  settledAt?: number
  result: Promise<ToolResult>
}

const textBlock = (text: string) => ({ type: 'text' as const, text })

function asResult(out: ToolResult | string): ToolResult {
  return typeof out === 'string' ? { content: [textBlock(out)] } : out
}

/** MCP 客户端会解析 JSON；超过预算时交付可读回执，避免把半段 JSON 当成成功数据。 */
function externalResult(
  out: unknown,
  retain?: (text: string) => ReturnType<ResultPages['save']>,
): ToolResult | string {
  const result = toToolResult(out, Infinity)
  const text =
    typeof result === 'string'
      ? result
      : result.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
  const bytes = Buffer.byteLength(text)
  if (bytes <= RESULT_BYTES) return result
  if (retain) {
    const recovery = retain(text)
    const message = recovery.uri
      ? '回执已分页。用同一令牌通过 resources/read 读取 recovery.uri，沿 next_uri 拼接各页 text。结果最长保留 30 分钟，缓存满时会提前释放。'
      : '结果超过单次 4 MiB 的短期恢复上限，完整回执未保留。请查看原操作的状态，不要重复提交。'
    const receipt = {
      result_omitted: true,
      code: 'too_large',
      bytes,
      limit: RESULT_BYTES,
      recovery,
      message,
    }
    return {
      content: [
        textBlock(JSON.stringify(receipt)),
        ...(recovery.uri
          ? [
              {
                type: 'resource_link' as const,
                name: '完整操作回执',
                uri: recovery.uri,
                mimeType: 'application/json',
              },
            ]
          : []),
        ...(typeof result === 'string'
          ? []
          : result.content.filter((block) => block.type !== 'text')),
      ],
      structuredContent: receipt,
    }
  }
  const message =
    '结果超过 32 KiB。请缩小查询范围，或用 get_canvas_page / get_element_field 分页读取。'
  const error = { code: 'too_large', message, bytes, limit: RESULT_BYTES }
  return {
    isError: true,
    content: [textBlock(message + '\n（错误码：too_large）')],
    structuredContent: { error },
  }
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
  private catalog = new Map<string, McpTool>()
  private resultPages = new ResultPages()

  constructor(
    dataDir: string,
    private deps: Deps,
  ) {
    this.tokens = new TokenStore(join(dataDir, 'external-mcp.json'))
    this.audit = new McpAudit(dataDir)
  }

  adoptLocalOwner(ownerId: string) {
    this.tokens.adoptLocalOwner(ownerId)
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
    if (ok) this.resultPages.revoke(id)
    if (ok) for (const [key, u] of this.undoable) if (u.tokenId === id) this.forget(key)
    return ok
  }

  /** 撤销全部令牌，关闭外部访问 */
  revoke() {
    this.tokens.revokeAll()
    this.resultPages.revoke()
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
    if (!this.server) {
      const tools = this.tools()
      this.catalog = new Map(tools.map((tool) => [tool.name, tool]))
      this.server = new McpServer(
        { name: 'plein', version: '0.2.0', instructions: INSTRUCTIONS + PROTOCOL_NOTES },
        tools,
        {
          visible: (tool, a) => this.visible(tool, a as SavedToken),
          ...resourceProvider({
            capability: (name, a) => this.describe(name, a as SavedToken),
            resultPage: (uri, a) => this.resultPages.read((a as SavedToken).id, uri),
            recentCanvases: (a) => listCanvases(this.deps.db, (a as SavedToken).ownerId),
            owns: (id, a) => ownsCanvas(this.deps.db, (a as SavedToken).ownerId, id),
            read: (canvasId, name, args, a) =>
              capabilitiesOf(this.deps.host).invoke(
                name,
                serverContext(this.env(canvasId, (a as SavedToken).ownerId)),
                args,
              ),
            canRead: (a) => (a as SavedToken | undefined)?.scopes.includes('read') === true,
          }),
        },
        true,
      )
    }
    return this.server.handle(body, { ...rc, auth })
  }

  // ── 工具清单 ──────────────────────────────────────────────

  /** tools/list 按令牌权限过滤：只列出令牌能调用的工具（等级随参数变化的能力，有任一权限就列出） */
  private visible(tool: McpTool, token: SavedToken | undefined): boolean {
    if (!token) return false
    if (tool.name === 'undo_call') return token.scopes.includes('edit')
    const cap = capabilitiesOf(this.deps.host).get(tool.name)
    if (!cap) return false
    return (cap.effects ?? [cap.effect]).some((effect) => token.scopes.includes(effect))
  }

  private describe(name: string, token: SavedToken) {
    const tool = this.catalog.get(name)
    if (!tool || !this.visible(tool, token)) return
    const cap = capabilitiesOf(this.deps.host).get(name)
    return {
      name,
      title: tool.title,
      description: tool.description,
      where: cap?.where ?? 'server',
      group: cap?.group ?? 'edit',
      effect: cap?.effects ? 'dynamic' : (cap?.effect ?? 'edit'),
      ...(cap?.effects ? { effects: cap.effects } : {}),
      input_schema: inputSchema(tool.input, tool.rejectUnknownFields),
    }
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
        input: cap.input.def.catchall
          ? cap.input.safeExtend(extra)
          : cap.input.safeExtend(extra).strict(),
        rejectUnknownFields: true,
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
        input: z.strictObject({
          token: z.string().min(1).max(100),
          canvas_id: z.string().min(1).max(100).optional().describe('可选；核对原操作所在的画布'),
        }),
        run: (raw, call) =>
          this.audited('undo_call', call, raw, () => {
            const token = this.requireScope(call, 'edit', 'undo_call')
            const { token: key, canvas_id } = raw as { token: string; canvas_id?: string }
            const u = this.undoable.get(key)
            if (!u || u.tokenId !== token.id || (canvas_id && canvas_id !== u.canvasId))
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

  private authenticated(call: CallContext | undefined) {
    const token = call?.auth as SavedToken | undefined
    if (!token || !this.tokens.alive(token.id))
      throw new CodedToolError('forbidden_scope', '令牌已被撤销，请在 Plein 设置里重新生成')
    return token
  }

  private requireScope(call: CallContext | undefined, scope: ExternalMcpScope, what: string) {
    const token = this.authenticated(call)
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
    const parsed = cap.input.safeParse(args)
    if (!parsed.success) throw new CapabilityError(`参数不对：${z.prettifyError(parsed.error)}`)
    args = parsed.data
    if (name === 'perform_canvas_action' && typeof args.action === 'string')
      args = { ...args, input: externalActionInput(args.action, args.input) }
    const { ownerId } = this.authenticated(call)
    const needsCanvas =
      !workspace &&
      (typeof cap.requiresCanvas === 'function'
        ? cap.requiresCanvas(parsed.data)
        : cap.requiresCanvas !== false)
    const canvasId =
      needsCanvas || (!workspace && canvas_id !== undefined)
        ? this.canvas(ownerId, canvas_id)
        : workspace
          ? (this.watching(ownerId) ?? '')
          : ''
    const ctxProbe = serverContext(this.env(canvasId, ownerId))
    const effect = registry.effectOf(cap, parsed.data, ctxProbe)
    const scoped = this.requireScope(call, effect, name)
    for (const required of cap.additionalScopes?.(parsed.data) ?? [])
      this.requireScope(call, required, name)
    const retain = (text: string) => this.resultPages.save(scoped.id, text)
    if (name === 'list_canvas_actions')
      return externalResult(
        describeCanvasActions(args.action as string | undefined, scoped.scopes),
        args.action ? retain : undefined,
      )
    if (name === 'list_canvas_capabilities') {
      if (typeof args.name === 'string') {
        const detail = this.describe(args.name, scoped)
        if (!detail) throw new CodedToolError('not_found', `当前工具目录中没有 ${args.name}`)
        return externalResult(detail, retain)
      }
      const items = [...this.catalog.values()]
        .filter((tool) => this.visible(tool, scoped))
        .map((tool) => {
          const def = registry.get(tool.name)
          return {
            name: tool.name,
            title: tool.title,
            group: def?.group ?? 'edit',
            where: def?.where ?? 'server',
          }
        })
      return externalResult(items)
    }

    const execute = () =>
      this.execute({
        name,
        args,
        canvasId,
        needsCanvas,
        effect,
        confirm: confirm === true,
        token: scoped,
        call,
      })

    if (!client_request_id || effect === 'read') return execute()
    const key = `${scoped.id}:${client_request_id}`
    const fingerprint = createHash('sha256')
      .update(stableStringify([name, needsCanvas ? canvasId : null, args]))
      .digest('hex')
    const hit = this.replays.get(key)
    if (hit && (hit.settledAt === undefined || Date.now() - hit.settledAt < IDEMPOTENCY_TTL_MS)) {
      if (hit.fingerprint !== fingerprint)
        throw new CodedToolError(
          'invalid_params',
          'client_request_id 已用于另一次不同的调用。重试请沿用原目标和参数，仅在明确要执行新操作时换用新的 id。',
        )
      return decorate(await hit.result, { replayed: true })
    }
    for (const [k, v] of this.replays) {
      if (
        v.settledAt !== undefined &&
        (Date.now() - v.settledAt >= IDEMPOTENCY_TTL_MS || this.replays.size >= IDEMPOTENCY_MAX)
      )
        this.replays.delete(k)
    }
    const result = (async () => asResult(await execute()))()
    const record: Replay = { fingerprint, result }
    this.replays.set(key, record)
    try {
      const r = await result
      record.settledAt = Date.now()
      // 未执行可以修正后重试；已提交或平台接收情况未知时保留首回执。
      if (
        (r.isError && !r.structuredContent?.execution_outcome) ||
        r.structuredContent?.code === 'needs_user'
      )
        this.replays.delete(key)
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
    needsCanvas: boolean
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
    const mutating = effect !== 'read' && p.needsCanvas
    const changes = mutating
      ? new AgentChanges(callId, canvasId, token.ownerId, this.deps.rooms, this.deps.runs)
      : null
    const ctx = serverContext({
      ...this.env(canvasId, token.ownerId),
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
    if (
      (effect === 'run' || effect === 'destructive' || (effect === 'edit' && cap.confirmEdits)) &&
      !p.confirm
    ) {
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

    this.authenticated(call)
    const chargedDay =
      effect === 'run' && token.dailyRunLimit ? new Date().toDateString() : undefined
    if (chargedDay && !this.tokens.chargeRun(token.id, chargedDay))
      throw new CodedToolError(
        'rate_limited',
        `令牌「${token.name}」今天的运行次数已用完（${token.dailyRunLimit} 次）。明天再试，或在 Plein 设置里换一枚上限更高的令牌。`,
      )

    let out: ToolResult | string
    try {
      changes?.begin(callId)
      const namedContract =
        (name === 'list_node_types' && args.type) || (name === 'list_models' && args.ref)
      out = await this.runCap(
        name,
        args,
        ctx,
        call,
        effect !== 'read' || namedContract ? token.id : undefined,
      )
    } catch (err) {
      const outcome = err instanceof CodedToolError ? err.details?.execution_outcome : undefined
      if (err instanceof CodedToolError && (outcome === 'submitted' || outcome === 'unknown')) {
        const error = { code: err.code, message: err.message, ...err.details }
        const receipt = externalResult(error, (text) => this.resultPages.save(token.id, text))
        if (typeof receipt === 'string') {
          out = {
            isError: true,
            content: [textBlock(receipt)],
            structuredContent: { error, execution_outcome: outcome },
          }
        } else {
          out = {
            ...receipt,
            isError: true,
            structuredContent: {
              ...receipt.structuredContent,
              error: { code: err.code, message: '请用回执的恢复信息核对原操作' },
              execution_outcome: outcome,
            },
          }
        }
      } else {
        if (changes) {
          changes.end()
          changes.undoTurn(callId)
          changes.release()
        }
        if (chargedDay) this.tokens.refundRun(token.id, chargedDay)
        throw err
      }
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
      canvasId,
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
    retainForToken: string | undefined,
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
        waitArgs = { id: args.id, run_id: last.run_id }
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
        if (waitName === 'wait_for_run' && last.run_id)
          waitArgs = { ...waitArgs, run_id: last.run_id }
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
    return externalResult(
      withResumeHint(name, args, out),
      retainForToken ? (text) => this.resultPages.save(retainForToken, text) : undefined,
    )
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

  private forget(key: string) {
    const u = this.undoable.get(key)
    if (!u) return
    clearTimeout(u.timer)
    u.changes.release()
    this.undoable.delete(key)
  }

  // ── 画布与环境 ─────────────────────────────────────────────

  private env(canvasId: string, ownerId: string): ToolEnv {
    const { db: _, ...rest } = this.deps
    const view = canvasId ? viewOf(this.deps.rooms, canvasId) : undefined
    return {
      ...rest,
      canvasId,
      ownerId,
      origin: EXTERNAL_ORIGIN,
      // 外部应用没有会话发送入口：每次工具调用捕获一次，异步插件内的后续读取复用它。
      selection: view?.selection,
      selectionSource: view ? 'view' : 'unavailable',
      ui: (call) => sendViewAction(this.deps.rooms, canvasId, call),
    }
  }

  /** 用户最近在看的画布：浏览器里打开的画布会经 awareness 发布视口 */
  private watching(ownerId: string): string | undefined {
    let best: { id: string; at: number } | undefined
    for (const id of this.deps.rooms.loaded()) {
      const v = viewOf(this.deps.rooms, id)
      if (v && (!best || v.at > best.at) && ownsCanvas(this.deps.db, ownerId, id))
        best = { id, at: v.at }
    }
    return best?.id
  }

  private canvas(owner: string, id?: string): string {
    if (id) {
      if (!ownsCanvas(this.deps.db, owner, id)) throw new CapabilityError(`没有画布 ${id}`)
      return id
    }
    const current = this.watching(owner) ?? listCanvases(this.deps.db, owner)[0]?.id
    if (!current) throw new CapabilityError('还没有画布：先在 Plein 里新建一块')
    return current
  }
}

/** 仍在运行时补上续等提示 */
function withResumeHint(name: string, args: Record<string, unknown>, out: unknown): unknown {
  if (!WAITERS.has(name)) return out
  if (typeof out !== 'object' || out === null || (out as { status?: unknown }).status !== 'running')
    return out
  const o = out as Record<string, unknown>
  if (o.next) return out
  const next =
    name === 'wait_for_group'
      ? `还在运行。用 wait_for_group {"group_id":"${String(args.group_id)}"} 继续等待。`
      : `还在运行。用 wait_for_run ${JSON.stringify({ id: args.id, run_id: o.run_id ?? args.run_id })} 继续等待，不要重复调用 ${name}。`
  return { ...o, next }
}
