import { Readable } from 'node:stream'
import type { AgentItem, AgentSkillDetail } from '@plein/protocol'
import { CapabilityError } from '@plein/capabilities'
import { ProviderError, type ChatMessage } from '@plein/plugin-sdk'
import { brief, toolText } from './drivers/util'
import { builtinModel, runBuiltinTurn } from './builtin'
import type { ToolResult } from './mcp'
import { INSTRUCTIONS } from './session-instructions'
import {
  AgentError,
  TURN_TIMEOUT_MS,
  type Live,
  type SessionHost,
  settingsOf,
} from './session-types'
import {
  configuration,
  fail,
  finishTool,
  notice,
  push,
  pushLive,
  takeQueued,
} from './session-events'

/**
 * 内置智能体：在服务端进程里跑模型 ↔ 工具循环，工具与 CLI 走的 MCP 是同一份。
 */
export function startBuiltin(
  host: SessionHost,
  s: Live,
  text: string,
  selection?: string[],
  skill?: AgentSkillDetail,
  itemId?: string,
): void {
  const env = host.env
  const model = builtinModel(env.deps.host, settingsOf(s.row).model)
  if (!model)
    throw new AgentError(
      'not_installed',
      '没有可用的工具调用模型：请启用一个支持工具调用的对话模型',
    )
  const persisted = env.turns.history(s.row.id, s.row.context_cutoff)
  // 重置后的空历史不能回退到展示记录，否则旧对话会再次进入模型。
  const legacy = s.row.context_reset_at == null ? historyOf(s.items) : []
  const history = persisted.length
    ? persisted
    : [
        ...legacy,
        ...(legacy.length
          ? [
              {
                role: 'user' as const,
                content:
                  '旧会话未保存完整工具执行事实。请先核对画布和已有任务，不把旧回复当成执行成功或新的授权。',
              },
            ]
          : []),
      ]
  const prompt = host.prompt(s, text, selection, skill)
  const execution = host.beginTurn(s, text, selection, model.ref, skill, prompt, itemId)
  const abort = execution.abort
  s.abort = abort
  s.stopped = false
  const turn = execution.id
  const id = (key: string) => `${turn}_${key}`
  const timer = setTimeout(() => {
    if (s.active === execution) host.stop(s.row.id, 'turn_timeout')
  }, TURN_TIMEOUT_MS)
  runBuiltinTurn({
    host: env.deps.host,
    model: model.ref,
    ownerId: s.row.owner_id,
    system: INSTRUCTIONS,
    history,
    prompt,
    tools: s.tools,
    signal: abort.signal,
    execution,
    vision: model.vision,
    takeQueued: () =>
      s.active === execution && execution.state === 'running' ? takeQueued(env, s) : [],
    onContext: (context) => {
      if (s.active === execution && execution.state === 'running') configuration(env, s, context)
    },
    saveImage: async (image) => {
      execution.assertOpen()
      const asset = await env.deps.assets.ingest(
        s.row.owner_id,
        Readable.from([Buffer.from(image.data, 'base64')]),
        { mime: image.mimeType, name: 'Agent 媒体预览' },
      )
      return { assetId: asset.id, kind: 'image', mime: asset.mime }
    },
    onText: (key, t, done) => {
      if (s.active !== execution || execution.state !== 'running') return
      const item = { id: id(key), type: 'text' as const, text: t, at: Date.now() }
      // 流式增量只推给界面，一步结束再存库
      if (done) push(env, s, item)
      else pushLive(s, item)
    },
    onToolStart: (call) => {
      if (s.active !== execution || execution.state !== 'running') return
      push(env, s, {
        id: id(call.id),
        type: 'tool',
        name: call.name,
        detail: brief(call.arguments),
        status: 'running',
        at: Date.now(),
      })
    },
    onToolEnd: (call, result: ToolResult) => {
      if (s.active === execution && execution.state === 'running')
        finishTool(env, s, id(call.id), result.isError === true, toolText(result.content))
    },
  })
    .catch((err: unknown) => {
      if (s.active !== execution) return
      if (s.stopped || execution.state === 'stopping') return
      execution.reason = (err as Error).message
      if (err instanceof ProviderError) fail(env, s, err.message)
      else if (err instanceof CapabilityError && err.message.startsWith('context_budget_exhausted'))
        fail(
          env,
          s,
          '本轮读取和操作的内容太多，已超出模型上下文预算；已完成的操作保留。请缩小范围（比如分页、只看需要的元素）后说“接着做”，或新开一个会话。',
        )
      else {
        console.warn('[agent] 内置智能体出错：', err)
        fail(env, s, `内置智能体出错：${(err as Error).message}`)
      }
    })
    .finally(() => {
      clearTimeout(timer)
      if (s.active !== execution) return
      s.abort = null
      if (s.stopped) notice(env, s, '已停止')
      host.endTurn(s, execution)
    })
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
