import type {
  AgentAccess,
  AgentApprovalMode,
  AgentEvent,
  AgentItem,
  AgentKind,
  AgentSession,
  AgentSessionSummary,
  AgentSettings,
  AgentSkill,
  AgentSkillDetail,
  ApplyEditPlan,
  ReviseEditPlan,
} from '@plein/protocol'
import { NodeRunError } from '../plugins/provider-protocol'
import { newId } from '../ids'
import { AgentChanges } from './changes'
import { type CliEnvironment, detectClis } from './cli'
import { TurnExecution } from './execution'
import { AgentPlan } from './plan'
import { TurnStore } from './turn-store'
import { AgentSkills } from './skills'
import { Approvals } from './approvals'
import { McpServer, type McpTool } from './mcp'
import { SessionStore, type SessionRow } from './session-store'
import { SessionCatalog } from './session-catalog'
import { configureTurn } from './session-mcp'
import { buildPrompt } from './session-prompt'
import { skillsCatalog, skillDetail, skillToggle } from './session-skills'
import { startCliTurn } from './cli-driver'
import { startBuiltin } from './builtin-turn'
import {
  AgentError,
  type AgentDeps,
  type Live,
  type SessionEnv,
  type SessionHost,
  MAX_QUEUED,
  contextOf,
  settingsOf,
} from './session-types'
import {
  closeRunningTools,
  configuration,
  emit,
  fail,
  finishTurn,
  keep,
  notice,
  push,
  refreshUndoable,
  scheduleRelease,
  setRunning,
  showEditPlan,
} from './session-events'

/**
 * 智能体会话：会话与回合的状态机，以及对外的会话 CRUD。
 * 传输层（CLI / 内置模型）、条目事件、MCP 构造、模型目录、提示词
 * 分别在 cli-driver.ts、builtin-turn.ts、session-events.ts、session-mcp.ts、
 * session-catalog.ts、session-prompt.ts。
 */
export class AgentSessions {
  private live = new Map<string, Live>()
  private byToken = new Map<string, { session: Live; turn: TurnExecution }>()
  private turns: TurnStore
  private store: SessionStore
  private catalog: SessionCatalog
  private skillManager: AgentSkills
  private mcpUrl = ''
  private env: SessionEnv
  /** 拆出去的模块通过它驱动会话状态机 */
  private host: SessionHost
  /** 找本机 CLI；测试里换成假的 */
  detect: (refresh?: boolean) => Promise<CliEnvironment> = detectClis

  constructor(private deps: AgentDeps) {
    this.skillManager = new AgentSkills({
      dataDir: deps.dataDir,
      host: deps.host,
      localEnabled: deps.enabled,
      detect: (refresh) => this.detect(refresh),
    })
    this.turns = new TurnStore(deps.db)
    this.turns.reconcile()
    this.store = new SessionStore(deps.db)
    this.env = { deps: this.deps, store: this.store, turns: this.turns }
    this.catalog = new SessionCatalog(this.env, (refresh) => this.detect(refresh))
    this.host = {
      env: this.env,
      // 闭包转发：mcpUrl 与 detect 都在实例上动态读取，测试替换后立即生效
      mcpUrl: () => this.mcpUrl,
      detect: (refresh) => this.detect(refresh),
      beginTurn: (s, text, selection, model, skill, prompt, itemId) =>
        this.beginTurn(s, text, selection, model, skill, prompt, itemId),
      endTurn: (s, turn) => this.endTurn(s, turn),
      prompt: (s, text, selection, skill) => this.prompt(s, text, selection, skill),
      stop: (id, reason) => this.stop(id, reason),
    }
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

  status(refresh = false) {
    return this.catalog.status(refresh)
  }

  models(agent: AgentKind, refresh = false) {
    return this.catalog.models(agent, refresh)
  }

  validateSettings(agent: AgentKind, settings: AgentSettings) {
    return this.catalog.validateSettings(agent, settings)
  }

  // ── 会话 ─────────────────────────────────────────

  list(canvasId: string, ownerId: string): AgentSessionSummary[] {
    return this.store
      .list(canvasId, ownerId)
      .map((r) => this.summary(this.live.get(r.id)?.row ?? r))
  }

  skills(ownerId: string, agent: AgentKind, refresh = false) {
    return skillsCatalog(this.skillManager, ownerId, agent, refresh)
  }

  async skill(ownerId: string, agent: AgentKind, id: string) {
    return skillDetail(this.skillManager, ownerId, agent, id)
  }

  async toggleSkill(ownerId: string, agent: AgentKind, id: string, enabled: boolean) {
    return skillToggle(this.skillManager, ownerId, agent, id, enabled)
  }

  create(
    canvasId: string,
    ownerId: string,
    agent: AgentKind,
    settings: AgentSettings = {},
  ): AgentSession {
    const now = Date.now()
    const row = {
      id: newId('agt'),
      owner_id: ownerId,
      canvas_id: canvasId,
      agent,
      cli_session: null,
      settings: JSON.stringify(settings),
      context: JSON.stringify({ source: 'unavailable', messages: 0, model: settings.model }),
      context_cutoff: null,
      context_reset_at: null,
      context_summary: null,
      title: '新对话',
      items: '[]',
      created_at: now,
      updated_at: now,
    }
    this.store.insert(row)
    return this.view(this.load(row.id)!)
  }

  get(id: string, ownerId: string): AgentSession | null {
    const s = this.load(id)
    return s && s.row.owner_id === ownerId ? this.view(s) : null
  }

  async update(id: string, ownerId: string, settings: AgentSettings): Promise<AgentSession> {
    const s = this.load(id)
    if (!s || s.row.owner_id !== ownerId) throw new AgentError('not_found', '会话不存在')
    if (s.busy) throw new AgentError('busy', '这一轮还没结束，先停止再修改模型')
    const revision = s.revision
    const previous = settingsOf(s.row)
    const resolved = await this.validateSettings(s.row.agent, settings)
    // 模型目录可能需要启动只读查询；等待期间另一条请求可能已经开始一轮。
    if (this.live.get(id) !== s) throw new AgentError('not_found', '会话不存在')
    if (s.busy || revision !== s.revision) throw new AgentError('busy', '会话配置已变化，请重试')
    s.revision++
    s.row.settings = JSON.stringify(settings)
    const rebuild =
      s.row.cli_session != null &&
      s.row.agent !== 'builtin' &&
      ((previous.model && !settings.model) ||
        (s.row.agent === 'codex' &&
          (previous.reasoningEffort || previous.model !== settings.model) &&
          !settings.reasoningEffort &&
          !resolved.reasoningEffort))
    if (rebuild) {
      s.row.cli_session = null
      s.row.context_cutoff = this.turns.cutoff(id)
      s.row.context_reset_at = Date.now()
      s.row.context_summary = null
    }
    configuration(this.env, s, {
      source: 'unavailable',
      messages: rebuild ? 0 : contextOf(s.row).messages,
      model: settings.model,
      updatedAt: Date.now(),
    })
    if (rebuild)
      notice(this.env, s, '已应用模型配置并重新开始 CLI 上下文；对话记录、画布与已有任务仍保留。')
    return this.view(s)
  }

  resetContext(id: string, ownerId: string): AgentSession {
    const s = this.load(id)
    if (!s || s.row.owner_id !== ownerId) throw new AgentError('not_found', '会话不存在')
    if (s.busy) throw new AgentError('busy', '这一轮还没结束，先重置上下文')
    s.revision++
    s.driver?.close()
    s.driver = null
    s.row.cli_session = null
    s.row.context_cutoff = this.turns.cutoff(id)
    s.row.context_reset_at = Date.now()
    s.row.context_summary = null
    configuration(this.env, s, {
      source: 'unavailable',
      messages: 0,
      model: settingsOf(s.row).model,
      updatedAt: Date.now(),
    })
    notice(this.env, s, '已重置模型上下文；对话记录、画布与已有任务仍保留。')
    return this.view(s)
  }

  delete(id: string, ownerId: string): boolean {
    const s = this.load(id)
    if (!s || s.row.owner_id !== ownerId) return false
    this.stop(id)
    this.drop(s)
    this.store.remove(id)
    return true
  }

  subscribe(id: string, fn: (e: AgentEvent) => void): () => void {
    const s = this.load(id)
    if (!s) return () => {}
    s.listeners.add(fn)
    keep(s)
    return () => {
      s.listeners.delete(fn)
      scheduleRelease(this.env, s)
    }
  }

  /** 用户允许或跳过一张确认单；允许后立即执行原调用。修改方案带上范围和逐项勾选的结果 */
  decide(id: string, ownerId: string, approvalId: string, allow: boolean, pick?: ApplyEditPlan) {
    const s = this.load(id)
    if (!s || s.row.owner_id !== ownerId) throw new AgentError('not_found', '会话不存在')
    if (!s.active || s.active.state !== 'running')
      throw new AgentError('not_undoable', '本轮已经结束，确认单已过期')
    if (!s.approvals.decide(approvalId, allow, pick))
      throw new AgentError('not_undoable', '这个确认已经处理过或过期了')
  }

  /** 逐项编辑方案卡片：按用户改过的字段重新检查方案，卡片换成新方案，确认单不变 */
  async revisePlan(
    id: string,
    ownerId: string,
    approvalId: string,
    edits: ReviseEditPlan['edits'],
  ) {
    const s = this.load(id)
    if (!s || s.row.owner_id !== ownerId) throw new AgentError('not_found', '会话不存在')
    const item = s.items.find((i) => i.id === approvalId)
    const plans = this.deps.plans
    if (item?.type !== 'edit_plan' || !plans) throw new AgentError('not_found', '方案不存在')
    if (s.approvals.get(approvalId)?.status !== 'pending')
      throw new AgentError('not_undoable', '这个方案已经处理过或过期了')
    try {
      const plan = await plans.revise(item.plan.id, ownerId, edits)
      showEditPlan(this.env, s, approvalId, plan)
      return plan
    } catch (err) {
      if (!(err instanceof NodeRunError)) throw err
      throw new AgentError(
        err.code === 'not_found' || err.code === 'busy' ? err.code : 'invalid_input',
        err.message,
      )
    }
  }

  /** 撤销某一轮对画布的改动（只能从最近一轮往回撤） */
  undoTurn(id: string, ownerId: string, turn: string) {
    const s = this.load(id)
    if (!s || s.row.owner_id !== ownerId) throw new AgentError('not_found', '会话不存在')
    if (s.busy) throw new AgentError('busy', '这一轮还没结束，先停止再撤销')
    if (!s.changes.undoTurn(turn))
      throw new AgentError('not_undoable', '这一轮的改动已经不能撤销了')
    const item = s.items.find((i) => i.type === 'changes' && i.turn === turn)
    if (item?.type === 'changes') push(this.env, s, { ...item, undone: true, undoable: false })
    refreshUndoable(this.env, s)
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
    skillId?: string,
  ) {
    const s = this.load(id)
    if (!s || s.row.owner_id !== ownerId) throw new AgentError('not_found', '会话不存在')
    if (s.busy) {
      // 内置智能体运行中：消息排队，下一步（或下一轮）再交给模型；CLI 驱动仍要等这一轮结束
      if (s.row.agent === 'builtin' && s.active?.state === 'running' && s.abort) {
        if (skillId) throw new AgentError('invalid_input', '运行中不能为排队的消息指定技能')
        return this.enqueue(s, text, selection)
      }
      throw new AgentError('busy', '上一条消息还在处理中')
    }
    if (!this.deps.enabled && s.row.agent !== 'builtin')
      throw new AgentError('disabled', '本机智能体未启用')
    s.busy = true
    const revision = ++s.revision
    let dispatched: TurnExecution | null = null
    const assertPending = () => {
      if (this.live.get(id) !== s) throw new AgentError('not_found', '会话不存在')
      if (revision !== s.revision) throw new AgentError('busy', '本次发送已取消，请重新发送')
    }
    try {
      // 在任何目录/模型查询之前复制选区；其他客户端的选区和调用方的数组变动不影响本轮。
      const selected = selection
        ? this.deps.rooms.withDoc(s.row.canvas_id, (doc) =>
            [...selection].filter((nodeId) => !!doc.get(nodeId)),
          )
        : undefined
      const settings = await this.validateSettings(s.row.agent, settingsOf(s.row))
      assertPending()
      let skill: AgentSkillDetail | undefined
      if (skillId) {
        skill = await this.skillManager.resolve(ownerId, s.row.agent, skillId, selected ?? [])
      }
      assertPending()
      s.mode = mode
      s.plan.begin(plan)
      if (s.row.agent === 'builtin') {
        startBuiltin(this.host, s, text, selected, skill)
        dispatched = s.active
      } else {
        const started = startCliTurn(this.host, s, text, selected, access, settings, skill)
        dispatched = s.active
        await started
      }
    } catch (err) {
      if (this.live.get(id) !== s || revision !== s.revision) throw err
      dispatched ??= s.active
      if (dispatched && s.active === dispatched) {
        fail(this.env, s, (err as Error).message)
        dispatched.close('failed', (err as Error).message)
        this.endTurn(s, dispatched)
      } else if (!s.active) s.busy = false
      throw err
    }
  }

  /** 把运行中收到的消息排进队列：对话里先显示为「已排队」 */
  private enqueue(s: Live, text: string, selection?: string[]) {
    if (s.queued.length >= MAX_QUEUED)
      throw new AgentError('busy', `排队的消息已有 ${MAX_QUEUED} 条，等小满处理后再发`)
    const selected = selection
      ? this.deps.rooms.withDoc(s.row.canvas_id, (doc) =>
          [...selection].filter((nodeId) => !!doc.get(nodeId)),
        )
      : undefined
    const item = {
      id: newId('it'),
      type: 'user' as const,
      text,
      ...(selected?.length ? { selection: selected } : {}),
      queued: true,
      at: Date.now(),
    }
    s.queued.push({ item, prompt: this.prompt(s, text, selected), selection: selected })
    push(this.env, s, item)
  }

  /** 一轮正常结束后，排队里还剩的消息接着作为下一轮；其余结局丢弃并告知 */
  private flushQueued(s: Live, turn: TurnExecution) {
    if (!s.queued.length) return
    if (turn.state !== 'completed') {
      const dropped = s.queued.splice(0)
      const ids = new Set(dropped.map((q) => q.item.id))
      s.items = s.items.filter((i) => !ids.has(i.id))
      notice(
        this.env,
        s,
        `本轮没有正常结束，${dropped.length} 条排队的消息已取消，需要的话请重新发送。`,
      )
      emit(s, { type: 'session', session: this.view(s) })
      return
    }
    const next = s.queued.shift()!
    s.busy = true
    s.revision++
    try {
      startBuiltin(this.host, s, next.item.text, next.selection, undefined, next.item.id)
    } catch (err) {
      if (!s.active) s.busy = false
      s.queued.length = 0
      s.items = s.items.filter((i) => !(i.type === 'user' && i.queued))
      fail(this.env, s, (err as Error).message)
      emit(s, { type: 'session', session: this.view(s) })
    }
  }

  stop(id: string, reason = 'user_stopped') {
    const s = this.live.get(id)
    const turn = s?.active
    if (!s) return
    if (!turn) {
      if (s.busy) {
        s.revision++
        s.busy = false
        notice(this.env, s, '已停止')
        setRunning(this.env, s, false)
      }
      return
    }
    turn.close('stopping', reason)
    this.byToken.delete(turn.token)
    s.approvals.expireAll()
    if (!s.abort && !s.driver) {
      s.stopped = true
      notice(this.env, s, '已停止')
      this.endTurn(s, turn)
      return
    }
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
      s.revision++
      s.abort?.abort()
      s.stopped = true
      s.driver?.close()
      if (s.active) {
        const turn = s.active
        this.byToken.delete(turn.token)
        turn.close('interrupted', 'server_shutdown')
        s.approvals.expireAll()
        closeRunningTools(this.env, s, 'stopped')
        finishTurn(this.env, s)
        turn.detach()
        s.active = null
      }
      if (s.turnTimer) clearTimeout(s.turnTimer)
      s.turnTimer = null
      s.driver = null
      s.abort = null
      s.busy = false
      s.changes.release()
    }
  }

  // ── MCP ──────────────────────────────────────────

  /** 智能体调用画布工具的入口；令牌对应到会话所在的画布和用户 */
  async handleMcp(token: string, body: unknown) {
    const binding = this.byToken.get(token)
    if (!binding || binding.session.active !== binding.turn || binding.turn.state !== 'running')
      return undefined
    return binding.session.mcp.handle(body)
  }

  // ── 回合 ─────────────────────────────────────────

  /** 开始一轮：挂上撤销栈、记下用户消息、通知界面在跑 */
  private beginTurn(
    s: Live,
    text: string,
    selection?: string[],
    model?: string,
    skill?: AgentSkill,
    prompt?: string,
    itemId?: string,
  ) {
    keep(s)
    const turn = new TurnExecution(
      newId('turn'),
      () => s.active === turn,
      (t) => this.turns.save(t),
    )
    s.active = turn
    this.turns.begin(s.row.id, turn, model)
    s.turn = turn.id
    s.token = turn.token
    configureTurn(this.env, s, turn, selection)
    this.byToken.set(turn.token, { session: s, turn })
    s.changes.begin(s.turn)
    if (s.items.length === 0) s.row.title = text.replace(/\s+/g, ' ').slice(0, 40)
    push(this.env, s, {
      id: itemId ?? newId('it'),
      type: 'user',
      text,
      selection,
      ...(skill
        ? { skill: { id: skill.id, name: skill.name, title: skill.title, source: skill.source } }
        : {}),
      at: Date.now(),
    })
    turn.append({ role: 'user', content: prompt ?? this.prompt(s, text, selection) })
    setRunning(this.env, s, true)
    const context = contextOf(s.row)
    configuration(this.env, s, {
      source: 'unavailable',
      messages: context.messages + 1,
      model: model ?? settingsOf(s.row).model,
      updatedAt: Date.now(),
    })
    return turn
  }

  /** 一轮结束（不论成败）：收尾工具、改动集、状态和租约 */
  private endTurn(s: Live, turn: TurnExecution) {
    if (s.active !== turn) return
    this.byToken.delete(turn.token)
    const driver = s.driver
    s.driver = null
    turn.close(
      s.stopped || turn.state === 'stopping' ? 'stopped' : turn.reason ? 'failed' : 'completed',
      turn.reason,
    )
    driver?.close()
    s.busy = false
    if (s.turnTimer) clearTimeout(s.turnTimer)
    s.turnTimer = null
    closeRunningTools(this.env, s, turn.state === 'stopped' ? 'stopped' : 'error')
    finishTurn(this.env, s)
    s.active = null
    setRunning(this.env, s, false)
    scheduleRelease(this.env, s)
    this.flushQueued(s, turn)
  }

  private prompt(s: Live, text: string, selection?: string[], skill?: AgentSkillDetail) {
    return buildPrompt(this.env, s, text, selection, skill)
  }

  // ── 内部 ─────────────────────────────────────────

  private load(id: string): Live | null {
    const cached = this.live.get(id)
    if (cached) return cached
    const row = this.store.find(id)
    if (!row) return null
    const { rooms, runs } = this.deps
    let s!: Live
    const changes = new AgentChanges(row.id, row.canvas_id, row.owner_id, rooms, runs, (ids) =>
      emit(s, { type: 'touch', ids }),
    )
    const plan = new AgentPlan((item) => push(this.env, s, item))
    // History loading cannot grant executable tools or credentials.
    const approvals = new Approvals(() => {})
    const tools: McpTool[] = []
    const mcp = new McpServer({ name: 'plein', version: '0.2.0' }, tools)
    let items: AgentItem[] = []
    try {
      items = JSON.parse(row.items) as AgentItem[]
    } catch {}
    // 撤销栈只在内存里：重新加载的会话，之前的改动都不能再撤销
    // 排队中的消息没有随进程保留，重新加载时去掉
    items = items.filter((it) => !(it.type === 'user' && it.queued))
    items = items.map((it) =>
      it.type === 'tool' && it.status === 'running'
        ? {
            ...it,
            status: 'error',
            output: '对话被中断，执行结果需要核对；已有生成任务仍由任务系统管理',
          }
        : it.type === 'changes' && it.undoable
          ? { ...it, undoable: false }
          : (it.type === 'approval' || it.type === 'plan' || it.type === 'edit_plan') &&
              it.status === 'pending'
            ? { ...it, status: 'expired' }
            : it,
    )
    s = {
      revision: 0,
      active: null,
      row,
      items,
      driver: null,
      busy: false,
      turnTimer: null,
      token: '',
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
      queued: [],
    }
    this.live.set(id, s)
    return s
  }

  private drop(s: Live) {
    s.revision++
    keep(s)
    s.driver?.close()
    s.driver = null
    s.changes.release()
    this.live.delete(s.row.id)
    this.byToken.delete(s.token)
    s.active?.detach()
    s.active = null
    if (s.turnTimer) clearTimeout(s.turnTimer)
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
      lastTurn: this.turns.last(row.id),
      settings: settingsOf(row),
      context: contextOf(row),
    }
  }

  private view(s: Live): AgentSession {
    return { ...this.summary(s.row), items: s.items }
  }
}
