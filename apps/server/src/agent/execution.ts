import { randomBytes } from 'node:crypto'
import type { ChatMessage } from '@plein/plugin-sdk'
import { CapabilityError } from '@plein/capabilities'
import type { ToolResult } from './mcp'

export type TurnState = 'running' | 'stopping' | 'completed' | 'failed' | 'stopped' | 'interrupted'
export interface TurnFacts {
  calls: Array<{
    id: string
    name: string
    args: unknown
    status: 'started' | 'done' | 'error' | 'outcome_unknown'
    result?: ToolResult
  }>
  approvals: Array<{ id: string; tool: string; status: string; choice?: unknown; plan?: unknown }>
  runs: Array<{ nodeId: string; runId: string }>
  groups: string[]
  requests: number
  toolCalls: number
}
export const emptyFacts = (): TurnFacts => ({
  calls: [],
  approvals: [],
  runs: [],
  groups: [],
  requests: 0,
  toolCalls: 0,
})

/** Identity is immutable. A credential and all callbacks belong to this object for its entire lifetime. */
export class TurnExecution {
  readonly token = randomBytes(24).toString('hex')
  readonly abort = new AbortController()
  readonly facts = emptyFacts()
  transcript: ChatMessage[] = []
  state: TurnState = 'running'
  reason: string | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private detached = false
  /** Set by the builtin adapter immediately before entering a tool, consumed once. */
  modelCallId: string | undefined
  constructor(
    readonly id: string,
    private current: () => boolean,
    private write: (turn: TurnExecution) => void,
  ) {}
  assertOpen = () => {
    if (!this.current() || this.state !== 'running' || this.abort.signal.aborted)
      throw new CapabilityError('turn_closed: 本轮已经停止或结束，请在新一轮重新检查')
  }
  persist() {
    if (this.detached) return
    try {
      this.write(this)
    } catch (err) {
      this.state = 'failed'
      this.abort.abort()
      throw err
    }
  }
  detach() {
    this.detached = true
  }
  append(message: ChatMessage) {
    this.transcript.push(message)
    this.persist()
  }
  close(state: TurnState, reason: string | null = null) {
    if (this.state !== 'running' && this.state !== 'stopping') return
    this.state = state
    this.reason = reason
    if (state !== 'stopping') {
      const answered = new Set(
        this.transcript.filter((m) => m.role === 'tool').map((m) => m.toolCallId),
      )
      for (const message of [...this.transcript])
        for (const call of message.toolCalls ?? [])
          if (!answered.has(call.id)) {
            const record = this.facts.calls.find((c) => c.id === call.id)
            this.transcript.push({
              role: 'tool',
              toolCallId: call.id,
              toolName: call.name,
              content: JSON.stringify({
                error: record ? 'outcome_unknown' : 'not_executed',
                message: '本轮未记录完整结果；先核对现状，不自动重发。',
              }),
            })
            answered.add(call.id)
          }
      for (const call of this.facts.calls)
        if (call.status === 'started') call.status = 'outcome_unknown'
    }
    this.abort.abort()
    this.persist()
  }
  async serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue
      .catch(() => {})
      .then(() => {
        this.assertOpen()
        return fn()
      })
    this.queue = next
    return next
  }
  async invoke(name: string, args: unknown, fn: () => Promise<ToolResult | string>) {
    this.assertOpen()
    if (this.facts.toolCalls >= 100)
      throw new CapabilityError(
        'tool_budget_exhausted: 本轮已达到 100 次工具调用，已完成的操作保留，请缩小范围后继续',
      )
    this.facts.toolCalls++
    const call: TurnFacts['calls'][number] = {
      id: this.modelCallId ?? `${this.id}:${this.facts.toolCalls}`,
      name,
      args,
      status: 'started',
    }
    this.modelCallId = undefined
    this.facts.calls.push(call)
    this.persist()
    try {
      const value = await fn()
      const result =
        typeof value === 'string' ? { content: [{ type: 'text' as const, text: value }] } : value
      call.status = result.isError ? 'error' : 'done'
      call.result = {
        ...result,
        content: result.content.map((block) =>
          block.type === 'image'
            ? { type: 'text', text: `图片内容留在本轮素材消息中（${block.mimeType}）` }
            : block,
        ),
      }
      this.persist()
      return value
    } catch (err) {
      call.status = this.abort.signal.aborted ? 'outcome_unknown' : 'error'
      call.result = { isError: true, content: [{ type: 'text', text: (err as Error).message }] }
      this.persist()
      throw err
    }
  }
}
