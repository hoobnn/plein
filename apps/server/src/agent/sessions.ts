import { newId } from '../ids'
import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type {
  AgentEvent,
  AgentItem,
  AgentKind,
  AgentSession,
  AgentSessionSummary,
  AgentStatus,
} from '@plein/protocol'
import { createDoc } from '@plein/doc'
import type { AssetStore } from '../assets/store'
import type { PluginHost } from '../plugins/host'
import type { NodeRuns } from '../runs/runs'
import type { DB } from '../storage/db'
import type { Rooms } from '../sync/rooms'
import { detectClis } from './cli'
import { McpServer } from './mcp'
import { canvasTools } from './tools'

/** MCP 服务名：Claude Code 里工具名是 mcp__plein__<工具> */
const MCP_NAME = 'plein'
const TOOL_PREFIX = `mcp__${MCP_NAME}__`
const TOKEN_ENV = 'PLEIN_AGENT_TOKEN'
/** 每轮对话的上限，防止 CLI 卡住 */
const TURN_TIMEOUT_MS = 60 * 60 * 1000

const INSTRUCTIONS = `你是 Plein 的创作助手。Plein 是一块 AI 无限画布：画布上有图片、视频、音频、Markdown 元素和工作流节点（文本、LLM、生成图片、生成视频、配音、配乐、角色、场景、分镜、序列等），节点之间用连线传递数据，运行节点会调用模型生成结果。

你通过 plein MCP 工具操作用户当前打开的这块画布，所有改动会实时出现在用户屏幕上。

做事方式：
- 先用 get_canvas 看清画布，用 list_node_types 了解可用节点、参数和已启用的模型。
- 尽量复用画布上已有的素材、角色卡和节点，用连线把它们接起来，而不是重复上传或抄写内容。
- 新节点放在相关元素旁边（near 参数），起一个能看懂的名字。
- 用户对某个结果不满意时，优先新建一个调整后的分支节点再运行，保留原结果方便对比；用户明确要求时才直接改原节点或删除。
- 运行节点会产生费用，视频尤其贵且慢：只运行完成任务需要的节点，不要批量试错；跑完用 view_media 看一眼效果再决定下一步。
- 角色参考图 + 声音做视频时，常见做法：生成图片节点出关键帧 → 生成视频节点（首帧）出画面 → 配音节点出台词 → 序列节点把镜头和对白合成为成片。
- 用简体中文回复，简短说明你做了什么、结果在哪个元素上，以及还有什么需要用户决定的。`

interface SessionRow {
  id: string
  owner_id: string
  canvas_id: string
  agent: AgentKind
  cli_session: string | null
  title: string
  items: string
  created_at: number
  updated_at: number
}

interface Live {
  row: SessionRow
  items: AgentItem[]
  child: ChildProcess | null
  /** 这一轮已经开始（检查之后、进程起来之前也算），防止双击发送起两个进程 */
  busy: boolean
  token: string
  mcp: McpServer
  listeners: Set<(e: AgentEvent) => void>
  stopped: boolean
  /** 当前这一轮的 id：Codex 的条目 id 每轮从 item_0 重新编号，要加上它才唯一 */
  turn: string
}

export interface AgentDeps {
  db: DB
  rooms: Rooms
  runs: NodeRuns
  host: PluginHost
  assets: AssetStore
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
    if (!this.deps.enabled) {
      return {
        enabled: false,
        reason: '本机智能体只在桌面端或本机免登录模式下可用',
        agents: [],
      }
    }
    const env = await detectClis(refresh)
    return {
      enabled: true,
      agents: env.agents.map(({ path: _, ...a }) => a),
    }
  }

  // ── 会话 ─────────────────────────────────────────

  list(canvasId: string, ownerId: string): AgentSessionSummary[] {
    return this.deps.db
      .prepare<[string, string], SessionRow>(
        'SELECT * FROM agent_sessions WHERE canvas_id = ? AND owner_id = ? ORDER BY updated_at DESC LIMIT 50',
      )
      .all(canvasId, ownerId)
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
    this.deps.db
      .prepare(
        `INSERT INTO agent_sessions (id, owner_id, canvas_id, agent, cli_session, title, items, created_at, updated_at)
         VALUES (@id, @owner_id, @canvas_id, @agent, @cli_session, @title, @items, @created_at, @updated_at)`,
      )
      .run(row)
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
    this.deps.db.prepare('DELETE FROM agent_sessions WHERE id = ?').run(id)
    return true
  }

  subscribe(id: string, fn: (e: AgentEvent) => void): () => void {
    const s = this.load(id)
    if (!s) return () => {}
    s.listeners.add(fn)
    return () => s.listeners.delete(fn)
  }

  /** 发一条消息：启动这一轮的 CLI 进程，立即返回；过程经事件流推送 */
  async send(id: string, ownerId: string, text: string, selection?: string[]) {
    const s = this.load(id)
    if (!s || s.row.owner_id !== ownerId) throw new AgentError('not_found', '会话不存在')
    if (s.busy || s.child) throw new AgentError('busy', '上一条消息还在处理中')
    if (!this.deps.enabled) throw new AgentError('disabled', '本机智能体未启用')
    s.busy = true
    try {
      await this.startTurn(s, text, selection)
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

    if (s.items.length === 0) s.row.title = text.replace(/\s+/g, ' ').slice(0, 40)
    this.push(s, { id: newId('it'), type: 'user', text, selection, at: Date.now() })
    this.setRunning(s, true)

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
      this.setRunning(s, false)
      s.busy = false
      return
    }
    s.child = child
    s.stopped = false
    s.turn = newId('turn')
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
      s.busy = false
      if (s.stopped) this.fail(s, '已停止')
      else if (code !== 0 && !sawResult) {
        this.fail(s, explain(cli.name, stderr) || `${cli.name} 异常退出（代码 ${code}）`)
      }
      this.closeRunningTools(s)
      this.setRunning(s, false)
    })
  }

  stop(id: string) {
    const s = this.live.get(id)
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
    parts.push(text)
    return parts.join('\n\n')
  }

  private describeSelection(canvasId: string, ids: string[]) {
    const doc = createDoc(this.deps.rooms.get(canvasId).doc)
    try {
      return ids.flatMap((id) => {
        const el = doc.get(id)
        if (!el) return []
        const label = el.kind === 'node' ? el.nodeType : el.kind
        return [`- ${id}（${label}${el.name ? `，「${el.name}」` : ''}）`]
      })
    } finally {
      doc.destroy()
    }
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

  private setRunning(s: Live, running: boolean) {
    this.emit(s, { type: 'status', status: running ? 'running' : 'idle' })
  }

  private emit(s: Live, e: AgentEvent) {
    for (const fn of s.listeners) fn(e)
  }

  private save(s: Live) {
    s.row.items = JSON.stringify(s.items)
    this.deps.db
      .prepare(
        'UPDATE agent_sessions SET cli_session = ?, title = ?, items = ?, updated_at = ? WHERE id = ?',
      )
      .run(s.row.cli_session, s.row.title, s.row.items, s.row.updated_at, s.row.id)
  }

  private load(id: string): Live | null {
    const cached = this.live.get(id)
    if (cached) return cached
    const row = this.deps.db
      .prepare<[string], SessionRow>('SELECT * FROM agent_sessions WHERE id = ?')
      .get(id)
    if (!row) return null
    const token = randomBytes(24).toString('hex')
    const { rooms, runs, host, assets } = this.deps
    const mcp = new McpServer(
      { name: 'plein', version: '0.1.0', instructions: '操作用户当前打开的 Plein 画布' },
      canvasTools({ canvasId: row.canvas_id, ownerId: row.owner_id, rooms, runs, host, assets }),
    )
    let items: AgentItem[] = []
    try {
      items = JSON.parse(row.items) as AgentItem[]
    } catch {}
    const s: Live = {
      row,
      items,
      child: null,
      busy: false,
      token,
      mcp,
      listeners: new Set(),
      stopped: false,
      turn: '',
    }
    this.live.set(id, s)
    this.byToken.set(token, s)
    return s
  }

  private drop(s: Live) {
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
    readonly code: 'not_found' | 'busy' | 'disabled' | 'not_installed' | 'not_ready',
    message: string,
  ) {
    super(message)
  }
}

/** 工具参数的一行摘要 */
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
