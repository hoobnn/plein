import {
  type CliDriver,
  type DriverHooks,
  type DriverOptions,
  MCP_NAME,
  type PermissionAsk,
  TOKEN_ENV,
} from './types'
import { brief, explain, JsonLines, toolText } from './util'

type Msg = Record<string, unknown>

/** Codex 的工具名：Plein 自己的画布工具直接用工具名，用户自己的 MCP 显示成「服务 · 工具」 */
function codexToolName(server: unknown, tool: unknown) {
  return server === MCP_NAME || !server ? String(tool) : `${server} · ${tool}`
}

/** 两档权限对应到 Codex 的审批策略和沙箱 */
function policyOf(access: DriverOptions['access']) {
  return access === 'full'
    ? { approvalPolicy: 'never', sandbox: 'danger-full-access' }
    : { approvalPolicy: 'on-request', sandbox: 'workspace-write', approvalsReviewer: 'user' }
}

const reasonOf = (...parts: unknown[]) =>
  parts
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .join('\n')
    .slice(0, 500)

/** 把 Codex 发来的服务端请求翻译成「问用户」以及允许、拒绝时的回答 */
function approvalOf(
  method: string,
  p: Msg,
): { ask: PermissionAsk; allow: unknown; deny: unknown } | null {
  switch (method) {
    case 'item/commandExecution/requestApproval':
      return {
        ask: {
          tool: 'shell',
          reason:
            reasonOf(p.reason, typeof p.command === 'string' ? `运行命令：${p.command}` : '') ||
            '运行一条命令',
        },
        allow: { decision: 'accept' },
        deny: { decision: 'decline' },
      }
    case 'item/fileChange/requestApproval':
      return {
        ask: {
          tool: '改文件',
          reason:
            reasonOf(p.reason, typeof p.grantRoot === 'string' ? `目录：${p.grantRoot}` : '') ||
            '修改文件',
        },
        allow: { decision: 'accept' },
        deny: { decision: 'decline' },
      }
    case 'item/permissions/requestApproval': {
      const want = (p.permissions ?? {}) as Msg
      const granted: Msg = {}
      if (want.network) granted.network = want.network
      if (want.fileSystem) granted.fileSystem = want.fileSystem
      const what = [want.network && '联网', want.fileSystem && '读写更多文件'].filter(Boolean)
      return {
        ask: {
          tool: '额外权限',
          reason:
            reasonOf(p.reason, what.length ? `需要：${what.join('、')}` : '') || '申请额外权限',
        },
        allow: { permissions: granted, scope: 'turn' },
        deny: { permissions: {}, scope: 'turn' },
      }
    }
    case 'mcpServer/elicitation/request': {
      // 只有「要不要允许」这种不用填表的询问能在卡片上回答，要填内容或打开网页的直接拒绝
      const schema = p.requestedSchema as { properties?: Msg } | undefined
      const plain = p.mode === 'form' && Object.keys(schema?.properties ?? {}).length === 0
      if (!plain) return null
      return {
        ask: { tool: String(p.serverName ?? 'MCP'), reason: reasonOf(p.message) || '请求确认' },
        allow: { action: 'accept', content: {}, _meta: null },
        deny: { action: 'decline', content: null, _meta: null },
      }
    }
    // 旧版接口
    case 'execCommandApproval':
      return {
        ask: {
          tool: 'shell',
          reason: reasonOf(
            p.reason,
            Array.isArray(p.command) ? `运行命令：${p.command.join(' ')}` : '',
          ),
        },
        allow: { decision: 'approved' },
        deny: { decision: { denied: { rejection: '用户没有允许这个操作' } } },
      }
    case 'applyPatchApproval':
      return {
        ask: { tool: '改文件', reason: reasonOf(p.reason) || '修改文件' },
        allow: { decision: 'approved' },
        deny: { decision: { denied: { rejection: '用户没有允许这个操作' } } },
      }
  }
  return null
}

/**
 * Codex 的长驻进程：`codex app-server`（按行 JSON-RPC）。
 * 一个会话对应一个 thread，每轮 turn/start；要权限时它发审批请求，我们在面板里问用户后回答。
 * 用户自己的 config.toml（MCP、skill、模型）照常加载，只额外挂上 Plein 的画布工具。
 */
export function startCodex(o: DriverOptions, hooks: DriverHooks): CliDriver {
  const config = [
    `mcp_servers.${MCP_NAME}.url=${JSON.stringify(o.mcpUrl)}`,
    `mcp_servers.${MCP_NAME}.bearer_token_env_var=${JSON.stringify(TOKEN_ENV)}`,
    `mcp_servers.${MCP_NAME}.tool_timeout_sec=120`,
    // 画布工具由 Plein 自己的确认关卡把关，CLI 这一层直接放行
    `mcp_servers.${MCP_NAME}.default_tools_approval_mode="approve"`,
  ].flatMap((c) => ['-c', c])

  let nextId = 1
  const calls = new Map<number, { resolve: (v: Msg) => void; reject: (e: Error) => void }>()
  const pending = new Map<string, AbortController>()
  const deltas = new Map<string, string>()
  let thread = ''
  let turnId: string | null = null
  let inTurn = false
  /** 这一轮还在等 thread/turn 建好：这期间进程退出由 send 的出错分支报告 */
  let starting = false
  let interrupted = false
  /** 这一轮已经发过 turn/interrupt */
  let interruptSent = false
  let lastError = ''

  const call = (method: string, params: unknown) =>
    new Promise<Msg>((resolve, reject) => {
      if (!proc.alive) return reject(new Error(`${o.name} 已退出`))
      const id = nextId++
      calls.set(id, { resolve, reject })
      proc.write({ id, method, params })
    })

  const error = (text: string) => {
    if (interrupted || text === lastError) return
    lastError = text
    hooks.error(text)
  }

  const endTurn = () => {
    if (!inTurn) return
    inTurn = false
    starting = false
    interrupted = false
    interruptSent = false
    turnId = null
    lastError = ''
    deltas.clear()
    for (const a of pending.values()) a.abort()
    hooks.turnEnd()
  }

  const sendInterrupt = () => {
    if (interruptSent || !thread || !turnId) return
    interruptSent = true
    call('turn/interrupt', { threadId: thread, turnId }).catch(() => {})
  }

  const onRequest = (id: unknown, method: string, params: Msg) => {
    const spec = approvalOf(method, params)
    if (!spec) {
      proc.write({ id, error: { code: -32601, message: `Plein 不支持 ${method}` } })
      return
    }
    const key = String(id)
    const abort = new AbortController()
    pending.set(key, abort)
    hooks
      .permission(spec.ask, abort.signal)
      .then((allow) => {
        if (!abort.signal.aborted) proc.write({ id, result: allow ? spec.allow : spec.deny })
      })
      .catch(() => {})
      .finally(() => pending.delete(key))
  }

  const onItem = (item: Msg, done: boolean) => {
    const id = String(item.id)
    switch (item.type) {
      case 'agentMessage':
        if (done && typeof item.text === 'string' && item.text.trim())
          hooks.text(id, item.text, true)
        return
      case 'mcpToolCall': {
        const name = codexToolName(item.server, item.tool)
        if (!done) return hooks.toolStart(id, name, brief(item.arguments))
        const result = item.result as { content?: unknown } | null
        const err = item.error as { message?: string } | null
        return hooks.toolEnd(
          id,
          item.status === 'failed' || !!err,
          err?.message ?? toolText(result?.content),
          { name, detail: brief(item.arguments) },
        )
      }
      case 'commandExecution': {
        const command = typeof item.command === 'string' ? item.command.slice(0, 200) : undefined
        if (!done) return hooks.toolStart(id, 'shell', command)
        const output = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : ''
        return hooks.toolEnd(
          id,
          item.status !== 'completed' || (typeof item.exitCode === 'number' && item.exitCode !== 0),
          item.status === 'declined' ? '用户没有允许' : output.slice(-600) || undefined,
          { name: 'shell', detail: command },
        )
      }
      case 'fileChange': {
        const changes = Array.isArray(item.changes) ? (item.changes as Msg[]) : []
        const detail =
          changes
            .map((c) => String(c.path))
            .join('，')
            .slice(0, 200) || undefined
        if (!done) return hooks.toolStart(id, '改文件', detail)
        return hooks.toolEnd(
          id,
          item.status !== 'completed',
          item.status === 'declined' ? '用户没有允许' : undefined,
          { name: '改文件', detail },
        )
      }
      case 'webSearch':
        if (!done) return
        hooks.toolStart(id, 'web_search', typeof item.query === 'string' ? item.query : undefined)
        return hooks.toolEnd(id, false)
      case 'contextCompaction':
        // 压缩后旧使用量失效，等待提供方下一次用量事件。
        if (done)
          hooks.context?.({
            source: 'unavailable',
            messages: 0,
            model: o.settings?.model,
            updatedAt: Date.now(),
          })
        return
    }
  }

  const onNotification = (method: string, p: Msg) => {
    if (typeof p.threadId === 'string' && thread && p.threadId !== thread) return
    if (typeof p.turnId === 'string' && turnId && p.turnId !== turnId) return
    switch (method) {
      case 'thread/tokenUsage/updated': {
        if (!inTurn || !turnId || p.turnId !== turnId) return
        const usage = p.tokenUsage as
          | { last?: { inputTokens?: unknown }; modelContextWindow?: unknown }
          | undefined
        const input = usage?.last?.inputTokens
        const limit = usage?.modelContextWindow
        const valid = typeof input === 'number' && Number.isFinite(input) && input >= 0
        hooks.context?.({
          source: valid ? 'provider' : 'unavailable',
          ...(valid ? { tokens: input } : {}),
          ...(typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? { limit } : {}),
          messages: 0,
          model: o.settings?.model,
          updatedAt: Date.now(),
        })
        return
      }
      case 'item/started':
      case 'item/completed':
        if (p.item && typeof p.item === 'object') onItem(p.item as Msg, method === 'item/completed')
        return
      case 'item/agentMessage/delta': {
        const id = String(p.itemId)
        const text = (deltas.get(id) ?? '') + String(p.delta ?? '')
        deltas.set(id, text)
        if (text.trim()) hooks.text(id, text, false)
        return
      }
      case 'turn/started': {
        const turn = p.turn as { id?: string } | undefined
        if (turn?.id) turnId = turn.id
        return
      }
      case 'turn/completed': {
        const turn = (p.turn ?? {}) as {
          id?: string
          status?: string
          error?: { message?: string } | null
        }
        // 上一轮迟到的结束事件
        if (turnId && turn.id && turn.id !== turnId) return
        if (turn.status === 'failed') error(turn.error?.message || `${o.name} 运行失败`)
        return endTurn()
      }
      case 'error': {
        const e = p.error as { message?: string } | undefined
        if (p.willRetry !== true && e?.message) error(e.message)
        return
      }
      case 'serverRequest/resolved':
        pending.get(String(p.requestId))?.abort()
        return
    }
  }

  const onMessage = (msg: Msg) => {
    const method = typeof msg.method === 'string' ? msg.method : null
    const params = (msg.params ?? {}) as Msg
    if (method && msg.id !== undefined) return onRequest(msg.id, method, params)
    if (method) return onNotification(method, params)
    const waiter = calls.get(Number(msg.id))
    if (!waiter) return
    calls.delete(Number(msg.id))
    const err = msg.error as { message?: string } | undefined
    if (err) waiter.reject(new Error(err.message ?? `${o.name} 出错`))
    else waiter.resolve((msg.result ?? {}) as Msg)
  }

  const proc = new JsonLines(
    o.bin,
    ['app-server', ...config],
    { cwd: o.cwd, env: o.env },
    onMessage,
    (code, stderr) => {
      const why = explain(o.name, stderr) || `${o.name} 异常退出（代码 ${code}）`
      for (const w of calls.values()) w.reject(new Error(why))
      calls.clear()
      for (const a of pending.values()) a.abort()
      // 还在建 thread / turn 时，等 send 的出错分支先报告并结束这一轮
      if (starting) return void setImmediate(() => hooks.exit())
      const reason = inTurn && !interrupted ? why : undefined
      inTurn = false
      hooks.exit(reason)
    },
  )

  const ready = (async () => {
    await call('initialize', {
      clientInfo: { name: 'plein', title: 'Plein', version: '0.1.0' },
      capabilities: null,
    })
    proc.write({ method: 'initialized' })
    const params = {
      cwd: o.cwd,
      developerInstructions: o.instructions,
      ...policyOf(o.access),
      ...(o.settings?.model ? { model: o.settings.model } : {}),
      ...(o.settings?.reasoningEffort ? { reasoningEffort: o.settings.reasoningEffort } : {}),
    }
    // 接不上（记录被清理了）就开新的 thread
    const resumed = o.resume
      ? await call('thread/resume', { threadId: o.resume, ...params }).catch(() => null)
      : null
    const r = resumed ?? (await call('thread/start', params))
    thread = String((r.thread as { id?: string } | undefined)?.id ?? '')
    if (!thread) throw new Error(`${o.name} 没有返回会话 id`)
    hooks.session(thread)
  })()
  // send 之前就失败的话，send 里会再报告
  ready.catch(() => {})

  return {
    access: o.access,
    get alive() {
      return proc.alive
    },
    send(prompt) {
      inTurn = true
      starting = true
      interrupted = false
      ready
        .then(() =>
          call('turn/start', {
            threadId: thread,
            input: [{ type: 'text', text: prompt, text_elements: [] }],
            ...(o.settings?.model ? { model: o.settings.model } : {}),
            ...(o.settings?.reasoningEffort ? { effort: o.settings.reasoningEffort } : {}),
          }),
        )
        .then((r) => {
          starting = false
          const turn = r.turn as { id?: string } | undefined
          if (turn?.id && inTurn) turnId = turn.id
          // 进程在等待期间已经退出
          if (!proc.alive) endTurn()
          // 轮次建好之前用户就点了停止
          else if (interrupted) sendInterrupt()
        })
        .catch((err: Error) => {
          starting = false
          error(err.message)
          endTurn()
          // 起不来的进程不留着，下一轮重新启动
          proc.kill()
        })
    },
    interrupt() {
      if (!inTurn) return
      interrupted = true
      for (const a of pending.values()) a.abort()
      sendInterrupt()
      // 打断没响应就结束进程，下一轮再接上这个 thread
      setTimeout(() => {
        if (inTurn && interrupted) {
          proc.kill()
          endTurn()
        }
      }, 5000).unref()
    },
    close() {
      proc.kill()
    },
  }
}
