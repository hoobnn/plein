import { and, desc, eq } from 'drizzle-orm'
import { newId } from '../ids'
import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AgentAccess,
  AgentApprovalMode,
  AgentEvent,
  AgentItem,
  AgentKind,
  AgentSession,
  AgentSessionSummary,
  AgentStatus,
  EditPlan,
  EditScope,
} from '@plein/protocol'
import { type ChatMessage, ProviderError } from '@plein/plugin-sdk'
import type { AssetStore } from '../assets/store'
import type { PluginHost } from '../plugins/host'
import type { EditPlans } from '../runs/edit-plan'
import type { NodeRuns } from '../runs/runs'
import type { LibraryStore } from '../library/store'
import type { DB } from '../storage/db'
import { agentSessions } from '../storage/schema'
import type { Rooms } from '../sync/rooms'
import { type Approval, Approvals } from './approvals'
import { PROPOSE_EDIT } from './edit-plan'
import { AgentPlan, PLAN_TOOL } from './plan'
import { AgentChanges } from './changes'
import { type CliEnvironment, detectClis, type ResolvedCli } from './cli'
import { startClaude } from './drivers/claude'
import { startCodex } from './drivers/codex'
import { type CliDriver, type PermissionAsk, TOKEN_ENV } from './drivers/types'
import { brief, childEnv, toolText } from './drivers/util'
import { builtinModel, runBuiltinTurn } from './builtin'
import { type McpTool, McpServer, type ToolResult } from './mcp'
import { agentTools } from './tools'

/** 每轮对话的上限，防止 CLI 卡住 */
const TURN_TIMEOUT_MS = 60 * 60 * 1000
/** 没人看着（无事件订阅）也没在跑时，多久后释放画布租约；之后这个会话的改动不能再撤销 */
const RELEASE_AFTER_MS = 10 * 60 * 1000

const INSTRUCTIONS = `你是 Plein 的创作助手。Plein 是一块 AI 无限画布：画布上有图片、视频、音频、Markdown 元素和工作流节点（文本、LLM、生成图片、生成视频、配音、配乐、角色、场景、分镜、序列等），节点之间用连线传递数据，运行节点会调用模型生成结果。

你通过 plein 工具操作用户当前打开的这块画布，所有改动会实时出现在用户屏幕上。

做事方式：
- 先用 get_canvas 看清画布（画布大时用 find_elements 找），用 list_node_types 了解可用节点、参数和已启用的模型。用户说“这个”“这些”“这里”时，用 ui_get_selection / ui_get_viewport 看用户现在选中和看着的东西。
- 尽量复用画布上已有的素材、角色卡和节点，用连线把它们接起来，而不是重复上传或抄写内容。
- 新节点放在相关元素旁边（near 参数），起一个能看懂的名字。
- 用户对某个结果不满意时，优先新建一个调整后的分支节点再运行，保留原结果方便对比；用户明确要求时才直接改原节点或删除。
- 运行节点会产生费用，视频尤其贵且慢：只运行完成任务需要的节点，不要批量试错；跑完用 view_media 看一眼效果再决定下一步。
- 生成视频、整组运行（run_frame / run_flow / run_storyboard）、删除用户已有的东西等操作可能返回 needs_approval：用一句话告诉用户在等什么确认，然后调用 await_approval；用户允许后会直接执行并返回结果，不要重复调用原工具。
- 每一轮的改动用户都能一键撤销，所以可以放手搭建；但不要删除用户没让删的东西。
- 任务较大（要建很多节点、运行多次或花不少钱）时，先用 propose_plan 列出步骤请用户同意，执行中用 update_plan 逐步打勾。
- 修改已有的镜头或节点（如“让第三镜头更紧张”“这句台词改一下”）时，先用 propose_edit 给出修改方案：写明每个目标节点要改的参数，用户会在方案卡片上选只改文字、只出候选图或完整方案，调用 await_approval 等结果，不要自己改参数再运行。
- 做完后用 ui_focus 把用户的镜头带到主要结果上。
- 做短剧时优先用现成流程：place_drama_template 铺骨架，extract_cast 把抽取结果建成设定卡，expand_storyboard 把分镜展开成镜头节点，run_storyboard 批量生成，分镜改过后用 sync_storyboard 同步。需要角色、场景时先 search_library 看资产库里有没有，有就 place_library_item，满意的设定卡可以 save_to_library。写提示词可以先 list_presets / apply_preset 套模板，再用 rewrite_prompt 润色。
- 角色参考图 + 声音做视频时，常见做法：生成图片节点出关键帧 → 生成视频节点（首帧）出画面 → 配音节点出台词 → 序列节点把镜头和对白合成为成片。
- 用简体中文回复，简短说明你做了什么、结果在哪个元素上，以及还有什么需要用户决定的。`

type SessionRow = typeof agentSessions.$inferSelect

interface Live {
  row: SessionRow
  items: AgentItem[]
  /** 长驻的 CLI 进程：多轮对话都发给它，空闲久了或换权限档时重启 */
  driver: CliDriver | null
  /** 这一轮已经开始到结束之间为 true，防止双击发送起两轮 */
  busy: boolean
  turnTimer: NodeJS.Timeout | null
  token: string
  mcp: McpServer
  /** 画布工具（MCP 和内置智能体共用一份，含确认关卡） */
  tools: McpTool[]
  /** 内置智能体这一轮的取消开关 */
  abort: AbortController | null
  listeners: Set<(e: AgentEvent) => void>
  stopped: boolean
  /** 当前这一轮的 id：CLI 的条目 id 加上它才保证唯一 */
  turn: string
  /** 改动集与按轮撤销 */
  changes: AgentChanges
  approvals: Approvals
  plan: AgentPlan
  /** 这一轮的确认方式 */
  mode: AgentApprovalMode
  releaseTimer: NodeJS.Timeout | null
}

export interface AgentDeps {
  db: DB
  library: LibraryStore
  rooms: Rooms
  runs: NodeRuns
  host: PluginHost
  assets: AssetStore
  /** 修改方案（三种入口共用一份） */
  plans?: EditPlans
  dataDir: string
  /** 本机免登录模式才允许：调用 CLI 等于在服务端所在机器上以当前用户身份执行 */
  enabled: boolean
}

/** 本机智能体会话：每个会话一个长驻 CLI 进程，进程退出后用 CLI 自己的会话 id 续上 */
export class AgentSessions {
  private live = new Map<string, Live>()
  private byToken = new Map<string, Live>()
  private mcpUrl = ''
  /** 找本机 CLI；测试里换成假的 */
  detect: (refresh?: boolean) => Promise<CliEnvironment> = detectClis

  constructor(private deps: AgentDeps) {
    deps.rooms.onDrop((id) => this.closeCanvas(id))
  }

  /** 是否允许调用本机 CLI */
  get localEnabled() {
    return this.deps.enabled
  }

  /** 服务端开始监听后告知 MCP 地址（桌面端端口是随机的） */
  setMcpUrl(url: string) {
    this.mcpUrl = url
  }

  async status(refresh = false): Promise<AgentStatus> {
    const model = builtinModel(this.deps.host)
    const builtin = {
      id: 'builtin' as const,
      name: '内置',
      available: !!model,
      ...(model ? { model: model.title } : {}),
    }
    // 内置智能体不跑本机程序，哪种部署都能用；CLI 只在本机免登录模式下可用
    if (!this.deps.enabled) {
      return model
        ? { enabled: true, agents: [builtin] }
        : {
            enabled: false,
            reason: '把默认对话模型设成支持工具调用的模型（如百炼的千问）后，就能使用内置智能体',
            agents: [builtin],
          }
    }
    const env = await this.detect(refresh)
    return {
      enabled: true,
      agents: [builtin, ...env.agents.map(({ path: _, ...a }) => a)],
    }
  }

  // ── 会话 ─────────────────────────────────────────

  list(canvasId: string, ownerId: string): AgentSessionSummary[] {
    return this.deps.db
      .select()
      .from(agentSessions)
      .where(and(eq(agentSessions.canvas_id, canvasId), eq(agentSessions.owner_id, ownerId)))
      .orderBy(desc(agentSessions.updated_at))
      .limit(50)
      .all()
      .map((r) => this.summary(this.live.get(r.id)?.row ?? r))
  }

  create(canvasId: string, ownerId: string, agent: AgentKind): AgentSession {
    const now = Date.now()
    const row: SessionRow = {
      id: newId('agt'),
      owner_id: ownerId,
      canvas_id: canvasId,
      agent,
      cli_session: null,
      title: '新对话',
      items: '[]',
      created_at: now,
      updated_at: now,
    }
    this.deps.db.insert(agentSessions).values(row).run()
    return this.view(this.load(row.id)!)
  }

  get(id: string, ownerId: string): AgentSession | null {
    const s = this.load(id)
    return s && s.row.owner_id === ownerId ? this.view(s) : null
  }

  delete(id: string, ownerId: string): boolean {
    const s = this.load(id)
    if (!s || s.row.owner_id !== ownerId) return false
    this.stop(id)
    this.drop(s)
    this.deps.db.delete(agentSessions).where(eq(agentSessions.id, id)).run()
    return true
  }

  subscribe(id: string, fn: (e: AgentEvent) => void): () => void {
    const s = this.load(id)
    if (!s) return () => {}
    s.listeners.add(fn)
    this.keep(s)
    return () => {
      s.listeners.delete(fn)
      this.scheduleRelease(s)
    }
  }

  /** 用户允许或跳过一张确认单；允许后立即执行原调用 */
  decide(id: string, ownerId: string, approvalId: string, allow: boolean, scope?: EditScope) {
    const s = this.load(id)
    if (!s || s.row.owner_id !== ownerId) throw new AgentError('not_found', '会话不存在')
    if (!s.approvals.decide(approvalId, allow, scope))
      throw new AgentError('not_undoable', '这个确认已经处理过或过期了')
  }

  /** 撤销某一轮对画布的改动（只能从最近一轮往回撤） */
  undoTurn(id: string, ownerId: string, turn: string) {
    const s = this.load(id)
    if (!s || s.row.owner_id !== ownerId) throw new AgentError('not_found', '会话不存在')
    if (s.busy) throw new AgentError('busy', '这一轮还没结束，先停止再撤销')
    if (!s.changes.undoTurn(turn))
      throw new AgentError('not_undoable', '这一轮的改动已经不能撤销了')
    const item = s.items.find((i) => i.type === 'changes' && i.turn === turn)
    if (item?.type === 'changes') this.push(s, { ...item, undone: true, undoable: false })
    this.refreshUndoable(s)
  }

  /** 发一条消息：启动这一轮的 CLI 进程，立即返回；过程经事件流推送 */
  async send(
    id: string,
    ownerId: string,
    text: string,
    selection?: string[],
    mode: AgentApprovalMode = 'rules',
    plan = false,
    access: AgentAccess = 'auto',
  ) {
    const s = this.load(id)
    if (!s || s.row.owner_id !== ownerId) throw new AgentError('not_found', '会话不存在')
    if (s.busy) throw new AgentError('busy', '上一条消息还在处理中')
    if (!this.deps.enabled && s.row.agent !== 'builtin')
      throw new AgentError('disabled', '本机智能体未启用')
    s.busy = true
    try {
      s.mode = mode
      s.plan.begin(plan)
      if (s.row.agent === 'builtin') this.startBuiltin(s, text, selection)
      else await this.startTurn(s, text, selection, access)
    } catch (err) {
      s.busy = false
      throw err
    }
  }

  private async startTurn(
    s: Live,
    text: string,
    selection: string[] | undefined,
    access: AgentAccess,
  ) {
    const env = await this.detect()
    const cli = env.agents.find((a) => a.id === s.row.agent)
    if (!cli?.path)
      throw new AgentError('not_installed', `本机没有找到 ${cli?.name ?? s.row.agent}`)
    if (!this.mcpUrl) throw new AgentError('not_ready', '服务端还没准备好')
    // 权限档变了要带新参数重启（之后用 CLI 的会话 id 接上）
    if (s.driver && (!s.driver.alive || s.driver.access !== access)) {
      s.driver.close()
      s.driver = null
    }
    this.beginTurn(s, text, selection)
    s.stopped = false
    s.driver ??= this.startDriver(s, cli, env.path, access)
    s.turnTimer = setTimeout(() => this.stop(s.row.id), TURN_TIMEOUT_MS)
    s.driver.send(this.prompt(s, text, selection))
  }

  /** 起一个长驻 CLI 进程，把它的事件落到这个会话里 */
  private startDriver(s: Live, cli: ResolvedCli, path: string, access: AgentAccess): CliDriver {
    // 所有会话共用一个工作目录：Claude Code 按目录归档会话，分开会在它的项目列表里留下一堆记录
    const workdir = join(this.deps.dataDir, 'agent')
    mkdirSync(workdir, { recursive: true })
    let driver!: CliDriver
    const mine = () => s.driver === driver
    const tid = (id: string) => `${s.turn}_${id}`
    const start = cli.id === 'claude' ? startClaude : startCodex
    driver = start(
      {
        bin: cli.path!,
        name: cli.name,
        cwd: workdir,
        env: childEnv({ ...process.env, PATH: path, [TOKEN_ENV]: s.token }, [TOKEN_ENV]),
        resume: s.row.cli_session,
        access,
        mcpUrl: this.mcpUrl,
        token: s.token,
        instructions: INSTRUCTIONS,
      },
      {
        session: (id) => {
          if (!mine() || id === s.row.cli_session) return
          s.row.cli_session = id
          this.save(s)
        },
        text: (id, text, done) => {
          if (!mine() || !s.busy) return
          const item: AgentItem = { id: tid(id), type: 'text', text, at: Date.now() }
          // 流式增量只推给界面，一段结束再存库
          if (done) this.push(s, item)
          else this.pushLive(s, item)
        },
        toolStart: (id, name, detail) => {
          if (!mine() || !s.busy) return
          this.push(s, {
            id: tid(id),
            type: 'tool',
            name,
            detail,
            status: 'running',
            at: Date.now(),
          })
        },
        toolEnd: (id, error, output, fallback) => {
          if (mine() && s.busy) this.finishTool(s, tid(id), error, output, fallback)
        },
        error: (text) => {
          if (mine() && s.busy) this.fail(s, text)
        },
        turnEnd: () => {
          if (!mine() || !s.busy) return
          if (s.stopped) this.fail(s, '已停止')
          this.endTurn(s)
        },
        exit: (reason) => {
          if (!mine()) return
          s.driver = null
          if (!s.busy) return
          this.fail(s, s.stopped ? '已停止' : (reason ?? `${cli.name} 已退出`))
          this.endTurn(s)
        },
        permission: (ask, signal) => this.askPermission(s, ask, signal),
      },
    )
    return driver
  }

  /** CLI 要做需要点头的事：在面板里出一张确认卡片，等用户允许或拒绝 */
  private async askPermission(s: Live, ask: PermissionAsk, signal: AbortSignal) {
    const a = s.approvals.create(ask.tool, { reason: ask.reason, ids: [] }, async () => true)
    const expire = () => s.approvals.expire(a.id)
    if (signal.aborted) expire()
    signal.addEventListener('abort', expire, { once: true })
    while (a.status === 'pending') await s.approvals.wait(a.id, 600)
    signal.removeEventListener('abort', expire)
    return a.status === 'approved'
  }

  /** 开始一轮：挂上撤销栈、记下用户消息、通知界面在跑 */
  private beginTurn(s: Live, text: string, selection?: string[]) {
    this.keep(s)
    s.turn = newId('turn')
    s.changes.begin(s.turn)
    if (s.items.length === 0) s.row.title = text.replace(/\s+/g, ' ').slice(0, 40)
    this.push(s, { id: newId('it'), type: 'user', text, selection, at: Date.now() })
    this.setRunning(s, true)
  }

  /** 一轮结束（不论成败）：收尾工具、改动集、状态和租约 */
  private endTurn(s: Live) {
    s.busy = false
    if (s.turnTimer) clearTimeout(s.turnTimer)
    s.turnTimer = null
    this.closeRunningTools(s)
    this.finishTurn(s)
    this.setRunning(s, false)
    this.scheduleRelease(s)
  }

  /** 内置智能体：在服务端进程里跑模型 ↔ 工具循环，工具与 CLI 走的 MCP 是同一份 */
  private startBuiltin(s: Live, text: string, selection?: string[]) {
    const model = builtinModel(this.deps.host)
    if (!model)
      throw new AgentError(
        'not_installed',
        '默认对话模型不支持工具调用：请在 设置 → 默认模型 里换一个支持的对话模型',
      )
    const history = historyOf(s.items)
    this.beginTurn(s, text, selection)
    const abort = new AbortController()
    s.abort = abort
    s.stopped = false
    const turn = s.turn
    const id = (key: string) => `${turn}_${key}`
    const timer = setTimeout(() => abort.abort(), TURN_TIMEOUT_MS)
    runBuiltinTurn({
      host: this.deps.host,
      model: model.ref,
      ownerId: s.row.owner_id,
      system: INSTRUCTIONS,
      history,
      prompt: this.prompt(s, text, selection),
      tools: s.tools,
      signal: abort.signal,
      onText: (key, t, done) => {
        const item: AgentItem = { id: id(key), type: 'text', text: t, at: Date.now() }
        // 流式增量只推给界面，一步结束再存库
        if (done) this.push(s, item)
        else this.pushLive(s, item)
      },
      onToolStart: (call) =>
        this.push(s, {
          id: id(call.id),
          type: 'tool',
          name: call.name,
          detail: brief(call.arguments),
          status: 'running',
          at: Date.now(),
        }),
      onToolEnd: (call, result: ToolResult) =>
        this.finishTool(s, id(call.id), result.isError === true, toolText(result.content)),
    })
      .catch((err: unknown) => {
        if (err instanceof ProviderError) this.fail(s, err.message)
        else {
          console.warn('[agent] 内置智能体出错：', err)
          this.fail(s, `内置智能体出错：${(err as Error).message}`)
        }
      })
      .finally(() => {
        clearTimeout(timer)
        s.abort = null
        if (s.stopped) this.fail(s, '已停止')
        this.endTurn(s)
      })
  }

  stop(id: string) {
    const s = this.live.get(id)
    if (s?.abort) {
      s.stopped = true
      s.abort.abort()
      return
    }
    if (!s?.driver || !s.busy) return
    s.stopped = true
    s.driver.interrupt()
  }

  /** 画布被删除：停掉它的智能体会话并释放内存（数据库记录随画布级联删除） */
  closeCanvas(canvasId: string) {
    for (const s of [...this.live.values()]) {
      if (s.row.canvas_id !== canvasId) continue
      this.stop(s.row.id)
      this.drop(s)
    }
  }

  close() {
    for (const s of this.live.values()) {
      s.abort?.abort()
      s.stopped = true
      s.driver?.close()
    }
  }

  // ── MCP ──────────────────────────────────────────

  /** 智能体调用画布工具的入口；令牌对应到会话所在的画布和用户 */
  async handleMcp(token: string, body: unknown) {
    const s = this.byToken.get(token)
    if (!s) return undefined
    return s.mcp.handle(body)
  }

  // ── 提示词 ──────────────────────────────────────

  private prompt(s: Live, text: string, selection?: string[]) {
    const parts: string[] = []
    if (selection?.length) {
      const lines = this.describeSelection(s.row.canvas_id, selection)
      if (lines.length) parts.push(`用户当前在画布上选中了：\n${lines.join('\n')}`)
    }
    if (s.plan.planMode)
      parts.push(
        '（计划模式：先用只读工具了解情况，再调用 propose_plan 列出步骤并 await_approval 等用户同意；同意后才能改画布或运行，每做完一步调用 update_plan。）',
      )
    parts.push(text)
    return parts.join('\n\n')
  }

  private describeSelection(canvasId: string, ids: string[]) {
    return this.deps.rooms.withDoc(canvasId, (doc) =>
      ids.flatMap((id) => {
        const el = doc.get(id)
        if (!el) return []
        const label = el.kind === 'node' ? el.nodeType : el.kind
        return [`- ${id}（${label}${el.name ? `，「${el.name}」` : ''}）`]
      }),
    )
  }

  // ── 状态 ─────────────────────────────────────────

  private finishTool(
    s: Live,
    id: string,
    error: boolean,
    output: string | undefined,
    fallback?: { name: string; detail?: string },
  ) {
    const prev = s.items.find((i) => i.id === id)
    const base =
      prev?.type === 'tool'
        ? prev
        : {
            id,
            type: 'tool' as const,
            name: fallback?.name ?? 'tool',
            detail: fallback?.detail,
            at: Date.now(),
          }
    this.push(s, { ...base, status: error ? 'error' : 'done', output: output?.slice(0, 600) })
  }

  /** 进程意外结束时还在“运行中”的工具标为出错 */
  private closeRunningTools(s: Live) {
    for (const it of s.items) {
      if (it.type === 'tool' && it.status === 'running') this.push(s, { ...it, status: 'error' })
    }
  }

  /** 一轮结束：记下改动集，前面几轮不再能撤（只能从最近一轮往回撤） */
  private finishTurn(s: Live) {
    s.approvals.expireAll()
    const c = s.changes.end()
    if (c) {
      this.push(s, {
        id: `chg_${s.turn}`,
        type: 'changes',
        turn: s.turn,
        ...c,
        undoable: s.changes.canUndo(s.turn),
        at: Date.now(),
      })
    }
    this.refreshUndoable(s)
  }

  private refreshUndoable(s: Live) {
    for (const it of s.items) {
      if (it.type !== 'changes') continue
      const undoable = !it.undone && s.changes.canUndo(it.turn)
      if (undoable !== it.undoable) this.push(s, { ...it, undoable })
    }
  }

  /** 有人订阅或开始一轮：保留画布租约 */
  private keep(s: Live) {
    if (s.releaseTimer) clearTimeout(s.releaseTimer)
    s.releaseTimer = null
  }

  /** 没人订阅且空闲时，过一段时间释放租约和撤销栈 */
  private scheduleRelease(s: Live) {
    if (s.listeners.size || s.busy || (!s.changes.attached && !s.driver)) return
    this.keep(s)
    s.releaseTimer = setTimeout(() => {
      s.releaseTimer = null
      if (s.listeners.size || s.busy) return
      // 空闲的 CLI 进程也收掉，下次发消息再用会话 id 接上
      s.driver?.close()
      s.driver = null
      s.changes.release()
      this.refreshUndoable(s)
    }, RELEASE_AFTER_MS)
    s.releaseTimer.unref?.()
  }

  private fail(s: Live, text: string) {
    this.push(s, { id: newId('err'), type: 'error', text, at: Date.now() })
  }

  /** 新增或按 id 替换一项，存库并推送 */
  private push(s: Live, item: AgentItem) {
    const i = s.items.findIndex((x) => x.id === item.id)
    if (i >= 0) s.items[i] = item
    else s.items.push(item)
    s.row.updated_at = Date.now()
    this.save(s)
    this.emit(s, { type: 'item', item })
  }

  /** 只推给界面、不存库（流式文字的中间状态） */
  private pushLive(s: Live, item: AgentItem) {
    const i = s.items.findIndex((x) => x.id === item.id)
    if (i >= 0) s.items[i] = item
    else s.items.push(item)
    this.emit(s, { type: 'item', item })
  }

  private setRunning(s: Live, running: boolean) {
    this.emit(s, { type: 'status', status: running ? 'running' : 'idle' })
  }

  private emit(s: Live, e: AgentEvent) {
    for (const fn of s.listeners) fn(e)
  }

  private save(s: Live) {
    s.row.items = JSON.stringify(s.items)
    const { cli_session, title, items, updated_at } = s.row
    this.deps.db
      .update(agentSessions)
      .set({ cli_session, title, items, updated_at })
      .where(eq(agentSessions.id, s.row.id))
      .run()
  }

  private load(id: string): Live | null {
    const cached = this.live.get(id)
    if (cached) return cached
    const row = this.deps.db.select().from(agentSessions).where(eq(agentSessions.id, id)).get()
    if (!row) return null
    const token = randomBytes(24).toString('hex')
    const { rooms, runs, host, assets, library } = this.deps
    let s!: Live
    const changes = new AgentChanges(row.id, row.canvas_id, row.owner_id, rooms, runs, (ids) =>
      this.emit(s, { type: 'touch', ids }),
    )
    const plan = new AgentPlan((item) => this.push(s, item))
    const approvals = new Approvals((a) => {
      // 计划的确认单显示成计划卡片，修改方案的显示成方案卡片
      if (a.tool === PLAN_TOOL) return plan.onApproval(a)
      if (a.tool === PROPOSE_EDIT) return this.editPlanDecided(s, a)
      this.push(s, {
        id: a.id,
        type: 'approval',
        tool: a.tool,
        reason: a.reason,
        ids: a.ids,
        status: a.status,
        at: Date.now(),
      })
    })
    const tools = agentTools(
      {
        canvasId: row.canvas_id,
        ownerId: row.owner_id,
        rooms,
        runs,
        host,
        assets,
        library,
        plans: this.deps.plans,
        origin: changes.origin,
        onRun: (nodeId, runId) => changes.recordRun(nodeId, runId),
        onGroup: (groupId) => changes.recordGroup(groupId),
        ui: (action, ids) => {
          if (!s.listeners.size) return false
          this.emit(s, { type: 'ui', action, ids })
          return true
        },
      },
      {
        changes,
        approvals,
        mode: () => s.mode,
        plan,
        onEditPlan: (approvalId, p) => this.showEditPlan(s, approvalId, p),
      },
    )
    const mcp = new McpServer(
      { name: 'plein', version: '0.1.0', instructions: '操作用户当前打开的 Plein 画布' },
      tools,
    )
    let items: AgentItem[] = []
    try {
      items = JSON.parse(row.items) as AgentItem[]
    } catch {}
    // 撤销栈只在内存里：重新加载的会话，之前的改动都不能再撤销
    items = items.map((it) =>
      it.type === 'changes' && it.undoable
        ? { ...it, undoable: false }
        : (it.type === 'approval' || it.type === 'plan' || it.type === 'edit_plan') &&
            it.status === 'pending'
          ? { ...it, status: 'expired' }
          : it,
    )
    s = {
      row,
      items,
      driver: null,
      busy: false,
      turnTimer: null,
      token,
      mcp,
      tools,
      abort: null,
      listeners: new Set(),
      stopped: false,
      turn: '',
      changes,
      approvals,
      plan,
      mode: 'rules',
      releaseTimer: null,
    }
    this.live.set(id, s)
    this.byToken.set(token, s)
    return s
  }

  /** 方案卡片：出现时和方案执行完后刷新 */
  private showEditPlan(s: Live, approvalId: string, plan: EditPlan) {
    const a = s.approvals.get(approvalId)
    const prev = s.items.find((i) => i.id === approvalId)
    this.push(s, {
      id: approvalId,
      type: 'edit_plan',
      plan,
      status: a?.status ?? 'pending',
      ...(a?.choice ? { scope: a.choice as EditScope } : {}),
      at: prev?.at ?? Date.now(),
    })
  }

  /** 方案卡片的确认单状态变了：没采用、作废时方案跟着作废 */
  private editPlanDecided(s: Live, a: Approval) {
    const item = s.items.find((i) => i.id === a.id)
    if (item?.type !== 'edit_plan') return
    const plans = this.deps.plans
    if (a.status === 'denied' || a.status === 'expired')
      plans?.settle(item.plan.id, s.row.owner_id, a.status)
    this.showEditPlan(s, a.id, plans?.get(item.plan.id, s.row.owner_id) ?? item.plan)
  }

  private drop(s: Live) {
    this.keep(s)
    s.driver?.close()
    s.driver = null
    s.changes.release()
    this.live.delete(s.row.id)
    this.byToken.delete(s.token)
  }

  private summary(row: SessionRow): AgentSessionSummary {
    return {
      id: row.id,
      canvasId: row.canvas_id,
      agent: row.agent,
      title: row.title,
      status: this.live.get(row.id)?.busy ? 'running' : 'idle',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  private view(s: Live): AgentSession {
    return { ...this.summary(s.row), items: s.items }
  }
}

export class AgentError extends Error {
  constructor(
    readonly code:
      | 'not_found'
      | 'busy'
      | 'disabled'
      | 'not_installed'
      | 'not_ready'
      | 'not_undoable',
    message: string,
  ) {
    super(message)
  }
}

/** 之前几轮的对话给内置智能体：只留用户的话和回复的文字，最近的若干条 */
function historyOf(items: AgentItem[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const it of items) {
    if (it.type === 'user') out.push({ role: 'user', content: it.text })
    else if (it.type === 'text') {
      const last = out.at(-1)
      if (last?.role === 'assistant') last.content = `${last.content}\n\n${it.text}`
      else out.push({ role: 'assistant', content: it.text })
    }
  }
  // 从用户消息开始，最多 20 条
  const tail = out.slice(-20)
  while (tail.length && tail[0]!.role !== 'user') tail.shift()
  return tail
}
