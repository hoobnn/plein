import { and, desc, eq } from 'drizzle-orm'
import { newId } from '../ids'
import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type {
  AgentApprovalMode,
  AgentEvent,
  AgentItem,
  AgentKind,
  AgentSession,
  AgentSessionSummary,
  AgentStatus,
} from '@plein/protocol'
import { type ChatMessage, ProviderError } from '@plein/plugin-sdk'
import type { AssetStore } from '../assets/store'
import type { PluginHost } from '../plugins/host'
import type { NodeRuns } from '../runs/runs'
import type { LibraryStore } from '../library/store'
import type { DB } from '../storage/db'
import { agentSessions } from '../storage/schema'
import type { Rooms } from '../sync/rooms'
import { Approvals } from './approvals'
import type { McpClients } from '../mcp/clients'
import { AgentPlan, PLAN_TOOL } from './plan'
import { AgentChanges } from './changes'
import { detectClis } from './cli'
import { builtinModels, runBuiltinTurn } from './builtin'
import { type McpTool, McpServer, type ToolResult } from './mcp'
import { agentTools } from './tools'

/** MCP 服务名：Claude Code 里工具名是 mcp__plein__<工具> */
const MCP_NAME = 'plein'
const TOOL_PREFIX = `mcp__${MCP_NAME}__`
const TOKEN_ENV = 'PLEIN_AGENT_TOKEN'
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
- 做完后用 ui_focus 把用户的镜头带到主要结果上。
- 做短剧时优先用现成流程：place_drama_template 铺骨架，extract_cast 把抽取结果建成设定卡，expand_storyboard 把分镜展开成镜头节点，run_storyboard 批量生成，分镜改过后用 sync_storyboard 同步。需要角色、场景时先 search_library 看资产库里有没有，有就 place_library_item，满意的设定卡可以 save_to_library。写提示词可以先 list_presets / apply_preset 套模板，再用 rewrite_prompt 润色。
- 角色参考图 + 声音做视频时，常见做法：生成图片节点出关键帧 → 生成视频节点（首帧）出画面 → 配音节点出台词 → 序列节点把镜头和对白合成为成片。
- 用简体中文回复，简短说明你做了什么、结果在哪个元素上，以及还有什么需要用户决定的。`

type SessionRow = typeof agentSessions.$inferSelect

interface Live {
  row: SessionRow
  items: AgentItem[]
  child: ChildProcess | null
  /** 这一轮已经开始（检查之后、进程起来之前也算），防止双击发送起两个进程 */
  busy: boolean
  token: string
  mcp: McpServer
  /** 画布工具（MCP 和内置智能体共用一份，含确认关卡） */
  tools: McpTool[]
  /** 内置智能体这一轮的取消开关 */
  abort: AbortController | null
  listeners: Set<(e: AgentEvent) => void>
  stopped: boolean
  /** 当前这一轮的 id：Codex 的条目 id 每轮从 item_0 重新编号，要加上它才唯一 */
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
  /** 外部 MCP 服务（只在本机模式有） */
  mcp?: McpClients
  dataDir: string
  /** 本机免登录模式才允许：调用 CLI 等于在服务端所在机器上以当前用户身份执行 */
  enabled: boolean
}

/** 本机智能体会话：每轮对话启动一次 CLI 进程，之后用 CLI 自己的会话 id 续上 */
export class AgentSessions {
  private live = new Map<string, Live>()
  private byToken = new Map<string, Live>()
  private mcpUrl = ''

  constructor(private deps: AgentDeps) {
    deps.rooms.onDrop((id) => this.closeCanvas(id))
  }

  /** 服务端开始监听后告知 MCP 地址（桌面端端口是随机的） */
  setMcpUrl(url: string) {
    this.mcpUrl = url
  }

  async status(refresh = false): Promise<AgentStatus> {
    const model = builtinModels(this.deps.host)[0]
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
            reason: '在设置里启用支持工具调用的对话模型（如百炼的千问）后，就能使用内置智能体',
            agents: [builtin],
          }
    }
    const env = await detectClis(refresh)
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
  decide(id: string, ownerId: string, approvalId: string, allow: boolean) {
    const s = this.load(id)
    if (!s || s.row.owner_id !== ownerId) throw new AgentError('not_found', '会话不存在')
    if (!s.approvals.decide(approvalId, allow))
      throw new AgentError('not_undoable', '这个确认已经处理过或过期了')
  }

  /** 撤销某一轮对画布的改动（只能从最近一轮往回撤） */
  undoTurn(id: string, ownerId: string, turn: string) {
    const s = this.load(id)
    if (!s || s.row.owner_id !== ownerId) throw new AgentError('not_found', '会话不存在')
    if (s.busy || s.child) throw new AgentError('busy', '这一轮还没结束，先停止再撤销')
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
  ) {
    const s = this.load(id)
    if (!s || s.row.owner_id !== ownerId) throw new AgentError('not_found', '会话不存在')
    if (s.busy || s.child) throw new AgentError('busy', '上一条消息还在处理中')
    if (!this.deps.enabled && s.row.agent !== 'builtin')
      throw new AgentError('disabled', '本机智能体未启用')
    s.busy = true
    try {
      s.mode = mode
      s.plan.begin(plan)
      if (s.row.agent === 'builtin') this.startBuiltin(s, text, selection)
      else await this.startTurn(s, text, selection)
    } catch (err) {
      s.busy = false
      throw err
    }
  }

  private async startTurn(s: Live, text: string, selection?: string[]) {
    const env = await detectClis()
    const cli = env.agents.find((a) => a.id === s.row.agent)
    if (!cli?.path)
      throw new AgentError('not_installed', `本机没有找到 ${cli?.name ?? s.row.agent}`)
    if (!this.mcpUrl) throw new AgentError('not_ready', '服务端还没准备好')
    this.beginTurn(s, text, selection)

    // 所有会话共用一个工作目录：Claude Code 按目录归档会话，分开会在它的项目列表里留下一堆记录
    const workdir = join(this.deps.dataDir, 'agent')
    mkdirSync(workdir, { recursive: true })
    const prompt = this.prompt(s, text, selection)
    const { args, stdin } =
      s.row.agent === 'claude' ? this.claudeArgs(s, prompt) : this.codexArgs(s, prompt, workdir)

    const childEnv: NodeJS.ProcessEnv = { ...process.env, PATH: env.path, [TOKEN_ENV]: s.token }
    // 不把 Plein 自己的配置和外层 Claude Code 的标记带给子进程
    for (const k of Object.keys(childEnv)) {
      if (k.startsWith('PLEIN_') && k !== TOKEN_ENV) delete childEnv[k]
    }
    delete childEnv.CLAUDECODE
    delete childEnv.CLAUDE_CODE_ENTRYPOINT
    delete childEnv.ELECTRON_RUN_AS_NODE

    let child: ChildProcess
    try {
      child = spawn(cli.path, args, {
        cwd: workdir,
        env: childEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (err) {
      this.fail(s, `启动 ${cli.name} 失败：${(err as Error).message}`)
      s.changes.end()
      s.approvals.expireAll()
      this.setRunning(s, false)
      s.busy = false
      this.scheduleRelease(s)
      return
    }
    s.child = child
    s.stopped = false
    // CLI 读 stdin 之前就退出时写入会 EPIPE；没有监听会变成未捕获异常让服务崩溃
    child.stdin?.on('error', () => {})
    child.stdin?.end(stdin)

    const parse = s.row.agent === 'claude' ? this.claudeEvent : this.codexEvent
    let sawResult = false
    createInterface({ input: child.stdout! }).on('line', (line) => {
      let ev: unknown
      try {
        ev = JSON.parse(line)
      } catch {
        return
      }
      try {
        if (parse.call(this, s, ev as Record<string, unknown>)) sawResult = true
      } catch (err) {
        console.warn('[agent] 解析事件失败：', (err as Error).message)
      }
    })
    let stderr = ''
    child.stderr?.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4000)
    })
    const timer = setTimeout(() => child.kill('SIGTERM'), TURN_TIMEOUT_MS)
    child.on('error', (err) => {
      this.fail(s, `${cli.name} 运行出错：${err.message}`)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      s.child = null
      if (s.stopped) this.fail(s, '已停止')
      else if (code !== 0 && !sawResult) {
        this.fail(s, explain(cli.name, stderr) || `${cli.name} 异常退出（代码 ${code}）`)
      }
      this.endTurn(s)
    })
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
    this.closeRunningTools(s)
    this.finishTurn(s)
    this.setRunning(s, false)
    this.scheduleRelease(s)
  }

  /** 内置智能体：在服务端进程里跑模型 ↔ 工具循环，工具与 CLI 走的 MCP 是同一份 */
  private startBuiltin(s: Live, text: string, selection?: string[]) {
    const model = builtinModels(this.deps.host)[0]
    if (!model)
      throw new AgentError(
        'not_installed',
        '没有支持工具调用的对话模型：请先在设置里启用百炼等平台',
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
    if (!s?.child) return
    s.stopped = true
    s.child.kill('SIGTERM')
    const child = s.child
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL')
    }, 3000).unref()
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
      if (s.child) {
        s.stopped = true
        s.child.kill('SIGTERM')
      }
    }
  }

  // ── MCP ──────────────────────────────────────────

  /** 智能体调用画布工具的入口；令牌对应到会话所在的画布和用户 */
  async handleMcp(token: string, body: unknown) {
    const s = this.byToken.get(token)
    if (!s) return undefined
    return s.mcp.handle(body)
  }

  // ── CLI 参数 ──────────────────────────────────────

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

  private claudeArgs(s: Live, prompt: string) {
    const mcp = {
      mcpServers: {
        [MCP_NAME]: {
          type: 'http',
          url: this.mcpUrl,
          headers: { Authorization: `Bearer ${s.token}` },
        },
      },
    }
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--mcp-config',
      JSON.stringify(mcp),
      '--strict-mcp-config',
      // 只开放画布工具和联网查资料，不让它碰本机文件和命令
      '--tools',
      'WebSearch,WebFetch',
      '--allowedTools',
      `mcp__${MCP_NAME}`,
      'WebSearch',
      'WebFetch',
      '--permission-mode',
      'dontAsk',
      '--append-system-prompt',
      INSTRUCTIONS,
    ]
    if (s.row.cli_session) args.push('--resume', s.row.cli_session)
    return { args, stdin: prompt }
  }

  private codexArgs(s: Live, prompt: string, workdir: string) {
    const config = [
      `mcp_servers.${MCP_NAME}.url=${JSON.stringify(this.mcpUrl)}`,
      `mcp_servers.${MCP_NAME}.bearer_token_env_var=${JSON.stringify(TOKEN_ENV)}`,
      `mcp_servers.${MCP_NAME}.tool_timeout_sec=120`,
      // exec 模式没人能点审批，画布工具默认放行
      `mcp_servers.${MCP_NAME}.default_tools_approval_mode="approve"`,
      `developer_instructions=${JSON.stringify(INSTRUCTIONS)}`,
    ].flatMap((c) => ['-c', c])
    const common = ['--json', '--skip-git-repo-check', ...config]
    const args = s.row.cli_session
      ? ['exec', ...common, 'resume', s.row.cli_session, '-']
      : ['exec', ...common, '-s', 'read-only', '-C', workdir, '-']
    return { args, stdin: prompt }
  }

  // ── 事件解析 ──────────────────────────────────────

  /** Claude Code stream-json；返回 true 表示这一轮正常结束 */
  private claudeEvent(s: Live, ev: Record<string, unknown>): boolean {
    if (typeof ev.session_id === 'string' && ev.session_id !== s.row.cli_session) {
      s.row.cli_session = ev.session_id
      this.save(s)
    }
    const message = ev.message as { id?: string; content?: unknown } | undefined
    const blocks = Array.isArray(message?.content)
      ? (message.content as Array<Record<string, unknown>>)
      : []
    if (ev.type === 'assistant') {
      blocks.forEach((b, i) => {
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          this.push(s, {
            id: `${message?.id ?? newId('m')}_${i}`,
            type: 'text',
            text: b.text,
            at: Date.now(),
          })
        } else if (b.type === 'tool_use') {
          this.push(s, {
            id: String(b.id),
            type: 'tool',
            name: String(b.name).replace(TOOL_PREFIX, ''),
            detail: brief(b.input),
            status: 'running',
            at: Date.now(),
          })
        }
      })
    } else if (ev.type === 'user') {
      for (const b of blocks) {
        if (b.type !== 'tool_result') continue
        this.finishTool(s, String(b.tool_use_id), b.is_error === true, toolText(b.content))
      }
    } else if (ev.type === 'result') {
      if (ev.is_error === true || (typeof ev.subtype === 'string' && ev.subtype !== 'success')) {
        const msg = typeof ev.result === 'string' && ev.result ? ev.result : String(ev.subtype)
        this.fail(s, msg)
      }
      return true
    }
    return false
  }

  /** Codex exec --json */
  private codexEvent(s: Live, ev: Record<string, unknown>): boolean {
    if (ev.type === 'thread.started' && typeof ev.thread_id === 'string') {
      s.row.cli_session = ev.thread_id
      this.save(s)
    } else if (ev.type === 'item.started' || ev.type === 'item.completed') {
      const item = ev.item as Record<string, unknown> | undefined
      if (!item) return false
      const done = ev.type === 'item.completed'
      const itemId = `${s.turn}_${String(item.id)}`
      if (item.type === 'agent_message' && done && typeof item.text === 'string') {
        this.push(s, { id: itemId, type: 'text', text: item.text, at: Date.now() })
      } else if (item.type === 'mcp_tool_call') {
        const failed = item.status === 'failed' || !!item.error
        if (!done) {
          this.push(s, {
            id: itemId,
            type: 'tool',
            name: String(item.tool),
            detail: brief(item.arguments),
            status: 'running',
            at: Date.now(),
          })
        } else {
          const result = item.result as { content?: unknown } | undefined
          const err = item.error as { message?: string } | undefined
          this.finishTool(s, itemId, failed, err?.message ?? toolText(result?.content), {
            name: String(item.tool),
            detail: brief(item.arguments),
          })
        }
      } else if (item.type === 'web_search' && done) {
        this.push(s, {
          id: itemId,
          type: 'tool',
          name: 'web_search',
          detail: typeof item.query === 'string' ? item.query : undefined,
          status: 'done',
          at: Date.now(),
        })
      } else if (item.type === 'command_execution') {
        this.push(s, {
          id: itemId,
          type: 'tool',
          name: 'shell',
          detail: typeof item.command === 'string' ? item.command.slice(0, 200) : undefined,
          status: done ? (item.exit_code === 0 ? 'done' : 'error') : 'running',
          at: Date.now(),
        })
      } else if (item.type === 'error' && typeof item.message === 'string') {
        this.fail(s, item.message)
      }
    } else if (ev.type === 'turn.completed') {
      return true
    } else if (ev.type === 'turn.failed') {
      const err = ev.error as { message?: string } | undefined
      this.fail(s, err?.message ?? 'Codex 运行失败')
      return true
    } else if (ev.type === 'error' && typeof ev.message === 'string') {
      this.fail(s, ev.message)
    }
    return false
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
    if (s.listeners.size || s.busy || s.child || !s.changes.attached) return
    this.keep(s)
    s.releaseTimer = setTimeout(() => {
      s.releaseTimer = null
      if (s.listeners.size || s.busy || s.child) return
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
      // 计划的确认单显示成计划卡片
      if (a.tool === PLAN_TOOL) return plan.onApproval(a)
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
        mcp: this.deps.mcp,
        origin: changes.origin,
        onRun: (nodeId, runId) => changes.recordRun(nodeId, runId),
        onGroup: (groupId) => changes.recordGroup(groupId),
        ui: (action, ids) => {
          if (!s.listeners.size) return false
          this.emit(s, { type: 'ui', action, ids })
          return true
        },
      },
      { changes, approvals, mode: () => s.mode, plan },
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
        : (it.type === 'approval' || it.type === 'plan') && it.status === 'pending'
          ? { ...it, status: 'expired' }
          : it,
    )
    s = {
      row,
      items,
      child: null,
      busy: false,
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

  private drop(s: Live) {
    this.keep(s)
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
      status: this.live.get(row.id)?.child ? 'running' : 'idle',
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

/** 工具参数的一行摘要 */
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

function brief(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const o = input as Record<string, unknown>
  const pick = o.type ?? o.kind ?? o.id ?? o.element_id ?? o.query ?? o.url
  const extra =
    o.params && typeof o.params === 'object' ? (o.params as Record<string, unknown>).prompt : o.text
  const parts = [pick, extra].filter((v): v is string => typeof v === 'string' && v.length > 0)
  const s = parts.join(' · ')
  return s ? (s.length > 120 ? `${s.slice(0, 120)}…` : s) : undefined
}

/** MCP 工具结果内容转成一段文字 */
function toolText(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  return (
    content
      .map((c: { type?: string; text?: string }) =>
        c.type === 'text' ? (c.text ?? '') : c.type === 'image' ? '[图片]' : '',
      )
      .filter(Boolean)
      .join('\n')
      // Claude Code 把图片结果另存到本地，并在文字里附上路径，对用户没用
      .replace(/\[Image: source: [^\]]*\]/g, '')
      .trim()
  )
}

/** 把常见的 CLI 报错翻译成能操作的提示 */
function explain(name: string, stderr: string): string | undefined {
  const s = stderr.trim()
  if (!s) return undefined
  if (/log ?in|logged in|authenticat|unauthori[sz]ed|401/i.test(s)) {
    return `${name} 还没有登录：请先在终端运行 ${name === 'Codex' ? 'codex login' : 'claude'} 完成登录。\n${s.slice(-300)}`
  }
  return `${name} 出错：${s.slice(-600)}`
}
