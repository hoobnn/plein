import { PROPOSE_EDIT } from './edit-plan'
import { PLAN_TOOL } from './plan'
import { Approvals } from './approvals'
import { agentTools } from './tools'
import { McpServer } from './mcp'
import type { TurnExecution } from './execution'
import type { Live, SessionEnv } from './session-types'
import { editPlanDecided, push, showEditPlan } from './session-events'

/**
 * MCP 服务端构造：把画布能力包成工具，挂到这一轮的令牌上。
 * 工具与 CLI、内置智能体共用一份，确认关卡也在这一层。
 */
export function configureTurn(env: SessionEnv, s: Live, turn: TurnExecution, selection?: string[]) {
  const { rooms, runs, host, assets, library } = env.deps
  const approvals = new Approvals((a) => {
    if (s.active !== turn) return
    const prev = turn.facts.approvals.findIndex((item) => item.id === a.id)
    const item = {
      id: a.id,
      tool: a.tool,
      status: a.status,
      ...(a.choice === undefined ? {} : { choice: a.choice }),
    }
    if (prev < 0) turn.facts.approvals.push(item)
    else turn.facts.approvals[prev] = item
    turn.persist()
    if (a.tool === PLAN_TOOL) return s.plan.onApproval(a)
    if (a.tool === PROPOSE_EDIT) return editPlanDecided(env, s, a)
    push(env, s, {
      id: a.id,
      type: 'approval',
      tool: a.tool,
      reason: a.reason,
      ids: a.ids,
      ...(a.storyboardBatch ? { storyboardBatch: a.storyboardBatch } : {}),
      status: a.status,
      at: Date.now(),
    })
  })
  s.approvals = approvals
  const tools = agentTools(
    {
      canvasId: s.row.canvas_id,
      ownerId: s.row.owner_id,
      rooms,
      runs,
      host,
      assets,
      library,
      plans: env.deps.plans,
      mediaIndex: env.deps.mediaIndex,
      checkpoints: env.deps.checkpoints,
      canvasApi: env.deps.canvasApi,
      origin: s.changes.origin,
      execution: turn,
      selection: selection ? [...selection] : [],
      onRun: (nodeId, runId) => {
        turn.assertOpen()
        turn.facts.runs.push({ nodeId, runId })
        turn.persist()
        s.changes.recordRun(nodeId, runId)
      },
      onGroup: (groupId) => {
        turn.assertOpen()
        turn.facts.groups.push(groupId)
        turn.persist()
        s.changes.recordGroup(groupId)
      },
      ui: (action, ids) => {
        turn.assertOpen()
        if (!s.listeners.size) return false
        for (const fn of s.listeners) fn({ type: 'ui', action, ids })
        return true
      },
    },
    {
      changes: s.changes,
      approvals,
      mode: () => s.mode,
      plan: s.plan,
      onEditPlan: (approvalId, p) => {
        turn.assertOpen()
        const record = turn.facts.approvals.find((a) => a.id === approvalId)
        if (record) {
          record.plan = p
          turn.persist()
        }
        showEditPlan(env, s, approvalId, p)
      },
    },
  )
  s.tools = tools
  s.mcp = new McpServer(
    {
      name: 'plein',
      version: '0.2.0',
      instructions: '操作本轮绑定的 Plein 画布；轮次结束后凭据失效',
    },
    tools,
  )
}
