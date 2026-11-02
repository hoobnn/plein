import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentAccess, AgentSettings, AgentSkillDetail } from '@plein/protocol'
import type { ResolvedCli } from './cli'
import { startClaude } from './drivers/claude'
import { startCodex } from './drivers/codex'
import { type CliDriver, type PermissionAsk, TOKEN_ENV } from './drivers/types'
import { childEnv } from './drivers/util'
import { INSTRUCTIONS } from './session-instructions'
import {
  AgentError,
  TURN_TIMEOUT_MS,
  contextOf,
  type Live,
  type SessionHost,
} from './session-types'
import { configuration, fail, finishTool, notice, push, pushLive } from './session-events'

/**
 * CLI 传输：起一个长驻 CLI 进程，把它的事件落到这个会话里。
 * 只负责传输层，回合状态机由 SessionHost 提供。
 */

/** CLI 要做需要点头的事：在面板里出一张确认卡片，等用户允许或拒绝 */
export async function askPermission(
  s: Live,
  turn: { assertOpen(): void; state: string },
  ask: PermissionAsk,
  signal: AbortSignal,
): Promise<boolean> {
  turn.assertOpen()
  const approvals = s.approvals
  const a = approvals.create(ask.tool, { reason: ask.reason, ids: [] }, async () => {
    turn.assertOpen()
    return true
  })
  const expire = () => approvals.expire(a.id)
  if (signal.aborted) expire()
  signal.addEventListener('abort', expire, { once: true })
  while (a.status === 'pending') await approvals.wait(a.id, 600)
  signal.removeEventListener('abort', expire)
  return a.status === 'approved' && s.active === turn && turn.state === 'running'
}

/** 发一条消息到本机 CLI：先起回合，再把驱动接到回合上 */
export async function startCliTurn(
  host: SessionHost,
  s: Live,
  text: string,
  selection: string[] | undefined,
  access: AgentAccess,
  settings: AgentSettings,
  skill?: AgentSkillDetail,
): Promise<void> {
  const prompt = host.prompt(s, text, selection, skill)
  const turn = host.beginTurn(s, text, selection, settings.model, skill, prompt)
  const env = await host.detect()
  turn.assertOpen()
  const cli = env.agents.find((a) => a.id === s.row.agent)
  if (!cli?.path) throw new AgentError('not_installed', `本机没有找到 ${cli?.name ?? s.row.agent}`)
  if (!host.mcpUrl()) throw new AgentError('not_ready', '服务端还没准备好')
  // 权限档变了要带新参数重启（之后用 CLI 的会话 id 接上）
  if (s.driver && (!s.driver.alive || s.driver.access !== access)) {
    s.driver.close()
    s.driver = null
  }
  s.stopped = false
  s.driver = startDriver(host, s, turn, cli, env.path, access, settings, skill)
  s.turnTimer = setTimeout(() => {
    if (s.active === turn) host.stop(s.row.id, 'turn_timeout')
  }, TURN_TIMEOUT_MS)
  s.driver.send(prompt)
}

/** 起一个长驻 CLI 进程，把它的事件落到这个会话里 */
export function startDriver(
  host: SessionHost,
  s: Live,
  turn: Live['active'] & object,
  cli: ResolvedCli,
  path: string,
  access: AgentAccess,
  settings: AgentSettings,
  skill?: AgentSkillDetail,
): CliDriver {
  // 所有会话共用一个工作目录：Claude Code 按目录归档会话，分开会在它的项目列表里留下一堆记录
  const workdir = join(host.env.deps.dataDir, 'agent')
  mkdirSync(workdir, { recursive: true })
  let driver!: CliDriver
  const mine = () => s.active === turn && s.driver === driver
  const tid = (id: string) => `${turn.id}_${id}`
  const start = cli.id === 'claude' ? startClaude : startCodex
  driver = start(
    {
      bin: cli.path!,
      name: cli.name,
      cwd: workdir,
      env: childEnv({ ...process.env, PATH: path, [TOKEN_ENV]: turn.token }, [TOKEN_ENV]),
      resume: s.row.cli_session,
      access,
      mcpUrl: host.mcpUrl(),
      token: turn.token,
      instructions: INSTRUCTIONS,
      settings,
      ...(skill?.source === 'codex' && skill.path
        ? { skill: { name: skill.name, path: skill.path } }
        : {}),
    },
    {
      session: (id) => {
        if (!mine() || id === s.row.cli_session) return
        s.row.cli_session = id
        host.env.store.save({ ...s.row, items: JSON.stringify(s.items) })
      },
      text: (id, text, done) => {
        if (!mine() || !s.busy) return
        const item = { id: tid(id), type: 'text' as const, text, at: Date.now() }
        // 流式增量只推给界面，一段结束再存库
        if (done) {
          turn.append({ role: 'assistant', content: text })
          push(host.env, s, item)
        } else pushLive(s, item)
      },
      toolStart: (id, name, detail) => {
        if (!mine() || !s.busy) return
        push(host.env, s, {
          id: tid(id),
          type: 'tool',
          name,
          detail,
          status: 'running',
          at: Date.now(),
        })
      },
      toolEnd: (id, error, output, fallback) => {
        if (mine() && s.busy && !s.stopped)
          finishTool(host.env, s, tid(id), error, output, fallback)
      },
      error: (text) => {
        if (mine() && s.busy && !s.stopped) {
          turn.reason = text
          fail(host.env, s, text)
        }
      },
      turnEnd: () => {
        if (!mine() || !s.busy) return
        if (s.stopped) notice(host.env, s, '已停止')
        host.endTurn(s, turn)
      },
      exit: (reason) => {
        if (!mine()) return
        s.driver = null
        if (!s.busy) return
        if (s.stopped) notice(host.env, s, '已停止')
        else {
          fail(host.env, s, reason ?? `${cli.name} 已退出`)
          turn.reason = reason ?? 'cli_exited'
        }
        host.endTurn(s, turn)
      },
      permission: (ask, signal) => askPermission(s, turn, ask, signal),
      context: (context) => {
        if (mine() && s.busy && turn.state === 'running')
          configuration(host.env, s, { ...context, messages: contextOf(s.row).messages })
      },
    },
  )
  return driver
}
