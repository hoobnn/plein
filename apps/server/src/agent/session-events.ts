import type { AgentContext, AgentEvent, AgentItem, ApplyEditPlan, EditPlan } from '@plein/protocol'
import { newId } from '../ids'
import { parseSummary } from './compaction'
import type { Approval } from './approvals'
import {
  RELEASE_AFTER_MS,
  contextOf,
  settingsOf,
  type Live,
  type SessionEnv,
} from './session-types'

/**
 * 会话的条目与事件：把一轮的产出写进内存、落库并推给界面。
 * 只依赖会话本身的状态与存储模块，不碰传输层。
 */

/** 推给界面的一帧事件 */
export function emit(s: Live, e: AgentEvent): void {
  for (const fn of s.listeners) fn(e)
}

/** 把会话当前状态写进数据库 */
export function save(env: SessionEnv, s: Live): void {
  s.row.items = JSON.stringify(s.items)
  env.store.save(s.row)
}

/** 新增或按 id 替换一项，存库并推送 */
export function push(env: SessionEnv, s: Live, item: AgentItem): void {
  const i = s.items.findIndex((x) => x.id === item.id)
  if (i >= 0) s.items[i] = item
  else s.items.push(item)
  s.row.updated_at = Date.now()
  save(env, s)
  emit(s, { type: 'item', item })
}

/** 只推给界面、不存库（流式文字的中间状态） */
export function pushLive(s: Live, item: AgentItem): void {
  const i = s.items.findIndex((x) => x.id === item.id)
  if (i >= 0) s.items[i] = item
  else s.items.push(item)
  emit(s, { type: 'item', item })
}

/** 记录一次错误 */
export function fail(env: SessionEnv, s: Live, text: string): void {
  push(env, s, { id: newId('err'), type: 'error', text, at: Date.now() })
}

/** 记录一条提示 */
export function notice(env: SessionEnv, s: Live, text: string): void {
  push(env, s, { id: newId('notice'), type: 'notice', text, at: Date.now() })
}

/** 区分正常停止与进程失败，保留工具结果的不确定性。 */
export function closeRunningTools(
  env: SessionEnv,
  s: Live,
  status: 'error' | 'stopped' = 'error',
): void {
  for (const it of s.items) {
    if (it.type === 'tool' && it.status === 'running') push(env, s, { ...it, status })
  }
}

/** 工具结束：写回结果与错误 */
export function finishTool(
  env: SessionEnv,
  s: Live,
  id: string,
  error: boolean,
  output: string | undefined,
  fallback?: { name: string; detail?: string },
): void {
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
  push(env, s, { ...base, status: error ? 'error' : 'done', output: output?.slice(0, 600) })
}

/**
 * 取走排队的消息（下一步前注入本轮）：对话里的那条去掉「已排队」，返回要追加进转录的提示词。
 */
export function takeQueued(env: SessionEnv, s: Live): string[] {
  const taken = s.queued.splice(0)
  for (const q of taken) {
    const { queued: _, ...item } = q.item
    push(env, s, item)
  }
  return taken.map((q) => q.prompt)
}

/** 一轮结束：记下改动集，前面几轮不再能撤（只能从最近一轮往回撤） */
export function finishTurn(env: SessionEnv, s: Live): void {
  s.approvals.expireAll()
  const c = s.changes.end()
  if (c) {
    push(env, s, {
      id: `chg_${s.turn}`,
      type: 'changes',
      turn: s.turn,
      ...c,
      undoable: s.changes.canUndo(s.turn),
      at: Date.now(),
    })
  }
  refreshUndoable(env, s)
}

/** 刷新每一轮还能不能撤销 */
export function refreshUndoable(env: SessionEnv, s: Live): void {
  for (const it of s.items) {
    if (it.type !== 'changes') continue
    const undoable = !it.undone && s.changes.canUndo(it.turn)
    if (undoable !== it.undoable) push(env, s, { ...it, undoable })
  }
}

/** 有人订阅或开始一轮：保留画布租约 */
export function keep(s: Live): void {
  if (s.releaseTimer) clearTimeout(s.releaseTimer)
  s.releaseTimer = null
}

/** 没人订阅且空闲时，过一段时间释放租约和撤销栈 */
export function scheduleRelease(env: SessionEnv, s: Live): void {
  if (s.listeners.size || s.busy || (!s.changes.attached && !s.driver)) return
  keep(s)
  s.releaseTimer = setTimeout(() => {
    s.releaseTimer = null
    if (s.listeners.size || s.busy) return
    // 空闲的 CLI 进程也收掉，下次发消息再用会话 id 接上
    s.driver?.close()
    s.driver = null
    s.changes.release()
    refreshUndoable(env, s)
  }, RELEASE_AFTER_MS)
  s.releaseTimer.unref?.()
}

/** 更新会话的上下文统计并推给界面 */
export function configuration(env: SessionEnv, s: Live, context: AgentContext): void {
  const summary = parseSummary(s.row.context_summary)
  const { compactedAt: _at, compactedTurns: _turns, ...rest } = context
  s.row.context = JSON.stringify({
    ...rest,
    ...(s.row.context_reset_at == null ? {} : { resetAt: s.row.context_reset_at }),
    ...(summary ? { compactedAt: summary.at, compactedTurns: summary.turns } : {}),
  })
  s.row.updated_at = Date.now()
  save(env, s)
  emit(s, { type: 'configuration', settings: settingsOf(s.row), context: contextOf(s.row) })
}

/** 运行状态变化时推给界面 */
export function setRunning(env: SessionEnv, s: Live, running: boolean): void {
  emit(s, {
    type: 'status',
    status: running ? 'running' : 'idle',
    lastTurn: env.turns.last(s.row.id),
  })
}

/** 方案卡片：出现时和方案执行完后刷新 */
export function showEditPlan(env: SessionEnv, s: Live, approvalId: string, plan: EditPlan): void {
  const record = s.active?.facts.approvals.find((a) => a.id === approvalId)
  if (record) {
    record.plan = plan
    s.active!.persist()
  }
  const a = s.approvals.get(approvalId)
  const prev = s.items.find((i) => i.id === approvalId)
  push(env, s, {
    id: approvalId,
    type: 'edit_plan',
    plan,
    status: a?.status ?? 'pending',
    ...(a?.choice ? { scope: (a.choice as ApplyEditPlan).scope } : {}),
    at: prev?.at ?? Date.now(),
  })
}

/** 方案卡片的确认单状态变了：没采用、作废时方案跟着作废 */
export function editPlanDecided(env: SessionEnv, s: Live, a: Approval): void {
  const item = s.items.find((i) => i.id === a.id)
  if (item?.type !== 'edit_plan') return
  const plans = env.deps.plans
  if (a.status === 'denied' || a.status === 'expired')
    plans?.settle(item.plan.id, s.row.owner_id, a.status)
  showEditPlan(env, s, a.id, plans?.get(item.plan.id, s.row.owner_id) ?? item.plan)
}
