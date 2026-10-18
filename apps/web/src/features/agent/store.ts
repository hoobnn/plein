import {
  API,
  type AgentAccess,
  type AgentApprovalMode,
  type AgentEvent,
  type AgentKind,
  type AgentSession,
  type AgentSessionSummary,
  type AgentStatus,
  type ApplyEditPlan,
  type ReviseEditPlan,
} from '@plein/protocol'
import { create } from 'zustand'
import { api } from '../../api/client'
import { useCanvas } from '../../stores/canvas'

/** 吉祥物的心情：跟着智能体的状态走 */
export type Mood = 'idle' | 'working' | 'happy' | 'sad'

const AGENT_KEY = 'plein:agent'
const APPROVAL_KEY = 'plein:agent-approval'
const PLAN_KEY = 'plein:agent-plan'
const ACCESS_KEY = 'plein:agent-access'

interface AgentStore {
  open: boolean
  /** 本次应用会话内按画布保留；关闭面板不丢失，不跨画布显示。 */
  drafts: Record<string, { text: string }>
  excludedSelections: Record<string, string>
  setExcludedSelection(canvasId: string, signature?: string): void
  sending: Record<string, boolean>
  selecting: string | null
  removing: Record<string, boolean>
  pendingActions: Record<string, boolean>
  setDraft(canvasId: string, text: string): void
  status: AgentStatus | null
  /** 新建对话用的 CLI，记在本机 */
  agent: AgentKind
  /** 花钱、删东西前要不要先问，记在本机 */
  approval: AgentApprovalMode
  /** 计划模式：先列计划，同意后才动手，记在本机 */
  plan: boolean
  /** 本机 CLI 能不能不问就改文件、跑命令 */
  access: AgentAccess
  canvasId: string | null
  sessions: AgentSessionSummary[]
  /** 本次应用会话内已确认删除的 ID，防止迟到列表快照恢复它们。 */
  deletedSessions: Record<string, true>
  loadingHistory: boolean
  historyError: string | null
  selectionError: { id: string; message: string } | null
  connectionError: string | null
  reconnecting: boolean
  reconnect(): void
  session: AgentSession | null
  /** 面板关着时有新回复 */
  unread: boolean
  mood: Mood
  /** 小满刚改过的元素：画布上的 AI 光标飘过去 */
  cursor: { ids: string[]; at: number } | null
  error: string | null
  toggle(open?: boolean): void
  /** 输入框要抢焦点的次数：「让小满处理」打开面板时加一 */
  focusSeq: number
  /** 打开面板并把光标放进输入框（带上当前选区） */
  ask(): void
  loadStatus(refresh?: boolean): Promise<void>
  setAgent(agent: AgentKind): void
  setApproval(mode: AgentApprovalMode): void
  setPlan(plan: boolean): void
  setAccess(access: AgentAccess): void
  /** 允许或跳过一张确认单；修改方案允许时带上批准范围 */
  decide(approvalId: string, allow: boolean, pick?: ApplyEditPlan): Promise<void>
  /** 逐项编辑方案：成功返回 null，失败返回原因，上下文变化返回 undefined 并忽略旧结果。 */
  revisePlan(approvalId: string, edits: ReviseEditPlan['edits']): Promise<string | null | undefined>
  /** 切换到某块画布（null 表示不在画布里）：读它的会话，接上最近一个 */
  enter(canvasId: string | null, retry?: boolean): Promise<void>
  select(id: string): Promise<void>
  /** 放弃失败的历史切换，明确继续原会话。 */
  cancelSelection(): void
  /** 开一个空白对话（发第一条消息时才真正创建） */
  reset(): void
  send(text: string, selection?: string[]): Promise<void>
  stop(): Promise<void>
  /** 撤销某一轮对画布的改动 */
  undoTurn(turn: string): Promise<void>
  remove(id: string): Promise<void>
}

let source: EventSource | null = null
/** 每次进入画布、切换会话都加一，晚到的应答对不上就丢掉 */
let selectSeq = 0
let moodTimer: ReturnType<typeof setTimeout> | undefined

function savedApproval(): AgentApprovalMode {
  try {
    const v = localStorage.getItem(APPROVAL_KEY)
    return v === 'always' || v === 'auto' ? v : 'rules'
  } catch {
    return 'rules'
  }
}

function savedAccess(): AgentAccess {
  try {
    return localStorage.getItem(ACCESS_KEY) === 'full' ? 'full' : 'auto'
  } catch {
    return 'auto'
  }
}

function savedFlag(key: string) {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

/** 记住的智能体；没记过时用内置的（不用装 CLI），状态读回来后不可用再换 */
function savedAgent(): AgentKind {
  try {
    const v = localStorage.getItem(AGENT_KEY)
    return v === 'claude' || v === 'codex' ? v : 'builtin'
  } catch {
    return 'builtin'
  }
}

export const useAgent = create<AgentStore>((set, get) => {
  const completeFeedback = (session: AgentSession, turn: AgentSession['lastTurn']) => {
    const state = turn?.state
    const failed = state ? state === 'failed' : session.items.at(-1)?.type === 'error'
    set({
      mood: state === 'stopped' || state === 'interrupted' ? 'idle' : failed ? 'sad' : 'happy',
      unread: !get().open,
    })
    clearTimeout(moodTimer)
    moodTimer = setTimeout(() => set({ mood: 'idle' }), 4000)
    void refreshList()
  }

  /** 订阅会话事件流；同一时间只连一个会话 */
  const connect = (id: string | null, reconnecting = false) => {
    source?.close()
    source = null
    set({ connectionError: null, reconnecting: !!id && reconnecting })
    if (!id) return
    const es = new EventSource(API.agentEvents(id))
    source = es
    es.onerror = () => {
      // 浏览器会自动重连；连接彻底关闭时才算断开
      if (source === es && es.readyState === EventSource.CLOSED)
        set({ connectionError: '与对话的连接已断开，请重新连接。', reconnecting: false })
    }
    es.onmessage = (msg) => {
      if (source !== es) return
      let e: AgentEvent
      try {
        e = JSON.parse(msg.data) as AgentEvent
      } catch {
        return
      }
      const cur = get().session
      if (e.type === 'session') {
        clearTimeout(moodTimer)
        set({
          session: e.session,
          mood: e.session.status === 'running' ? 'working' : 'idle',
          connectionError: null,
          reconnecting: false,
        })
        if (cur?.id === e.session.id && cur.status === 'running' && e.session.status === 'idle')
          completeFeedback(e.session, e.session.lastTurn)
        return
      }
      if (!cur || cur.id !== id) return
      if (e.type === 'ui') {
        const engine = get().canvasId === cur.canvasId ? useCanvas.getState().engine : null
        if (!engine) return
        if (e.action === 'select') engine.selection.set(e.ids)
        else engine.flyTo(e.ids)
        return
      }
      if (e.type === 'touch') {
        // 智能体刚改过的元素在画布上闪一下光晕
        if (get().canvasId !== cur.canvasId) return
        useCanvas.getState().engine?.flash(e.ids)
        set({ cursor: { ids: e.ids, at: Date.now() } })
        return
      }
      if (e.type === 'item') {
        const items = [...cur.items]
        const i = items.findIndex((x) => x.id === e.item.id)
        if (i >= 0) items[i] = e.item
        else items.push(e.item)
        set({ session: { ...cur, items, updatedAt: Date.now() } })
      } else if (e.type === 'status') {
        const wasRunning = cur.status === 'running'
        const next = { ...cur, status: e.status, lastTurn: e.lastTurn ?? cur.lastTurn }
        set({ session: next })
        if (e.status === 'running') {
          clearTimeout(moodTimer)
          set({ mood: 'working' })
        } else if (wasRunning) completeFeedback(next, e.lastTurn)
      }
    }
  }

  const refreshList = async () => {
    const canvasId = get().canvasId
    if (!canvasId) return
    try {
      const sessions = await api.agentSessions(canvasId)
      if (get().canvasId === canvasId)
        set({ sessions: sessions.filter((s) => !get().deletedSessions[s.id]) })
    } catch {}
  }

  const sessionAction = async (name: string, run: (id: string) => Promise<void>) => {
    const id = get().session?.id
    if (!id || get().selecting || get().selectionError) return
    const key = `${id}/${name}`
    if (get().pendingActions[key]) return
    const mine = selectSeq
    set({ error: null, pendingActions: { ...get().pendingActions, [key]: true } })
    try {
      await run(id)
    } catch (err) {
      if (mine === selectSeq && get().session?.id === id) set({ error: (err as Error).message })
    } finally {
      const pendingActions = { ...get().pendingActions }
      delete pendingActions[key]
      set({ pendingActions })
    }
  }

  return {
    open: false,
    drafts: {},
    excludedSelections: {},
    deletedSessions: {},
    loadingHistory: false,
    historyError: null,
    selectionError: null,
    connectionError: null,
    reconnecting: false,
    reconnect() {
      const { session, connectionError, reconnecting, selecting } = get()
      if (!session || !connectionError || reconnecting || selecting) return
      connect(session.id, true)
    },
    setExcludedSelection(canvasId, signature) {
      if (get().excludedSelections[canvasId] === signature) return
      const excludedSelections = { ...get().excludedSelections }
      if (signature === undefined) delete excludedSelections[canvasId]
      else excludedSelections[canvasId] = signature
      set({ excludedSelections })
    },
    sending: {},
    selecting: null,
    removing: {},
    pendingActions: {},
    setDraft(canvasId, text) {
      const drafts = { ...get().drafts }
      if (text) drafts[canvasId] = { text }
      else delete drafts[canvasId]
      set({ drafts })
    },
    status: null,
    agent: savedAgent(),
    approval: savedApproval(),
    plan: savedFlag(PLAN_KEY),
    access: savedAccess(),
    canvasId: null,
    sessions: [],
    cursor: null,
    session: null,
    unread: false,
    mood: 'idle',
    error: null,
    focusSeq: 0,

    ask() {
      const canvasId = get().canvasId
      if (canvasId) get().setExcludedSelection(canvasId)
      get().toggle(true)
      set({ focusSeq: get().focusSeq + 1 })
    },

    toggle(open) {
      const next = open ?? !get().open
      set({ open: next, ...(next ? { unread: false } : {}) })
      if (next && !get().status) void get().loadStatus()
    },

    async loadStatus(refresh = false) {
      try {
        const status = await api.agentStatus(refresh)
        set({ status })
        // 记住的智能体不可用时换成可用的那个（内置排在最前）
        const ok = status.agents.filter((a) => a.available)
        if (ok.length && !ok.some((a) => a.id === get().agent)) set({ agent: ok[0]!.id })
      } catch (err) {
        set({ error: (err as Error).message })
      }
    },

    setAgent(agent) {
      set({ agent })
      try {
        localStorage.setItem(AGENT_KEY, agent)
      } catch {}
    },

    setApproval(approval) {
      set({ approval })
      try {
        localStorage.setItem(APPROVAL_KEY, approval)
      } catch {}
    },

    setPlan(plan) {
      set({ plan })
      try {
        localStorage.setItem(PLAN_KEY, plan ? '1' : '0')
      } catch {}
    },

    setAccess(access) {
      set({ access })
      try {
        localStorage.setItem(ACCESS_KEY, access)
      } catch {}
    },

    async decide(approvalId, allow, pick) {
      if (get().pendingActions[`${get().session?.id}/revise/${approvalId}`]) return
      await sessionAction(`decide/${approvalId}`, (id) =>
        api.decideAgentApproval(id, approvalId, allow, pick),
      )
    },

    async revisePlan(approvalId, edits) {
      const id = get().session?.id
      if (!id) return '会话不存在'
      if (get().selecting || get().selectionError) return undefined
      const key = `${id}/revise/${approvalId}`
      if (get().pendingActions[key] || get().pendingActions[`${id}/decide/${approvalId}`])
        return '方案正在处理中'
      const mine = selectSeq
      set({ pendingActions: { ...get().pendingActions, [key]: true } })
      try {
        await api.reviseAgentEditPlan(id, approvalId, edits)
        return mine === selectSeq && get().session?.id === id ? null : undefined
      } catch (err) {
        return mine === selectSeq && get().session?.id === id ? (err as Error).message : undefined
      } finally {
        const pendingActions = { ...get().pendingActions }
        delete pendingActions[key]
        set({ pendingActions })
      }
    },

    async enter(canvasId, retry = false) {
      if (canvasId === get().canvasId && (!retry || get().loadingHistory)) return
      const mine = ++selectSeq
      connect(null)
      set({
        canvasId,
        sessions: [],
        session: null,
        selecting: null,
        error: null,
        mood: 'idle',
        loadingHistory: !!canvasId,
        historyError: null,
        selectionError: null,
      })
      if (!canvasId) return
      try {
        const fetched = await api.agentSessions(canvasId)
        if (mine !== selectSeq) return
        const sessions = fetched.filter((s) => !get().deletedSessions[s.id])
        set({ sessions, loadingHistory: false })
        if (sessions[0]) await get().select(sessions[0].id)
      } catch (err) {
        if (mine === selectSeq) set({ historyError: (err as Error).message })
      } finally {
        if (mine === selectSeq) set({ loadingHistory: false })
      }
    },

    async select(id) {
      if (get().selecting === id) return
      const mine = ++selectSeq
      const canvasId = get().canvasId
      set({ selecting: id, selectionError: null, error: null })
      try {
        const session = await api.agentSession(id)
        // 等应答期间换了画布或又点了别的会话
        if (mine !== selectSeq || get().canvasId !== canvasId) return
        set({ session, error: null, mood: session.status === 'running' ? 'working' : 'idle' })
        connect(id)
      } catch (err) {
        if (mine === selectSeq) set({ selectionError: { id, message: (err as Error).message } })
      } finally {
        if (mine === selectSeq) set({ selecting: null })
      }
    },

    cancelSelection() {
      selectSeq++
      set({ selecting: null, selectionError: null, error: null })
    },

    reset() {
      selectSeq++
      connect(null)
      set({
        session: null,
        selecting: null,
        error: null,
        mood: 'idle',
        loadingHistory: false,
        historyError: null,
        selectionError: null,
      })
    },

    async send(text, selection) {
      const { canvasId, agent } = get()
      if (
        !canvasId ||
        get().loadingHistory ||
        get().historyError ||
        get().selectionError ||
        get().connectionError ||
        get().reconnecting ||
        get().selecting ||
        get().sending[canvasId] ||
        get().session?.status === 'running'
      )
        return
      let mine = selectSeq
      const draft = get().drafts[canvasId]
      const options = { approval: get().approval, plan: get().plan, access: get().access }
      set({ error: null, sending: { ...get().sending, [canvasId]: true } })
      try {
        let session = get().session
        // 历史会话继续使用自己的智能体；显式切换智能体时界面会先重置会话。
        if (!session) {
          session = await api.createAgentSession(canvasId, agent)
          if (get().canvasId !== canvasId || mine !== selectSeq || get().agent !== agent) return
          mine = ++selectSeq
          set({ session })
          connect(session.id)
        }
        await api.sendAgentMessage(session.id, text, selection, options)
        if (draft && draft.text.trim() === text && get().drafts[canvasId] === draft)
          get().setDraft(canvasId, '')
        if (get().canvasId === canvasId && mine === selectSeq) void refreshList()
      } catch (err) {
        if (get().canvasId === canvasId && mine === selectSeq) {
          set({ error: (err as Error).message, mood: 'sad' })
          clearTimeout(moodTimer)
          moodTimer = setTimeout(() => set({ mood: 'idle' }), 4000)
        }
      } finally {
        const sending = { ...get().sending }
        delete sending[canvasId]
        set({ sending })
      }
    },

    async stop() {
      await sessionAction('stop', (id) => api.stopAgent(id))
    },

    async undoTurn(turn) {
      await sessionAction(`undo/${turn}`, (id) => api.undoAgentTurn(id, turn))
    },

    async remove(id) {
      if (get().removing[id]) return
      const canvasId = get().canvasId
      set({ removing: { ...get().removing, [id]: true } })
      try {
        await api.deleteAgentSession(id)
        set({ deletedSessions: { ...get().deletedSessions, [id]: true } })
        if (get().canvasId !== canvasId) return
        if (get().selectionError?.id === id) set({ selectionError: null })
        if (get().selecting === id) {
          selectSeq++
          set({ selecting: null })
        }
        if (get().session?.id === id) {
          if (get().selecting) {
            connect(null)
            set({ session: null, error: null, mood: 'idle' })
          } else get().reset()
        }
        set({ sessions: get().sessions.filter((s) => s.id !== id) })
      } catch (err) {
        if (get().canvasId === canvasId) set({ error: (err as Error).message })
      } finally {
        const removing = { ...get().removing }
        delete removing[id]
        set({ removing })
      }
    },
  }
})
