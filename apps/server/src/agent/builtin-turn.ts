import { Readable } from 'node:stream'
import type { AgentItem, AgentSkillDetail } from '@plein/protocol'
import { CapabilityError } from '@plein/capabilities'
import { ProviderError, type ChatMessage } from '@plein/plugin-sdk'
import { brief, toolText } from './drivers/util'
import { builtinModel, chatTools, runBuiltinTurn } from './builtin'
import { calibrationOf } from './calibration'
import { budgetOf, type ContextBudget, outputReserve } from './context-budget'
import {
  type CompactAt,
  type ContextSummary,
  parseSummary,
  planCompaction,
  summarizeTurns,
  summaryPrompt,
} from './compaction'
import { newId } from '../ids'
import type { ToolResult } from './mcp'
import { INSTRUCTIONS } from './session-instructions'
import {
  AgentError,
  contextOf,
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
  const live = () => s.active === execution && execution.state === 'running'
  const budget = budgetOf(model)
  const compactAt = settingsOf(s.row).compactAt
  const run = async () => {
    const prepared = await prepareHistory(host, s, model.ref, abort.signal, live, budget, compactAt)
    if (!prepared || abort.signal.aborted) return
    const { history, summary } = prepared
    await runBuiltinTurn({
      host: env.deps.host,
      model: model.ref,
      ownerId: s.row.owner_id,
      system: INSTRUCTIONS,
      history,
      ...(summary ? { summary: summaryPrompt(summary) } : {}),
      prompt,
      tools: s.tools,
      signal: abort.signal,
      execution,
      vision: model.vision,
      budget,
      maxTokens: outputReserve(model),
      ...(compactAt === undefined ? {} : { compactAt }),
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
  }
  run()
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

/**
 * 本轮发给模型的历史：边界之后已结束的轮次，加上更早对话的摘要。
 * 历史过长时先把较早的轮次压缩进摘要（会话忙碌期间进行，不会与重置上下文相互覆盖）；
 * 压缩失败只记日志，本轮照常进行，由按预算省略历史兜底。
 */
async function prepareHistory(
  host: SessionHost,
  s: Live,
  model: string,
  signal: AbortSignal,
  live: () => boolean,
  budget: ContextBudget,
  compactAt: CompactAt | undefined,
): Promise<{ history: ChatMessage[]; summary?: ContextSummary } | undefined> {
  const env = host.env
  let summary = parseSummary(s.row.context_summary)
  let turns = env.turns.turns(s.row.id, s.row.context_cutoff)
  const scale = calibrationOf(model)
  const plan = planCompaction(INSTRUCTIONS, summary, turns, chatTools(s.tools), {
    budget,
    scale,
    ...(compactAt === undefined ? {} : { compactAt }),
  })
  if (plan) {
    const { older, recent } = plan
    const noticeId = newId('notice')
    const say = (text: string) =>
      push(env, s, { id: noticeId, type: 'notice', text, at: Date.now() })
    say('正在压缩较早的对话…')
    try {
      const text = await summarizeTurns({
        host: env.deps.host,
        model,
        ownerId: s.row.owner_id,
        signal,
        ...(summary ? { previous: summary } : {}),
        turns: older,
        budget,
        scale,
      })
      if (!live()) {
        say('已中止压缩较早的对话。')
        return undefined
      }
      summary = { text, at: Date.now(), turns: (summary?.turns ?? 0) + older.length }
      s.row.context_summary = JSON.stringify(summary)
      s.row.context_cutoff = older.at(-1)!.createdAt
      turns = recent
      say(`已把较早的 ${older.length} 轮对话压缩为摘要，完整记录仍保留。`)
      configuration(env, s, contextOf(s.row))
    } catch (err) {
      if (signal.aborted || !live()) {
        say('已中止压缩较早的对话。')
        return undefined
      }
      console.warn('[agent] 自动压缩上下文失败，改为按预算省略较早历史：', err)
      say('较早的对话没能压缩，本轮按预算省略部分历史；完整记录仍保留。')
    }
  }
  const persisted = turns.flatMap((t) => t.messages)
  if (persisted.length || summary || s.row.context_reset_at != null)
    return { history: persisted, ...(summary ? { summary } : {}) }
  // 没有新式记录的旧会话：退回展示记录里的文字；重置或压缩过的会话不走这里，否则旧对话会再次进入模型。
  const legacy = historyOf(s.items)
  return {
    history: legacy.length
      ? [
          ...legacy,
          {
            role: 'user',
            content:
              '旧会话未保存完整工具执行事实。请先核对画布和已有任务，不把旧回复当成执行成功或新的授权。',
          },
        ]
      : [],
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
