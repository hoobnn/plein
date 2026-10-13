import { newId } from '../../ids'
import {
  type CliDriver,
  type DriverHooks,
  type DriverOptions,
  MCP_NAME,
  type PermissionAsk,
} from './types'
import { brief, explain, JsonLines, toolText } from './util'

const TOOL_PREFIX = `mcp__${MCP_NAME}__`

/** 用户自己装的 MCP 工具 mcp__<服务>__<工具> 显示成「服务 · 工具」 */
export function claudeToolName(name: string) {
  if (name.startsWith(TOOL_PREFIX)) return name.slice(TOOL_PREFIX.length)
  const m = /^mcp__(.+?)__(.+)$/.exec(name)
  return m ? `${m[1]} · ${m[2]}` : name
}

/** 权限请求的一句话说明 */
function askOf(req: Record<string, unknown>): PermissionAsk {
  const tool = claudeToolName(String(req.tool_name ?? 'tool'))
  const input = (req.input ?? {}) as Record<string, unknown>
  const said = [req.title, req.description].find(
    (v): v is string => typeof v === 'string' && v.trim().length > 0,
  )
  const what =
    typeof input.command === 'string'
      ? `运行命令：${input.command}`
      : typeof input.file_path === 'string'
        ? `${tool}：${input.file_path}`
        : (brief(input) ?? '')
  return { tool, reason: [said, what].filter(Boolean).join('\n').slice(0, 500) || `使用 ${tool}` }
}

/**
 * Claude Code 的长驻进程：`claude -p --input-format stream-json --output-format stream-json`。
 * 每一轮往 stdin 写一条用户消息；它要权限时（--permission-prompt-tool stdio）发 can_use_tool 控制请求，
 * 我们在面板里问用户后回答。用户自己的 MCP、skill、CLAUDE.md 照常加载。
 */
export function startClaude(o: DriverOptions, hooks: DriverHooks): CliDriver {
  const mcp = {
    mcpServers: {
      [MCP_NAME]: { type: 'http', url: o.mcpUrl, headers: { Authorization: `Bearer ${o.token}` } },
    },
  }
  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--mcp-config',
    JSON.stringify(mcp),
    // 画布工具由 Plein 自己的确认关卡把关，CLI 这一层直接放行
    '--allowedTools',
    `mcp__${MCP_NAME}`,
    '--append-system-prompt',
    o.instructions,
    ...(o.access === 'full'
      ? ['--dangerously-skip-permissions']
      : ['--permission-prompt-tool', 'stdio']),
    ...(o.resume ? ['--resume', o.resume] : []),
  ]

  let inTurn = false
  let interrupted = false
  const pending = new Map<string, AbortController>()

  const respond = (requestId: string, response: Record<string, unknown>) =>
    proc.write({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response },
    })

  const onControl = (requestId: string, req: Record<string, unknown>) => {
    if (req.subtype !== 'can_use_tool') {
      proc.write({
        type: 'control_response',
        response: { subtype: 'error', request_id: requestId, error: '不支持的请求' },
      })
      return
    }
    const abort = new AbortController()
    pending.set(requestId, abort)
    hooks
      .permission(askOf(req), abort.signal)
      .then((allow) => {
        if (abort.signal.aborted) return
        respond(
          requestId,
          allow
            ? { behavior: 'allow', updatedInput: req.input ?? {} }
            : { behavior: 'deny', message: '用户没有允许这个操作' },
        )
      })
      .catch(() => {})
      .finally(() => pending.delete(requestId))
  }

  const onMessage = (ev: Record<string, unknown>) => {
    if (typeof ev.session_id === 'string') hooks.session(ev.session_id)
    if (ev.type === 'control_request') {
      return onControl(String(ev.request_id), (ev.request ?? {}) as Record<string, unknown>)
    }
    if (ev.type === 'control_cancel_request') {
      pending.get(String(ev.request_id))?.abort()
      return
    }
    const message = ev.message as { id?: string; content?: unknown } | undefined
    const blocks = Array.isArray(message?.content)
      ? (message.content as Array<Record<string, unknown>>)
      : []
    if (ev.type === 'assistant') {
      blocks.forEach((b, i) => {
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          hooks.text(`${message?.id ?? newId('m')}_${i}`, b.text, true)
        } else if (b.type === 'tool_use') {
          hooks.toolStart(String(b.id), claudeToolName(String(b.name)), brief(b.input))
        }
      })
    } else if (ev.type === 'user') {
      for (const b of blocks) {
        if (b.type !== 'tool_result') continue
        hooks.toolEnd(String(b.tool_use_id), b.is_error === true, toolText(b.content))
      }
    } else if (ev.type === 'result') {
      const failed =
        ev.is_error === true || (typeof ev.subtype === 'string' && ev.subtype !== 'success')
      if (failed && !interrupted) {
        hooks.error(typeof ev.result === 'string' && ev.result ? ev.result : String(ev.subtype))
      }
      inTurn = false
      interrupted = false
      hooks.turnEnd()
    }
  }

  const proc = new JsonLines(o.bin, args, { cwd: o.cwd, env: o.env }, onMessage, (code, stderr) => {
    for (const a of pending.values()) a.abort()
    const reason =
      inTurn && !interrupted
        ? explain(o.name, stderr) || `${o.name} 异常退出（代码 ${code}）`
        : undefined
    inTurn = false
    hooks.exit(reason)
  })

  return {
    access: o.access,
    get alive() {
      return proc.alive
    },
    send(prompt) {
      inTurn = true
      interrupted = false
      proc.write({
        type: 'user',
        message: { role: 'user', content: prompt },
        parent_tool_use_id: null,
      })
    },
    interrupt() {
      if (!inTurn) return
      interrupted = true
      for (const a of pending.values()) a.abort()
      proc.write({
        type: 'control_request',
        request_id: newId('int'),
        request: { subtype: 'interrupt' },
      })
      // 打断没响应就结束进程，下一轮再用 --resume 接上
      setTimeout(() => {
        if (inTurn && interrupted) proc.kill()
      }, 5000).unref()
    },
    close() {
      proc.kill()
    },
  }
}
